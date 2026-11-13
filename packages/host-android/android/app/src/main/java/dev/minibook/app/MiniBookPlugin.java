package dev.minibook.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Capacitor native bridge `@CapacitorPlugin(name = "MiniBook")` (`ARCHITECTURE.md` §3.2, §3.3, §8, §9, §10).
 *
 * Implements the exact flat method table & event payload keys declared in
 * `packages/host-android/src/plugin-types.ts`.
 */
@CapacitorPlugin(name = "MiniBook")
public class MiniBookPlugin extends Plugin {
    private static final String SECRETS_PREFS = "minibook_secrets";
    private static final int MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024;
    private static final long MAX_SPEECH_CACHE_BYTES = 200L * 1024L * 1024L;
    private static final Pattern SECRET_PATTERN = Pattern.compile("\\{\\{secret:([a-zA-Z0-9._-]{1,64})\\}\\}");
    private static final Pattern SAFE_BOOK_ID = Pattern.compile("^[a-zA-Z0-9_-]{2,80}$");
    private static final Pattern SAFE_EXT = Pattern.compile("^[a-z0-9.]{1,16}$");
    private static final Pattern SAFE_CACHE_KEY = Pattern.compile("^[a-fA-F0-9]{16,64}$");

    private static final ExecutorService STATIC_IO = Executors.newCachedThreadPool();
    private static final List<JSONObject> PENDING_INCOMING_FILES = new ArrayList<>();
    @Nullable private static volatile MiniBookPlugin activeInstance;

    private final ExecutorService ioPool = Executors.newCachedThreadPool();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ConcurrentHashMap<String, WebSocket> sockets = new ConcurrentHashMap<>();

    private final OkHttpClient okHttp = new OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build();

    private final ReadAloudService.PluginEventSink speechSink = (eventName, payload) -> {
        JSObject jsObj = toJSObject(payload);
        notifyListeners(eventName, jsObj);
    };

    @Override
    public void load() {
        super.load();
        activeInstance = this;
        ReadAloudService.addEventSink(speechSink);
    }

    @Override
    protected void handleOnDestroy() {
        ReadAloudService.removeEventSink(speechSink);
        for (WebSocket ws : sockets.values()) {
            try {
                ws.close(1000, "destroy");
            } catch (Exception ignored) {}
        }
        sockets.clear();
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    public void emitHardwareKey(String keyName) {
        JSObject payload = new JSObject();
        payload.put("key", keyName);
        notifyListeners("hardware-key", payload);
    }

    @Nullable
    public static MiniBookPlugin peekActiveInstance() {
        return activeInstance;
    }

    // -------------------------------------------------------------------------
    // Incoming `ACTION_VIEW` / `ACTION_SEND` book intents (`MainActivity`)
    // -------------------------------------------------------------------------

    public static void handleIncomingIntent(Context context, @Nullable Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action)) {
            if (intent.getData() != null) {
                uris.add(intent.getData());
            }
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) {
                uris.add(stream);
            } else if (intent.getClipData() != null) {
                ClipData clip = intent.getClipData();
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            }
        }
        if (uris.isEmpty()) return;

        final Context appCtx = context.getApplicationContext();
        STATIC_IO.execute(() -> {
            File dataRoot = new File(appCtx.getFilesDir(), "MiniBookData");
            List<JSONObject> copied = new ArrayList<>();
            for (Uri uri : uris) {
                try {
                    JSONObject item = copyContentUriToTmp(appCtx, dataRoot, uri, "incoming");
                    if (item != null) copied.add(item);
                } catch (Exception ignored) {}
            }
            if (copied.isEmpty()) return;

            MiniBookPlugin live = activeInstance;
            if (live != null && live.hasListeners("incoming-file")) {
                JSObject ev = new JSObject();
                JSArray arr = new JSArray();
                for (JSONObject f : copied) {
                    arr.put(toJSObject(f));
                }
                ev.put("files", arr);
                live.notifyListeners("incoming-file", ev, false);
            } else {
                // Queue exclusively in PENDING_INCOMING_FILES (drained once by importConsumePending)
                // without retained notifyListeners so cold-launch Open-With never imports twice.
                synchronized (PENDING_INCOMING_FILES) {
                    PENDING_INCOMING_FILES.addAll(copied);
                }
            }
        });
    }

    // -------------------------------------------------------------------------
    // §1. Filesystem (`fs*`) — bounded `RandomAccessFile` + atomic persistence
    // -------------------------------------------------------------------------

    private File getMiniBookDataRoot() {
        return new File(getContext().getFilesDir(), "MiniBookData");
    }

    @PluginMethod
    public void fsRead(PluginCall call) {
        final String path = call.getString("path");
        final long offset = safeLong(call, "offset", 0L);
        final int length = safeInt(call, "length", -1);

        ioPool.execute(() -> {
            try {
                AtomicFiles.BoundedReadResult result = AtomicFiles.readBounded(
                    getMiniBookDataRoot(),
                    path,
                    offset,
                    length
                );
                JSObject out = new JSObject();
                out.put("base64", Base64.encodeToString(result.bytes, Base64.NO_WRAP));
                out.put("bytesRead", result.bytesRead);
                call.resolve(out);
            } catch (FileNotFoundException e) {
                call.reject(e.getMessage(), "not-found", e);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsRead failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void fsWriteAtomic(PluginCall call) {
        final String path = call.getString("path");
        final String text = call.getString("text");
        final String base64 = call.getString("base64");
        if ((text == null && base64 == null) || (text != null && base64 != null)) {
            call.reject("Exactly one of text or base64 must be provided", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            try {
                byte[] bytes = text != null
                    ? text.getBytes(StandardCharsets.UTF_8)
                    : Base64.decode(base64, Base64.DEFAULT);
                AtomicFiles.writeAtomic(getMiniBookDataRoot(), path, bytes);
                call.resolve(new JSObject());
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsWriteAtomic failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void fsAppend(PluginCall call) {
        final String path = call.getString("path");
        final String base64 = call.getString("base64");
        if (base64 == null) {
            call.reject("base64 is required", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                AtomicFiles.append(getMiniBookDataRoot(), path, bytes);
                call.resolve(new JSObject());
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsAppend failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void fsList(PluginCall call) {
        final String path = call.getString("path", "");
        ioPool.execute(() -> {
            try {
                List<AtomicFiles.Entry> entries = AtomicFiles.list(getMiniBookDataRoot(), path);
                JSArray arr = new JSArray();
                for (AtomicFiles.Entry e : entries) {
                    JSObject item = new JSObject();
                    item.put("name", e.name);
                    item.put("path", e.path);
                    item.put("size", e.size);
                    item.put("mtimeMs", e.mtimeMs);
                    item.put("isDirectory", e.isDirectory);
                    arr.put(item);
                }
                JSObject res = new JSObject();
                res.put("entries", arr);
                call.resolve(res);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsList failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void fsRemove(PluginCall call) {
        final String path = call.getString("path");
        ioPool.execute(() -> {
            try {
                AtomicFiles.remove(getMiniBookDataRoot(), path);
                call.resolve(new JSObject());
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsRemove failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void fsStat(PluginCall call) {
        final String path = call.getString("path", "");
        ioPool.execute(() -> {
            try {
                AtomicFiles.Stat st = AtomicFiles.stat(getMiniBookDataRoot(), path);
                JSObject res = new JSObject();
                res.put("exists", st.exists);
                if (st.exists) {
                    res.put("size", st.size);
                    res.put("mtimeMs", st.mtimeMs);
                    res.put("isDirectory", st.isDirectory);
                }
                call.resolve(res);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsStat failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void fsFileUrl(PluginCall call) {
        final String path = call.getString("path");
        ioPool.execute(() -> {
            try {
                File target = AtomicFiles.resolveInJail(getMiniBookDataRoot(), path, false);
                String localBase = getBridge() != null ? getBridge().getLocalUrl() : "https://localhost";
                String abs = target.getAbsolutePath();
                String url = localBase + "/_capacitor_file_" + (abs.startsWith("/") ? abs : "/" + abs);
                JSObject res = new JSObject();
                res.put("url", url);
                call.resolve(res);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("fsFileUrl failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    // -------------------------------------------------------------------------
    // §2. Import (`import*`) — SAF copy-on-import & adopt
    // -------------------------------------------------------------------------

    @PluginMethod
    public void importPick(PluginCall call) {
        boolean multiple = Boolean.TRUE.equals(call.getBoolean("multiple", true));
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "onBookPickResult");
    }

    @ActivityCallback
    private void onBookPickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            JSObject empty = new JSObject();
            empty.put("files", new JSArray());
            call.resolve(empty);
            return;
        }

        final List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        if (uris.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("files", new JSArray());
            call.resolve(empty);
            return;
        }

        final Context ctx = getContext();
        final File dataRoot = getMiniBookDataRoot();
        ioPool.execute(() -> {
            JSArray filesArr = new JSArray();
            for (Uri uri : uris) {
                try {
                    JSONObject copied = copyContentUriToTmp(ctx, dataRoot, uri, "pick");
                    if (copied != null) {
                        filesArr.put(toJSObject(copied));
                    }
                } catch (Exception ignored) {}
            }
            JSObject out = new JSObject();
            out.put("files", filesArr);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void importAdopt(PluginCall call) {
        final String tempPath = call.getString("tempPath");
        final String bookId = call.getString("bookId");
        final String ext = call.getString("ext");

        if (tempPath == null || bookId == null || ext == null
            || !SAFE_BOOK_ID.matcher(bookId).matches()
            || !SAFE_EXT.matcher(ext).matches()
            || ext.contains("..")) {
            call.reject("Invalid tempPath, bookId, or ext", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            try {
                File root = getMiniBookDataRoot();
                File src = AtomicFiles.resolveInJail(root, tempPath, false);
                if (!src.exists() || !src.isFile()) {
                    call.reject("Staged file not found: " + tempPath, "not-found");
                    return;
                }
                String adoptedRel = "books/" + bookId + "/book." + ext;
                File dst = AtomicFiles.resolveInJail(root, adoptedRel, false);
                AtomicFiles.moveAtomically(src, dst);

                JSObject out = new JSObject();
                out.put("path", adoptedRel);
                out.put("size", dst.length());
                call.resolve(out);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid-argument", e);
            } catch (IOException e) {
                call.reject("importAdopt failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void importConsumePending(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (PENDING_INCOMING_FILES) {
            for (JSONObject f : PENDING_INCOMING_FILES) {
                arr.put(toJSObject(f));
            }
            PENDING_INCOMING_FILES.clear();
        }
        JSObject res = new JSObject();
        res.put("files", arr);
        call.resolve(res);
    }

    @Nullable
    private static JSONObject copyContentUriToTmp(
        Context context,
        File dataRoot,
        Uri uri,
        String prefix
    ) throws IOException {
        String displayName = resolveDisplayName(context, uri);
        String safeName = sanitizeFileName(displayName);
        String relTmp = "tmp/" + prefix + "_" + UUID.randomUUID().toString().replace("-", "") + "_" + safeName;
        File dst = AtomicFiles.resolveInJail(dataRoot, relTmp, false);
        File parent = dst.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Cannot create tmp directory");
        }

        long total = 0L;
        try (InputStream in = context.getContentResolver().openInputStream(uri);
             FileOutputStream fos = new FileOutputStream(dst)) {
            if (in == null) return null;
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                fos.write(buf, 0, n);
            }
            fos.flush();
            fos.getFD().sync();
        }

        JSONObject obj = new JSONObject();
        try {
            obj.put("tempPath", relTmp);
            obj.put("name", displayName);
            obj.put("size", total);
        } catch (JSONException ignored) {}
        return obj;
    }

    private static String resolveDisplayName(Context context, Uri uri) {
        if ("content".equalsIgnoreCase(uri.getScheme())) {
            try (Cursor cursor = context.getContentResolver().query(
                uri,
                new String[] { OpenableColumns.DISPLAY_NAME },
                null,
                null,
                null
            )) {
                if (cursor != null && cursor.moveToFirst()) {
                    int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0 && !cursor.isNull(idx)) {
                        String name = cursor.getString(idx);
                        if (name != null && !name.trim().isEmpty()) {
                            return name.trim();
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        String last = uri.getLastPathSegment();
        return (last != null && !last.trim().isEmpty()) ? last.trim() : "book.epub";
    }

    private static String sanitizeFileName(String raw) {
        String cleaned = raw.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (cleaned.length() > 80) {
            cleaned = cleaned.substring(cleaned.length() - 80);
        }
        return cleaned.isEmpty() ? "book.epub" : cleaned;
    }

    // -------------------------------------------------------------------------
    // §3. Network (`httpRequest`, `socketOpen`, `socketSend`, `socketClose`)
    // -------------------------------------------------------------------------

    @PluginMethod
    public void httpRequest(PluginCall call) {
        final String rawUrl = call.getString("url");
        final String method = call.getString("method", "GET").toUpperCase(Locale.US);
        final JSObject rawHeaders = call.getObject("headers");
        final String bodyBase64 = call.getString("bodyBase64");
        final int timeoutMs = Math.max(1_000, safeInt(call, "timeoutMs", 30_000));

        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("Missing url", "invalid-argument");
            return;
        }
        HttpUrl parsedUrl = HttpUrl.parse(rawUrl.trim());
        if (parsedUrl == null) {
            call.reject("Malformed HTTP URL: " + rawUrl, "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            try {
                Map<String, String> headers = substituteSecretHeaders(
                    jsonObjectToMap(rawHeaders),
                    parsedUrl
                );
                OkHttpClient client = okHttp.newBuilder()
                    .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build();

                Request.Builder rb = new Request.Builder().url(parsedUrl);
                for (Map.Entry<String, String> entry : headers.entrySet()) {
                    rb.header(entry.getKey(), entry.getValue());
                }

                RequestBody okBody = null;
                if (!"GET".equals(method) && !"HEAD".equals(method)) {
                    byte[] payload = bodyBase64 != null && !bodyBase64.isEmpty()
                        ? Base64.decode(bodyBase64, Base64.DEFAULT)
                        : new byte[0];
                    String ct = findHeaderIgnoreCase(headers, "Content-Type");
                    MediaType mt = ct != null ? MediaType.parse(ct) : null;
                    okBody = RequestBody.create(payload, mt);
                }
                rb.method(method, okBody);

                try (Response resp = client.newCall(rb.build()).execute()) {
                    byte[] respBytes = readBoundedHttpBody(resp.body(), MAX_HTTP_BODY_BYTES);
                    Headers respHeaders = resp.headers();
                    JSObject headersObj = new JSObject();
                    for (int i = 0; i < respHeaders.size(); i++) {
                        headersObj.put(
                            respHeaders.name(i).toLowerCase(Locale.US),
                            respHeaders.value(i)
                        );
                    }

                    JSObject out = new JSObject();
                    out.put("status", resp.code());
                    out.put("headers", headersObj);
                    out.put("bodyBase64", Base64.encodeToString(respBytes, Base64.NO_WRAP));
                    call.resolve(out);
                }
            } catch (MissingSecretException e) {
                call.reject(e.getMessage(), "speech-auth", e);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "too-large", e);
            } catch (Exception e) {
                call.reject(
                    e.getMessage() != null ? e.getMessage() : "HTTP request failed",
                    "network",
                    e
                );
            }
        });
    }

    private static byte[] readBoundedHttpBody(@Nullable ResponseBody body, int maxBytes) throws IOException {
        if (body == null) return new byte[0];
        long declared = body.contentLength();
        if (declared > maxBytes) {
            throw new IllegalArgumentException("HTTP body exceeds " + maxBytes + " bytes");
        }
        try (InputStream in = body.byteStream();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > maxBytes) {
                    throw new IllegalArgumentException("HTTP body exceeds " + maxBytes + " bytes");
                }
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }

    @PluginMethod
    public void socketOpen(PluginCall call) {
        final String id = call.getString("id");
        final String rawUrl = call.getString("url");
        final JSObject rawHeaders = call.getObject("headers");
        final int timeoutMs = Math.max(1_000, safeInt(call, "timeoutMs", 20_000));

        if (id == null || id.isEmpty() || rawUrl == null || rawUrl.isEmpty()) {
            call.reject("id and url are required", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            try {
                String httpEquiv = rawUrl
                    .replaceFirst("(?i)^wss://", "https://")
                    .replaceFirst("(?i)^ws://", "http://");
                HttpUrl parsed = HttpUrl.parse(httpEquiv);
                if (parsed == null) {
                    call.reject("Invalid WebSocket URL: " + rawUrl, "invalid-argument");
                    return;
                }
                Map<String, String> headers = substituteSecretHeaders(
                    jsonObjectToMap(rawHeaders),
                    parsed
                );

                Request.Builder rb = new Request.Builder().url(rawUrl);
                for (Map.Entry<String, String> entry : headers.entrySet()) {
                    rb.header(entry.getKey(), entry.getValue());
                }

                OkHttpClient wsClient = okHttp.newBuilder()
                    .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .build();

                WebSocket prev = sockets.remove(id);
                if (prev != null) {
                    prev.close(1000, "replaced");
                }

                WebSocket ws = wsClient.newWebSocket(rb.build(), new WebSocketListener() {
                    @Override
                    public void onOpen(WebSocket webSocket, Response response) {
                        JSObject ev = new JSObject();
                        ev.put("id", id);
                        notifyListeners("socket-open", ev);
                    }

                    @Override
                    public void onMessage(WebSocket webSocket, String text) {
                        JSObject ev = new JSObject();
                        ev.put("id", id);
                        ev.put("text", text);
                        notifyListeners("socket-message", ev);
                    }

                    @Override
                    public void onMessage(WebSocket webSocket, ByteString bytes) {
                        JSObject ev = new JSObject();
                        ev.put("id", id);
                        ev.put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                        notifyListeners("socket-message", ev);
                    }

                    @Override
                    public void onClosing(WebSocket webSocket, int code, String reason) {
                        webSocket.close(code, reason);
                    }

                    @Override
                    public void onClosed(WebSocket webSocket, int code, String reason) {
                        sockets.remove(id, webSocket);
                        JSObject ev = new JSObject();
                        ev.put("id", id);
                        ev.put("code", code);
                        if (reason != null && !reason.isEmpty()) {
                            ev.put("reason", reason);
                        }
                        notifyListeners("socket-close", ev);
                    }

                    @Override
                    public void onFailure(WebSocket webSocket, Throwable t, @Nullable Response response) {
                        sockets.remove(id, webSocket);
                        String msg = response != null
                            ? "HTTP " + response.code() + " " + response.message()
                            : (t.getMessage() != null ? t.getMessage() : "WebSocket failure");
                        JSObject errEv = new JSObject();
                        errEv.put("id", id);
                        errEv.put("message", msg);
                        notifyListeners("socket-error", errEv);

                        JSObject closeEv = new JSObject();
                        closeEv.put("id", id);
                        closeEv.put("code", response != null ? response.code() : 1006);
                        closeEv.put("reason", msg);
                        notifyListeners("socket-close", closeEv);
                    }
                });

                sockets.put(id, ws);
                call.resolve(new JSObject());
            } catch (MissingSecretException e) {
                call.reject(e.getMessage(), "speech-auth", e);
            } catch (Exception e) {
                call.reject("socketOpen failed: " + e.getMessage(), "network", e);
            }
        });
    }

    @PluginMethod
    public void socketSend(PluginCall call) {
        String id = call.getString("id");
        String text = call.getString("text");
        String base64 = call.getString("base64");
        if (id == null) {
            call.reject("Missing socket id", "invalid-argument");
            return;
        }
        WebSocket ws = sockets.get(id);
        if (ws == null) {
            call.reject("Socket not open: " + id, "not-found");
            return;
        }
        if (text != null) {
            ws.send(text);
        } else if (base64 != null) {
            byte[] raw = Base64.decode(base64, Base64.DEFAULT);
            ws.send(ByteString.of(raw));
        }
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void socketClose(PluginCall call) {
        String id = call.getString("id");
        int code = safeInt(call, "code", 1000);
        if (id != null) {
            WebSocket ws = sockets.remove(id);
            if (ws != null) {
                try {
                    ws.close(code, "");
                } catch (Exception ignored) {}
            }
        }
        call.resolve(new JSObject());
    }

    // -------------------------------------------------------------------------
    // §4. Speech (`speech*`) — ReadAloudService, voices, journal & audio cache
    // -------------------------------------------------------------------------

    @PluginMethod
    public void speechVoices(PluginCall call) {
        final Context ctx = getContext();
        ioPool.execute(() -> {
            SystemTtsBackend probe = new SystemTtsBackend(ctx);
            try {
                JSONArray voices = probe.listAllInstalledVoices();
                JSArray jsVoices = new JSArray();
                for (int i = 0; i < voices.length(); i++) {
                    JSONObject v = voices.optJSONObject(i);
                    if (v != null) {
                        jsVoices.put(toJSObject(v));
                    }
                }
                JSObject res = new JSObject();
                res.put("voices", jsVoices);
                call.resolve(res);
            } finally {
                probe.shutdown();
            }
        });
    }

    @PluginMethod
    public void speechLoad(PluginCall call) {
        JSONObject raw = call.getData();
        if (raw == null) {
            call.reject("Missing speech session", "invalid-argument");
            return;
        }
        final ReadAloudQueueEngine.SessionSpec spec = ReadAloudQueueEngine.SessionSpec.fromJson(raw);
        ReadAloudService.runCommand(getContext(), true, svc -> {
            svc.getQueueEngine().load(spec);
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void speechEnqueue(PluginCall call) {
        JSArray arr = call.getArray("items");
        final String replaceFromId = call.getString("replaceFromId");
        final List<ReadAloudQueueEngine.UtteranceItem> items =
            ReadAloudQueueEngine.parseUtteranceList(arr);

        ReadAloudService.runCommand(getContext(), true, svc -> {
            svc.getQueueEngine().enqueue(items, replaceFromId);
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void speechAttachAudio(PluginCall call) {
        final String id = call.getString("id");
        final String path = call.getString("path");
        final long durationMs = safeLong(call, "durationMs", 0L);
        final List<ReadAloudQueueEngine.WordMarkSpec> marks =
            ReadAloudQueueEngine.parseWordMarks(call.getArray("marks"));

        if (id == null || path == null) {
            call.reject("id and path are required", "invalid-argument");
            return;
        }
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.getQueueEngine().attachAudio(id, path, durationMs, marks);
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechPlay(PluginCall call) {
        ReadAloudService.runCommand(getContext(), true, svc -> {
            svc.startPlayback();
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void speechPause(PluginCall call) {
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.pausePlayback();
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechStop(PluginCall call) {
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.stopPlayback();
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechSeekTo(PluginCall call) {
        final String id = call.getString("id");
        if (id == null) {
            call.reject("Missing utterance id", "invalid-argument");
            return;
        }
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.getQueueEngine().seekTo(id);
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechSetRate(PluginCall call) {
        final float rate = (float) safeDouble(call, "rate", 1.0);
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.getQueueEngine().setRate(rate);
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechSetVoice(PluginCall call) {
        final JSObject voiceObj = call.getObject("voice");
        final ReadAloudQueueEngine.VoiceSpec voiceSpec =
            ReadAloudQueueEngine.VoiceSpec.fromJson(voiceObj);
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.getQueueEngine().setVoice(voiceSpec);
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechSetSleepTimer(PluginCall call) {
        final String mode = call.getString("mode", "off");
        final int minutes = safeInt(call, "minutes", 0);
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                svc.getQueueEngine().setSleepTimer(mode, minutes);
                call.resolve(new JSObject());
            });
        } else {
            call.resolve(new JSObject());
        }
    }

    @PluginMethod
    public void speechGetState(PluginCall call) {
        ReadAloudService svc = ReadAloudService.peekInstance();
        if (svc != null) {
            mainHandler.post(() -> {
                JSONObject st = svc.getQueueEngine().buildStateJson();
                call.resolve(toJSObject(st));
            });
            return;
        }
        JSObject idle = new JSObject();
        idle.put("status", "idle");
        idle.put("bookId", JSONObject.NULL);
        idle.put("currentUtteranceId", JSONObject.NULL);
        idle.put("section", JSONObject.NULL);
        idle.put("offset", JSONObject.NULL);
        idle.put("rate", 1.0);
        idle.put("voice", JSONObject.NULL);
        idle.put("usingFallback", false);
        JSObject sleep = new JSObject();
        sleep.put("mode", "off");
        idle.put("sleepTimer", sleep);
        call.resolve(idle);
    }

    @PluginMethod
    public void speechReadJournal(PluginCall call) {
        ioPool.execute(() -> {
            SpeechJournal journal = new SpeechJournal(getMiniBookDataRoot());
            SpeechJournal.Checkpoint cp = journal.readCheckpoint();
            JSObject out = new JSObject();
            if (cp == null) {
                out.put("checkpoint", JSONObject.NULL);
            } else {
                out.put("checkpoint", toJSObject(cp.toJson()));
            }
            call.resolve(out);
        });
    }

    private File getSpeechCacheDir() {
        File dir = new File(getContext().getCacheDir(), "speech");
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    @PluginMethod
    public void speechCachePut(PluginCall call) {
        final String key = call.getString("key");
        final String base64 = call.getString("base64");
        final String ext = "wav".equalsIgnoreCase(call.getString("ext", "mp3")) ? "wav" : "mp3";

        if (key == null || !SAFE_CACHE_KEY.matcher(key).matches() || base64 == null) {
            call.reject("Invalid speech cache key or base64", "invalid-argument");
            return;
        }

        ioPool.execute(() -> {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                File cacheDir = getSpeechCacheDir();
                File target = new File(cacheDir, key.toLowerCase(Locale.US) + "." + ext);
                AtomicFiles.writeAtomicFile(target, bytes);
                pruneSpeechCacheLru(cacheDir, MAX_SPEECH_CACHE_BYTES);

                JSObject out = new JSObject();
                out.put("path", target.getAbsolutePath());
                out.put("bytes", bytes.length);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("speechCachePut failed: " + e.getMessage(), "corrupt-book", e);
            }
        });
    }

    @PluginMethod
    public void speechCacheClear(PluginCall call) {
        ioPool.execute(() -> {
            AtomicFiles.deleteRecursively(getSpeechCacheDir());
            //noinspection ResultOfMethodCallIgnored
            getSpeechCacheDir().mkdirs();
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void speechCacheSize(PluginCall call) {
        ioPool.execute(() -> {
            long total = 0L;
            File[] files = getSpeechCacheDir().listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isFile()) total += f.length();
                }
            }
            JSObject out = new JSObject();
            out.put("bytes", total);
            call.resolve(out);
        });
    }

    private static void pruneSpeechCacheLru(File cacheDir, long maxBytes) {
        File[] files = cacheDir.listFiles();
        if (files == null || files.length == 0) return;
        long total = 0L;
        for (File f : files) {
            if (f.isFile()) total += f.length();
        }
        if (total <= maxBytes) return;

        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File f : files) {
            if (total <= maxBytes) break;
            if (f.isFile()) {
                long len = f.length();
                if (f.delete()) {
                    total -= len;
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // §5. Device & E-Ink (`device*`)
    // -------------------------------------------------------------------------

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        EinkDetector.DetectionResult info = EinkDetector.detect(getContext());
        JSObject out = new JSObject();
        out.put("eink", info.eink);
        out.put("vendor", info.vendor != null ? info.vendor : JSONObject.NULL);
        out.put("model", info.model != null ? info.model : JSONObject.NULL);
        out.put("refresh", info.refresh);
        call.resolve(out);
    }

    @PluginMethod
    public void deviceSetImmersive(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        mainHandler.post(() -> {
            Activity act = getActivity();
            if (act instanceof MainActivity) {
                ((MainActivity) act).applyImmersiveMode(enabled);
            }
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void deviceSetKeepScreenOn(PluginCall call) {
        final boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        mainHandler.post(() -> {
            Activity act = getActivity();
            if (act instanceof MainActivity) {
                ((MainActivity) act).applyKeepScreenOn(enabled);
            }
            call.resolve(new JSObject());
        });
    }

    @PluginMethod
    public void deviceFullRefresh(PluginCall call) {
        mainHandler.post(() -> {
            boolean done = false;
            Activity act = getActivity();
            if (act != null && getBridge() != null && getBridge().getWebView() != null) {
                View webView = getBridge().getWebView();
                done = EinkRefresher.performFullRefresh(webView);
            }
            JSObject out = new JSObject();
            out.put("done", done);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void deviceSetKeyPolicy(PluginCall call) {
        boolean volumePaging = Boolean.TRUE.equals(call.getBoolean("volumePaging", false));
        Activity act = getActivity();
        if (act instanceof MainActivity) {
            ((MainActivity) act).getKeyPolicy().setVolumePaging(volumePaging);
        }
        call.resolve(new JSObject());
    }

    // -------------------------------------------------------------------------
    // §6. Secrets (`secrets*`) & `openExternal`
    // -------------------------------------------------------------------------

    private SharedPreferences getSecretsPrefs() {
        return getContext().getSharedPreferences(SECRETS_PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void secretsSet(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) {
            call.reject("Secret name is required", "invalid-argument");
            return;
        }
        JSObject data = call.getData();
        String value = (data != null && data.has("value") && !data.isNull("value"))
            ? data.optString("value", "")
            : null;
        SharedPreferences.Editor editor = getSecretsPrefs().edit();
        if (value == null || value.isEmpty()) {
            editor.remove(name.trim());
        } else {
            editor.putString(name.trim(), value);
        }
        editor.apply();
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void secretsHas(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) {
            call.reject("Secret name is required", "invalid-argument");
            return;
        }
        String val = getSecretsPrefs().getString(name.trim(), null);
        JSObject out = new JSObject();
        out.put("exists", val != null && !val.isEmpty());
        call.resolve(out);
    }

    @PluginMethod
    public void secretsRemove(PluginCall call) {
        String name = call.getString("name");
        if (name != null && !name.trim().isEmpty()) {
            getSecretsPrefs().edit().remove(name.trim()).apply();
        }
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing URL", "invalid-argument");
            return;
        }
        try {
            Uri uri = Uri.parse(url.trim());
            String scheme = uri.getScheme();
            if (scheme == null
                || (!"http".equalsIgnoreCase(scheme)
                    && !"https".equalsIgnoreCase(scheme)
                    && !"mailto".equalsIgnoreCase(scheme))) {
                call.reject("Disallowed external URL scheme", "invalid-argument");
                return;
            }
            Intent intent = "mailto".equalsIgnoreCase(scheme)
                ? new Intent(Intent.ACTION_SENDTO, uri)
                : new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject());
        } catch (ActivityNotFoundException e) {
            call.reject("No application can open URL: " + url, "unsupported", e);
        } catch (Exception e) {
            call.reject("openExternal failed: " + e.getMessage(), "invalid-argument", e);
        }
    }

    // -------------------------------------------------------------------------
    // Safe Capacitor number extraction (`Number.intValue()` / `longValue()`)
    // -------------------------------------------------------------------------

    private static final class MissingSecretException extends Exception {
        MissingSecretException(String msg) {
            super(msg);
        }
    }

    private Map<String, String> substituteSecretHeaders(
        Map<String, String> raw,
        HttpUrl targetUrl
    ) throws MissingSecretException {
        if (raw.isEmpty()) return raw;

        boolean hasSecretPlaceholder = false;
        for (String val : raw.values()) {
            if (SECRET_PATTERN.matcher(val).find()) {
                hasSecretPlaceholder = true;
                break;
            }
        }
        if (!hasSecretPlaceholder) {
            return raw;
        }

        // Restrict {{secret:*}} substitution strictly to the configured customSpeechServer origin
        HttpUrl allowedOrigin = readConfiguredCustomSpeechOrigin();
        if (allowedOrigin == null
            || !targetUrl.scheme().equalsIgnoreCase(allowedOrigin.scheme())
            || !targetUrl.host().equalsIgnoreCase(allowedOrigin.host())
            || targetUrl.port() != allowedOrigin.port()) {
            throw new MissingSecretException(
                "Secret header substitution denied for unconfigured origin: "
                    + targetUrl.scheme() + "://" + targetUrl.host()
            );
        }

        SharedPreferences prefs = getSecretsPrefs();
        Map<String, String> out = new HashMap<>(raw.size());
        for (Map.Entry<String, String> e : raw.entrySet()) {
            String val = e.getValue();
            Matcher m = SECRET_PATTERN.matcher(val);
            StringBuffer sb = new StringBuffer();
            while (m.find()) {
                String secretName = m.group(1);
                String secretVal = secretName != null ? prefs.getString(secretName, null) : null;
                if (secretVal == null || secretVal.isEmpty()) {
                    throw new MissingSecretException("Missing secret: " + secretName);
                }
                m.appendReplacement(sb, Matcher.quoteReplacement(secretVal));
            }
            m.appendTail(sb);
            out.put(e.getKey(), sb.toString());
        }
        return out;
    }

    @Nullable
    private HttpUrl readConfiguredCustomSpeechOrigin() {
        try {
            File settingsFile = AtomicFiles.resolveInJail(
                getMiniBookDataRoot(),
                "settings.json",
                false
            );
            if (!settingsFile.exists() || !settingsFile.isFile()) return null;
            byte[] raw = java.nio.file.Files.readAllBytes(settingsFile.toPath());
            JSONObject obj = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            JSONObject custom = obj.optJSONObject("customSpeechServer");
            if (custom == null) return null;
            String baseUrl = custom.optString("baseUrl", "").trim();
            if (baseUrl.isEmpty()) return null;
            return HttpUrl.parse(baseUrl);
        } catch (Exception e) {
            return null;
        }
    }

    private static JSObject toJSObject(JSONObject obj) {
        try {
            return JSObject.fromJSONObject(obj);
        } catch (JSONException e) {
            return new JSObject();
        }
    }

    private static Map<String, String> jsonObjectToMap(@Nullable JSONObject obj) {
        if (obj == null) return new HashMap<>();
        Map<String, String> out = new HashMap<>();
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (!obj.isNull(k)) {
                out.put(k, obj.optString(k, ""));
            }
        }
        return out;
    }

    @Nullable
    private static String findHeaderIgnoreCase(Map<String, String> headers, String target) {
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase(target)) return e.getValue();
        }
        return null;
    }

    static int safeInt(PluginCall call, String key, int fallback) {
        JSObject data = call.getData();
        return extractSafeInt(data, key, fallback);
    }

    static long safeLong(PluginCall call, String key, long fallback) {
        JSObject data = call.getData();
        return extractSafeLong(data, key, fallback);
    }

    static double safeDouble(PluginCall call, String key, double fallback) {
        JSObject data = call.getData();
        if (data == null || !data.has(key) || data.isNull(key)) return fallback;
        Object raw = data.opt(key);
        if (raw instanceof Number) {
            return ((Number) raw).doubleValue();
        }
        if (raw instanceof String) {
            try {
                return Double.parseDouble(((String) raw).trim());
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return data.optDouble(key, fallback);
    }

    static int extractSafeInt(@Nullable JSONObject data, String key, int fallback) {
        if (data == null || !data.has(key) || data.isNull(key)) return fallback;
        Object raw = data.opt(key);
        if (raw instanceof Number) {
            return ((Number) raw).intValue();
        }
        if (raw instanceof String) {
            try {
                return (int) Math.round(Double.parseDouble(((String) raw).trim()));
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        try {
            return data.getInt(key);
        } catch (JSONException e) {
            return fallback;
        }
    }

    static long extractSafeLong(@Nullable JSONObject data, String key, long fallback) {
        if (data == null || !data.has(key) || data.isNull(key)) return fallback;
        Object raw = data.opt(key);
        if (raw instanceof Number) {
            return ((Number) raw).longValue();
        }
        if (raw instanceof String) {
            try {
                return Math.round(Double.parseDouble(((String) raw).trim()));
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        try {
            return data.getLong(key);
        } catch (JSONException e) {
            return fallback;
        }
    }
}
