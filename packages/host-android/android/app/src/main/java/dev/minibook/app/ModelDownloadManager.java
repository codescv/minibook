package dev.minibook.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * CN-resilient on-device model downloader (`TTS_V2_SPEC.md` §3.3, §5.2):
 *   - `huggingface.co` <-> `hf-mirror.com` (+ custom mirror) fallback
 *   - Redirect host-suffix allow-list enforced by OkHttp network interceptor on every hop
 *   - HTTP 206 `Range` `.part` pause/resume, 200-ignored-Range & 416 recovery
 *   - Streaming SHA-256 verification (with 1 clean mirror-rotated retry)
 *   - Partial `WakeLock` + `WifiLock` while active; pure-Java testable with `MockWebServer`
 */
public final class ModelDownloadManager {
    public interface Listener {
        void onStatusChanged(JSONObject status);
    }

    public interface FreeSpaceChecker {
        long usableBytes(File dir);
    }

    public static final class FileSpec {
        public final String path;
        public final long size;
        public final String sha256;
        public final String repo;
        public final String revision;

        public FileSpec(String path, long size, String sha256, String repo, String revision) {
            this.path = path;
            this.size = size;
            this.sha256 = sha256;
            this.repo = repo;
            this.revision = revision;
        }
    }

    public static final class DownloadRequest {
        public final String id;
        public final String variant;
        public final List<FileSpec> files;
        public final List<String> sources;
        public final List<String> allowHosts;

        public DownloadRequest(
            String id,
            String variant,
            List<FileSpec> files,
            List<String> sources,
            List<String> allowHosts
        ) {
            this.id = id;
            this.variant = variant;
            this.files = files;
            this.sources = sources;
            this.allowHosts = allowHosts;
        }
    }

    private static final long FSYNC_INTERVAL_BYTES = 8L * 1024L * 1024L;
    private static final long DEFAULT_MIN_FREE_MARGIN_BYTES = 64L * 1024L * 1024L;
    private static final long PROGRESS_EMIT_INTERVAL_MS = 1_000L;
    private static final long[] DEFAULT_RETRY_DELAYS_MS = { 0L, 1_000L, 2_000L, 4_000L, 8_000L };
    private static final Pattern CONTENT_RANGE_RE =
        Pattern.compile("^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$", Pattern.CASE_INSENSITIVE);

    @Nullable private final Context appContext;
    private final KokoroModelStore store;
    private final Listener listener;
    @Nullable private final Runnable onBeforeRemove;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "minibook-model-dl");
        t.setDaemon(true);
        return t;
    });

    private final long[] retryDelaysMs;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;
    private final long minFreeMarginBytes;
    private final FreeSpaceChecker freeSpaceChecker;
    private final boolean allowInsecureHttpForTests;

    private final Object stateLock = new Object();
    private final Object emitLock = new Object();
    private final AtomicInteger generation = new AtomicInteger(0);
    private JSONObject currentStatus;
    @Nullable private Call activeCall;
    @Nullable private Thread activeWorkerThread;
    private List<String> activeSources = Collections.emptyList();
    @Nullable private String activeVariant = null;
    private volatile boolean activeDownloading = false;
    private volatile @Nullable String lastGoodSource = null;
    private long lastProgressEmitMs = 0L;
    @Nullable private String lastEmittedState = null;
    @Nullable private String lastEmittedSource = null;

    public ModelDownloadManager(
        @Nullable Context context,
        KokoroModelStore store,
        Listener listener,
        @Nullable Runnable onBeforeRemove
    ) {
        this(
            context,
            store,
            listener,
            onBeforeRemove,
            DEFAULT_RETRY_DELAYS_MS,
            8_000,
            20_000,
            DEFAULT_MIN_FREE_MARGIN_BYTES,
            File::getUsableSpace,
            false
        );
    }

    ModelDownloadManager(
        @Nullable Context context,
        KokoroModelStore store,
        Listener listener,
        @Nullable Runnable onBeforeRemove,
        long[] retryDelaysMs,
        int connectTimeoutMs,
        int readTimeoutMs,
        long minFreeMarginBytes,
        FreeSpaceChecker freeSpaceChecker,
        boolean allowInsecureHttpForTests
    ) {
        this.appContext = context != null ? context.getApplicationContext() : null;
        this.store = store;
        this.listener = listener;
        this.onBeforeRemove = onBeforeRemove;
        this.retryDelaysMs = retryDelaysMs;
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        this.minFreeMarginBytes = minFreeMarginBytes;
        this.freeSpaceChecker = freeSpaceChecker;
        this.allowInsecureHttpForTests = allowInsecureHttpForTests;
        this.currentStatus = store.buildReconciledStatus(null, 0.0, null);
    }

    public JSONObject getStatus(String id) {
        if (!KokoroModelStore.MODEL_ID.equals(id)) {
            throw new IllegalArgumentException("Unsupported speech model id: " + id);
        }
        synchronized (stateLock) {
            if (!activeDownloading) {
                // Keep reconciled status up-to-date if not actively transferring
                String curState = currentStatus.optString("state", "absent");
                if (!"error".equals(curState)
                    || !Objects.equals(currentStatus.optString("variant"), store.getDesiredVariant())) {
                    currentStatus = store.buildReconciledStatus(
                        currentStatus.has("backend") ? currentStatus.optString("backend") : null,
                        currentStatus.optDouble("rtf", 0.0),
                        null
                    );
                }
            }
            return cloneJson(currentStatus);
        }
    }

    public void updateRuntimeTelemetry(@Nullable String backend, double rtf, @Nullable JSONObject selfTestError) {
        synchronized (stateLock) {
            if (activeDownloading) return;
            currentStatus = store.buildReconciledStatus(backend, rtf, selfTestError);
            emitImmediate(currentStatus);
        }
    }

    private static List<String> normalizeSources(List<String> raw) {
        List<String> out = new ArrayList<>(raw.size());
        for (String s : raw) {
            if (s == null) continue;
            String trimmed = s.trim().replaceAll("/+$", "");
            if (!trimmed.isEmpty() && !out.contains(trimmed)) {
                out.add(trimmed);
            }
        }
        return out;
    }

    @Nullable
    private static String extractHost(@Nullable String baseUrl) {
        if (baseUrl == null || baseUrl.isEmpty()) return null;
        try {
            HttpUrl parsed = HttpUrl.parse(baseUrl);
            if (parsed != null && !parsed.host().isEmpty()) {
                return parsed.host();
            }
        } catch (Exception ignored) {}
        return null;
    }

    public JSONObject startDownload(DownloadRequest req) {
        if (!KokoroModelStore.MODEL_ID.equals(req.id)) {
            throw new IllegalArgumentException("Unsupported speech model id: " + req.id);
        }

        final List<String> normalizedSources = normalizeSources(req.sources);
        Call callToCancel = null;
        Thread prevWorker = null;
        boolean switchedSources = false;

        synchronized (stateLock) {
            if (activeDownloading) {
                if (normalizedSources.equals(activeSources) && Objects.equals(req.variant, activeVariant)) {
                    return cloneJson(currentStatus);
                }
                switchedSources = !normalizedSources.equals(activeSources);
                generation.incrementAndGet();
                activeDownloading = false;
                callToCancel = activeCall;
                activeCall = null;
                prevWorker = activeWorkerThread;
            } else if (!normalizedSources.equals(activeSources)) {
                switchedSources = true;
            }
        }

        if (callToCancel != null) {
            callToCancel.cancel();
        }
        if (prevWorker != null && prevWorker != Thread.currentThread()) {
            prevWorker.interrupt();
        }

        String good = lastGoodSource;
        if (good != null && (switchedSources || !normalizedSources.contains(good))) {
            lastGoodSource = null;
        }
        String preferredSource =
            (lastGoodSource != null && normalizedSources.contains(lastGoodSource))
                ? lastGoodSource
                : (normalizedSources.isEmpty() ? null : normalizedSources.get(0));
        String initialHost = extractHost(preferredSource);

        // Merge any already-installed files/voices from installed.json so adding extra voices preserves existing ones
        List<FileSpec> mergedFiles = mergeWithInstalledFiles(req);
        long bytesTotal = 0L;
        long bytesDone = 0L;
        long remaining = 0L;

        for (FileSpec f : mergedFiles) {
            bytesTotal += f.size;
            try {
                File finalFile = store.resolveInModelJail(KokoroModelStore.MODEL_ID, f.path);
                File partFile = new File(finalFile.getPath() + ".part");
                if (finalFile.exists() && finalFile.length() == f.size) {
                    bytesDone += f.size;
                } else if (partFile.exists() && partFile.length() <= f.size) {
                    long psz = partFile.length();
                    bytesDone += psz;
                    remaining += (f.size - psz);
                } else {
                    remaining += f.size;
                }
            } catch (IOException e) {
                throw new IllegalArgumentException(e.getMessage(), e);
            }
        }

        File modelRoot = store.getModelRoot(KokoroModelStore.MODEL_ID);
        if (!modelRoot.exists()) {
            //noinspection ResultOfMethodCallIgnored
            modelRoot.mkdirs();
        }
        long usable = freeSpaceChecker.usableBytes(modelRoot);
        if (usable >= 0L && usable < remaining + minFreeMarginBytes) {
            JSONObject errStatus = KokoroModelStore.buildStatusJson(
                "error",
                req.variant,
                bytesDone,
                bytesTotal,
                0L,
                new JSONArray(store.detectInstalledVoicesOnDisk()),
                initialHost,
                null,
                null,
                KokoroModelStore.makeErrorJson(
                    "storage-full",
                    "Not enough free storage for Kokoro voice model"
                )
            );
            synchronized (stateLock) {
                currentStatus = errStatus;
            }
            emitImmediate(errStatus);
            return cloneJson(errStatus);
        }

        final int myGen = generation.incrementAndGet();
        JSONObject initial = KokoroModelStore.buildStatusJson(
            "downloading",
            req.variant,
            bytesDone,
            bytesTotal,
            0L,
            new JSONArray(store.detectInstalledVoicesOnDisk()),
            initialHost,
            null,
            null,
            null
        );
        synchronized (stateLock) {
            activeDownloading = true;
            activeSources = Collections.unmodifiableList(new ArrayList<>(normalizedSources));
            activeVariant = req.variant;
            currentStatus = initial;
        }
        emitImmediate(initial);

        final DownloadRequest mergedReq = new DownloadRequest(
            req.id,
            req.variant,
            mergedFiles,
            normalizedSources,
            req.allowHosts
        );
        executor.execute(() -> runDownloadJob(myGen, mergedReq, initialHost));
        return cloneJson(initial);
    }

    public JSONObject pause(String id) {
        if (!KokoroModelStore.MODEL_ID.equals(id)) {
            throw new IllegalArgumentException("Unsupported speech model id: " + id);
        }
        generation.incrementAndGet();
        Call callToCancel;
        Thread prevWorker;
        synchronized (stateLock) {
            activeDownloading = false;
            activeSources = Collections.emptyList();
            callToCancel = activeCall;
            activeCall = null;
            prevWorker = activeWorkerThread;
        }
        if (callToCancel != null) {
            callToCancel.cancel();
        }
        if (prevWorker != null && prevWorker != Thread.currentThread()) {
            prevWorker.interrupt();
        }

        JSONObject reconciled = store.buildReconciledStatus(null, 0.0, null);
        if (!"ready".equals(reconciled.optString("state"))) {
            try {
                reconciled.put("state", "paused");
            } catch (Exception ignored) {}
        }
        synchronized (stateLock) {
            currentStatus = reconciled;
        }
        emitImmediate(reconciled);
        return cloneJson(reconciled);
    }

    public void remove(String id) {
        if (!KokoroModelStore.MODEL_ID.equals(id)) {
            throw new IllegalArgumentException("Unsupported speech model id: " + id);
        }
        generation.incrementAndGet();
        Call callToCancel;
        Thread prevWorker;
        synchronized (stateLock) {
            activeDownloading = false;
            activeSources = Collections.emptyList();
            lastGoodSource = null;
            callToCancel = activeCall;
            activeCall = null;
            prevWorker = activeWorkerThread;
        }
        if (callToCancel != null) {
            callToCancel.cancel();
        }
        if (prevWorker != null && prevWorker != Thread.currentThread()) {
            prevWorker.interrupt();
        }
        if (onBeforeRemove != null) {
            try {
                onBeforeRemove.run();
            } catch (Exception ignored) {}
        }
        AtomicFiles.deleteRecursively(store.getModelRoot(id));
        JSONObject absent = store.buildReconciledStatus(null, 0.0, null);
        synchronized (stateLock) {
            currentStatus = absent;
        }
        emitImmediate(absent);
    }

    public void shutdown() {
        generation.incrementAndGet();
        Call c;
        synchronized (stateLock) {
            activeDownloading = false;
            c = activeCall;
            activeCall = null;
        }
        if (c != null) c.cancel();
        executor.shutdownNow();
    }

    private List<FileSpec> mergeWithInstalledFiles(DownloadRequest req) {
        Map<String, FileSpec> byPath = new LinkedHashMap<>();
        for (FileSpec f : req.files) {
            byPath.put(f.path, f);
        }
        JSONObject existing = store.readRawInstalledMeta();
        if (existing != null) {
            String prevRepo = existing.optString("repo", "");
            String prevRev = existing.optString("revision", "");
            boolean sameVariant = req.variant.equals(existing.optString("variant", req.variant));
            JSONArray prevFiles = existing.optJSONArray("files");
            if (prevFiles != null) {
                for (int i = 0; i < prevFiles.length(); i++) {
                    JSONObject obj = prevFiles.optJSONObject(i);
                    if (obj == null) continue;
                    String p = obj.optString("path", "");
                    // Voice packs (`voices/*.bin`) are shared across `onnx-q8` and `onnx-fp32`!
                    if (!sameVariant && !p.startsWith("voices/")) continue;
                    if (byPath.containsKey(p)) continue;
                    long sz = obj.optLong("size", 0L);
                    String sha = obj.optString("sha256", "");
                    String r = obj.optString("repo", prevRepo);
                    String rev = obj.optString("revision", prevRev);
                    if (!p.isEmpty() && sz > 0L && !sha.isEmpty() && !r.isEmpty() && !rev.isEmpty()) {
                        byPath.put(p, new FileSpec(p, sz, sha, r, rev));
                    }
                }
            }
        }
        return new ArrayList<>(byPath.values());
    }

    private OkHttpClient buildHttpClient(final List<String> allowHosts) {
        return new OkHttpClient.Builder()
            .followRedirects(true)
            .followSslRedirects(true)
            .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
            .addNetworkInterceptor(chain -> {
                Request request = chain.request();
                HttpUrl url = request.url();
                if (!allowInsecureHttpForTests && !url.isHttps()) {
                    throw new IOException("Disallowed non-HTTPS model URL: " + url);
                }
                if (!isAllowedHost(url.host(), allowHosts)) {
                    throw new IOException("Disallowed model redirect host: " + url.host());
                }
                return chain.proceed(request);
            })
            .build();
    }

    public static boolean isAllowedHost(@Nullable String host, List<String> allowHosts) {
        if (host == null || host.isEmpty()) return false;
        String lower = host.toLowerCase(Locale.US);
        for (String rule : allowHosts) {
            if (rule == null || rule.isEmpty()) continue;
            String r = rule.toLowerCase(Locale.US);
            if (r.startsWith("*.")) {
                String suffix = r.substring(1); // ".hf.co"
                if (lower.endsWith(suffix) && lower.length() > suffix.length()) return true;
            } else if (r.startsWith(".")) {
                if (lower.endsWith(r) && lower.length() > r.length()) return true;
            } else if (lower.equals(r)) {
                return true;
            }
        }
        return false;
    }

    private void runDownloadJob(int myGen, DownloadRequest req, @Nullable String initialHost) {
        synchronized (stateLock) {
            if (generation.get() != myGen) return;
            activeWorkerThread = Thread.currentThread();
        }
        PowerManager.WakeLock wakeLock = null;
        WifiManager.WifiLock wifiLock = null;
        if (appContext != null) {
            try {
                PowerManager pm = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MiniBook:ModelDownload");
                    wakeLock.setReferenceCounted(false);
                    wakeLock.acquire(30 * 60 * 1000L);
                }
                WifiManager wm = (WifiManager) appContext.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MiniBook:ModelDownload");
                    wifiLock.setReferenceCounted(false);
                    wifiLock.acquire();
                }
            } catch (Exception ignored) {}
        }

        try {
            OkHttpClient client = buildHttpClient(req.allowHosts);
            long totalBytes = 0L;
            final Map<String, Long> bytesByPath = new LinkedHashMap<>();
            for (FileSpec f : req.files) {
                totalBytes += f.size;
                File finalFile = store.resolveInModelJail(req.id, f.path);
                File partFile = new File(finalFile.getPath() + ".part");
                if (finalFile.exists() && finalFile.length() == f.size) {
                    bytesByPath.put(f.path, f.size);
                } else if (partFile.exists() && partFile.length() <= f.size) {
                    bytesByPath.put(f.path, partFile.length());
                } else {
                    bytesByPath.put(f.path, 0L);
                }
            }

            final String[] lastSourceHost = { initialHost };

            for (FileSpec f : req.files) {
                if (generation.get() != myGen) return;

                File finalFile = store.resolveInModelJail(req.id, f.path);
                File partFile = new File(finalFile.getPath() + ".part");
                File parent = finalFile.getParentFile();
                if (parent != null && !parent.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }

                if (finalFile.exists() && finalFile.length() == f.size) {
                    bytesByPath.put(f.path, f.size);
                    continue;
                }

                boolean integrityRetried = false;
                int startSrcOffset = 0;
                String good = lastGoodSource;
                if (good != null) {
                    int idx = req.sources.indexOf(good);
                    if (idx >= 0) {
                        startSrcOffset = idx;
                    } else {
                        lastGoodSource = null;
                    }
                }

                while (true) {
                    if (generation.get() != myGen) return;

                    long offset = 0L;
                    if (partFile.exists()) {
                        long psz = partFile.length();
                        if (psz > f.size) {
                            //noinspection ResultOfMethodCallIgnored
                            partFile.delete();
                        } else {
                            offset = psz;
                        }
                    }

                    for (int round = 0; round < retryDelaysMs.length && offset < f.size; round++) {
                        if (generation.get() != myGen) return;
                        if (round > 0 && retryDelaysMs[round] > 0L) {
                            Thread.sleep(retryDelaysMs[round]);
                        }
                        for (int i = 0; i < req.sources.size() && offset < f.size; i++) {
                            if (generation.get() != myGen) return;
                            int srcIdx = (startSrcOffset + i) % req.sources.size();
                            String base = req.sources.get(srcIdx).replaceAll("/+$", "");
                            String url = base + "/" + f.repo + "/resolve/" + f.revision + "/" + f.path;
                            String host = extractHost(base);
                            if (host != null) lastSourceHost[0] = host;

                            long finalTotalBytes = totalBytes;
                            ByteProgressCallback progressCb = fileBytes -> {
                                if (generation.get() != myGen) return;
                                bytesByPath.put(f.path, fileBytes);
                                long doneSum = 0L;
                                for (long v : bytesByPath.values()) doneSum += v;
                                JSONObject st = KokoroModelStore.buildStatusJson(
                                    "downloading",
                                    req.variant,
                                    Math.min(doneSum, finalTotalBytes),
                                    finalTotalBytes,
                                    0L,
                                    new JSONArray(store.detectInstalledVoicesOnDisk()),
                                    lastSourceHost[0],
                                    null,
                                    null,
                                    null
                                );
                                synchronized (stateLock) {
                                    if (generation.get() != myGen) return;
                                    currentStatus = st;
                                }
                                emitThrottled(st);
                            };
                            progressCb.onProgress(offset);
                            offset = downloadSingleSource(
                                client,
                                url,
                                partFile,
                                offset,
                                f.size,
                                myGen,
                                progressCb
                            );
                            if (generation.get() != myGen) return;
                            if (offset == f.size) {
                                lastGoodSource = base;
                                break;
                            }
                        }
                    }

                    if (generation.get() != myGen) return;

                    if (offset != f.size) {
                        long doneSum = 0L;
                        for (long v : bytesByPath.values()) doneSum += v;
                        setError(
                            req.variant,
                            doneSum,
                            totalBytes,
                            lastSourceHost[0],
                            "network",
                            "Failed to download " + f.path + " (" + offset + "/" + f.size + " bytes)"
                        );
                        return;
                    }

                    long doneSum = 0L;
                    for (long v : bytesByPath.values()) doneSum += v;

                    String sha = computeSha256(partFile);
                    if (generation.get() != myGen) return;
                    if (sha.equalsIgnoreCase(f.sha256)) {
                        AtomicFiles.moveAtomically(partFile, finalFile);
                        bytesByPath.put(f.path, f.size);
                        long updatedSum = 0L;
                        for (long v : bytesByPath.values()) updatedSum += v;
                        JSONObject dlStatus = KokoroModelStore.buildStatusJson(
                            "downloading",
                            req.variant,
                            Math.min(updatedSum, totalBytes),
                            totalBytes,
                            0L,
                            new JSONArray(store.detectInstalledVoicesOnDisk()),
                            lastSourceHost[0],
                            null,
                            null,
                            null
                        );
                        synchronized (stateLock) {
                            if (generation.get() != myGen) return;
                            currentStatus = dlStatus;
                        }
                        emitThrottled(dlStatus);
                        break;
                    }

                    // Integrity mismatch
                    //noinspection ResultOfMethodCallIgnored
                    partFile.delete();
                    bytesByPath.put(f.path, 0L);
                    if (!integrityRetried) {
                        integrityRetried = true;
                        lastGoodSource = null;
                        if (req.sources.size() > 1) {
                            startSrcOffset = (startSrcOffset + 1) % req.sources.size();
                        }
                        continue;
                    }

                    setError(
                        req.variant,
                        doneSum,
                        totalBytes,
                        lastSourceHost[0],
                        "model-integrity",
                        "SHA-256 mismatch for " + f.path
                    );
                    return;
                }
            }

            if (generation.get() != myGen) return;

            // Emit verifying at most ONCE after all files in the plan have finished downloading.
            JSONObject verifying = KokoroModelStore.buildStatusJson(
                "verifying",
                req.variant,
                totalBytes,
                totalBytes,
                0L,
                new JSONArray(store.detectInstalledVoicesOnDisk()),
                lastSourceHost[0],
                null,
                null,
                null
            );
            synchronized (stateLock) {
                currentStatus = verifying;
            }
            emitImmediate(verifying);

            // Write installed.json atomically (preserving multi-variant `variants` & `selfTests` maps)
            JSONObject prevMeta = store.readRawInstalledMeta();
            String prevVariant = prevMeta != null ? prevMeta.optString("variant", "") : "";
            Set<String> voices = new LinkedHashSet<>(store.detectInstalledVoicesOnDisk());
            JSONArray filesJson = new JSONArray();
            JSONObject onnxVariantSpec = null;
            for (FileSpec f : req.files) {
                JSONObject fj = new JSONObject();
                fj.put("path", f.path);
                fj.put("size", f.size);
                fj.put("sha256", f.sha256);
                fj.put("repo", f.repo);
                fj.put("revision", f.revision);
                filesJson.put(fj);
                if (f.path.startsWith("onnx/")) {
                    onnxVariantSpec = new JSONObject(fj.toString());
                }
            }
            JSONObject variantsMap = (prevMeta != null && prevMeta.optJSONObject("variants") != null)
                ? new JSONObject(prevMeta.optJSONObject("variants").toString())
                : new JSONObject();
            if (prevMeta != null && !prevVariant.isEmpty() && !variantsMap.has(prevVariant)) {
                JSONArray oldFiles = prevMeta.optJSONArray("files");
                if (oldFiles != null) {
                    for (int i = 0; i < oldFiles.length(); i++) {
                        JSONObject of = oldFiles.optJSONObject(i);
                        if (of != null && of.optString("path", "").startsWith("onnx/")) {
                            variantsMap.put(prevVariant, new JSONObject(of.toString()));
                            break;
                        }
                    }
                }
            }
            if (onnxVariantSpec != null) {
                variantsMap.put(req.variant, onnxVariantSpec);
            }

            JSONObject meta = new JSONObject();
            meta.put("revision", req.files.isEmpty() ? "" : req.files.get(0).revision);
            meta.put("repo", req.files.isEmpty() ? "" : req.files.get(0).repo);
            meta.put("variant", req.variant);
            meta.put("files", filesJson);
            meta.put("variants", variantsMap);
            if (prevMeta != null && prevMeta.optJSONObject("selfTests") != null) {
                meta.put("selfTests", new JSONObject(prevMeta.optJSONObject("selfTests").toString()));
            }
            meta.put("voices", new JSONArray(voices));
            meta.put("installedAt", System.currentTimeMillis());
            if (lastSourceHost[0] != null) {
                meta.put("source", lastSourceHost[0]);
            }
            store.writeInstalledMeta(meta);
            if (!prevVariant.isEmpty() && !prevVariant.equals(req.variant) && onBeforeRemove != null) {
                try {
                    onBeforeRemove.run();
                } catch (Exception ignored) {}
            }

            JSONObject ready = KokoroModelStore.buildStatusJson(
                "ready",
                req.variant,
                totalBytes,
                totalBytes,
                totalBytes,
                new JSONArray(voices),
                lastSourceHost[0],
                null,
                null,
                null
            );
            synchronized (stateLock) {
                if (generation.get() != myGen) return;
                activeDownloading = false;
                activeSources = Collections.emptyList();
                currentStatus = ready;
            }
            emitImmediate(ready);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            if (generation.get() != myGen) return;
            JSONObject st = getStatus(req.id);
            setError(
                req.variant,
                st.optLong("bytesDone", 0L),
                st.optLong("bytesTotal", 0L),
                st.has("source") ? st.optString("source") : null,
                "network",
                e.getMessage() != null ? e.getMessage() : "Model download failed"
            );
        } finally {
            Thread.interrupted();
            synchronized (stateLock) {
                if (activeWorkerThread == Thread.currentThread()) {
                    activeWorkerThread = null;
                }
                if (generation.get() == myGen) {
                    activeDownloading = false;
                    activeCall = null;
                    activeSources = Collections.emptyList();
                }
            }
            if (wifiLock != null && wifiLock.isHeld()) {
                try { wifiLock.release(); } catch (Exception ignored) {}
            }
            if (wakeLock != null && wakeLock.isHeld()) {
                try { wakeLock.release(); } catch (Exception ignored) {}
            }
        }
    }

    private interface ByteProgressCallback {
        void onProgress(long fileBytes);
    }

    private long downloadSingleSource(
        OkHttpClient client,
        String url,
        File partFile,
        long initialOffset,
        long expectedSize,
        int myGen,
        ByteProgressCallback progressCb
    ) {
        long offset = initialOffset;
        boolean retried416 = false;

        while (true) {
            if (generation.get() != myGen) return offset;
            Request.Builder rb = new Request.Builder()
                .url(url)
                .header("Accept-Encoding", "identity")
                .header("User-Agent", "MiniBook/0.2.5");
            if (offset > 0L) {
                rb.header("Range", "bytes=" + offset + "-");
            }

            Call call = client.newCall(rb.build());
            synchronized (stateLock) {
                if (generation.get() != myGen) {
                    call.cancel();
                    return offset;
                }
                activeCall = call;
            }

            try (Response resp = call.execute()) {
                int code = resp.code();
                if (code == 416) {
                    if (partFile.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        partFile.delete();
                    }
                    offset = 0L;
                    progressCb.onProgress(0L);
                    if (!retried416) {
                        retried416 = true;
                        continue;
                    }
                    return 0L;
                }

                boolean append = false;
                if (code == 206) {
                    String cr = resp.header("Content-Range");
                    if (!isValidContentRange(cr, offset, expectedSize)) {
                        return offset;
                    }
                    append = offset > 0L;
                } else if (code == 200) {
                    if (offset > 0L) {
                        offset = 0L;
                        progressCb.onProgress(0L);
                    }
                    append = false;
                } else {
                    return offset;
                }

                ResponseBody body = resp.body();
                if (body == null) return offset;

                try (InputStream in = body.byteStream();
                     FileOutputStream fos = new FileOutputStream(partFile, append)) {
                    byte[] buf = new byte[16 * 1024];
                    long bytesSinceSync = 0L;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (generation.get() != myGen) return offset;
                        fos.write(buf, 0, n);
                        offset += n;
                        bytesSinceSync += n;
                        if (bytesSinceSync >= FSYNC_INTERVAL_BYTES) {
                            fos.flush();
                            fos.getFD().sync();
                            bytesSinceSync = 0L;
                        }
                        progressCb.onProgress(offset);
                    }
                    fos.flush();
                    fos.getFD().sync();
                }
                return offset;
            } catch (IOException e) {
                return offset;
            } finally {
                synchronized (stateLock) {
                    if (activeCall == call) activeCall = null;
                }
            }
        }
    }

    static boolean isValidContentRange(@Nullable String header, long expectedStart, long expectedTotal) {
        if (header == null) return false;
        Matcher m = CONTENT_RANGE_RE.matcher(header.trim());
        if (!m.matches()) return false;
        try {
            long start = Long.parseLong(m.group(1));
            long end = Long.parseLong(m.group(2));
            String totalStr = m.group(3);
            if (start != expectedStart || end < start) return false;
            if (!"*".equals(totalStr)) {
                long total = Long.parseLong(totalStr);
                if (total != expectedTotal) return false;
            }
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static String computeSha256(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = fis.read(buf)) != -1) {
                md.update(buf, 0, n);
            }
        }
        byte[] digest = md.digest();
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(String.format(Locale.US, "%02x", b & 0xff));
        }
        return sb.toString();
    }

    private void setError(
        String variant,
        long bytesDone,
        long bytesTotal,
        @Nullable String source,
        String code,
        String message
    ) {
        JSONObject err = KokoroModelStore.buildStatusJson(
            "error",
            variant,
            bytesDone,
            bytesTotal,
            0L,
            new JSONArray(store.detectInstalledVoicesOnDisk()),
            source,
            null,
            null,
            KokoroModelStore.makeErrorJson(code, message)
        );
        synchronized (stateLock) {
            activeDownloading = false;
            currentStatus = err;
        }
        emitImmediate(err);
    }

    private void recordEmittedLocked(JSONObject status) {
        lastProgressEmitMs = System.currentTimeMillis();
        lastEmittedState = status.optString("state", "");
        lastEmittedSource = status.has("source") && !status.isNull("source")
            ? status.optString("source", null)
            : null;
    }

    private void emitImmediate(JSONObject status) {
        synchronized (emitLock) {
            recordEmittedLocked(status);
        }
        listener.onStatusChanged(cloneJson(status));
    }

    private void emitThrottled(JSONObject status) {
        boolean shouldEmit;
        String state = status.optString("state", "");
        String source = status.has("source") && !status.isNull("source")
            ? status.optString("source", null)
            : null;
        synchronized (emitLock) {
            long now = System.currentTimeMillis();
            boolean stateChanged = !Objects.equals(state, lastEmittedState);
            boolean sourceChanged = !Objects.equals(source, lastEmittedSource);
            shouldEmit = stateChanged || sourceChanged || (now - lastProgressEmitMs >= PROGRESS_EMIT_INTERVAL_MS);
            if (shouldEmit) {
                recordEmittedLocked(status);
            }
        }
        if (shouldEmit) {
            listener.onStatusChanged(cloneJson(status));
        }
    }

    private static JSONObject cloneJson(JSONObject obj) {
        try {
            return new JSONObject(obj.toString());
        } catch (Exception e) {
            return obj;
        }
    }
}
