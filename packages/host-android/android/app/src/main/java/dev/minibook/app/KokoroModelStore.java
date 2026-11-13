package dev.minibook.app;

import androidx.annotation.Nullable;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pure-Java storage layout, `installed.json` persistence, self-test cache, and
 * `voices/<id>.bin` `(510, 1, 256)` float32-LE row slicer (`TTS_V2_SPEC.md` §3.3, §5.2).
 */
public final class KokoroModelStore {
    public static final String MODEL_ID = "kokoro-v1.1-zh";
    public static final String DEFAULT_VARIANT = "onnx-q8";
    public static final int VOICE_BIN_BYTES = 522_240;
    public static final int VOICE_ROWS = 510;
    public static final int VOICE_DIM = 256;
    public static final int SAMPLE_RATE = 24_000;
    public static final int SAMPLES_PER_FRAME = 600; // 25 ms @ 24 kHz
    public static final long DEFAULT_ESTIMATED_TOTAL_BYTES = 129_967_797L; // q8 + 5 default voices

    private static final Pattern SAFE_REL_PATH = Pattern.compile("^[A-Za-z0-9._/-]+$");
    private static final Pattern SAFE_VOICE_ID = Pattern.compile("^[A-Za-z0-9_]{2,40}$");

    private final File miniBookDataRoot;

    public KokoroModelStore(File miniBookDataRoot) {
        this.miniBookDataRoot = miniBookDataRoot;
    }

    public File getModelsRoot() {
        return new File(miniBookDataRoot, "models");
    }

    public File getModelRoot(String modelId) {
        if (!MODEL_ID.equals(modelId)) {
            throw new IllegalArgumentException("Unsupported speech model id: " + modelId);
        }
        return new File(getModelsRoot(), modelId);
    }

    public File resolveInModelJail(String modelId, String relPath) throws IOException {
        if (relPath == null || !SAFE_REL_PATH.matcher(relPath).matches() || relPath.contains("..")) {
            throw new IllegalArgumentException("Unsafe model relative path: " + relPath);
        }
        return AtomicFiles.resolveInJail(getModelRoot(modelId), relPath, false);
    }

    public static int clampStyleRow(int unpaddedTokenCount) {
        return Math.max(0, Math.min(VOICE_ROWS - 1, unpaddedTokenCount - 1));
    }

    public static long voiceRowByteOffset(int unpaddedTokenCount) {
        return (long) clampStyleRow(unpaddedTokenCount) * (long) VOICE_DIM * 4L;
    }

    /**
     * Reads the 256-dim float32-LE style row (`row = clamp(tokenCount - 1, 0, 509)`)
     * directly from `voices/<voiceId>.bin` via `RandomAccessFile` (`TTS_V2_SPEC.md` §5.2).
     */
    public float[] styleRow(String voiceId, int unpaddedTokenCount) throws IOException {
        if (voiceId == null || !SAFE_VOICE_ID.matcher(voiceId).matches()) {
            throw new IllegalArgumentException("Invalid Kokoro voiceId: " + voiceId);
        }
        File voiceFile = resolveInModelJail(MODEL_ID, "voices/" + voiceId + ".bin");
        if (!voiceFile.exists() || !voiceFile.isFile()) {
            throw new IOException("Kokoro voice file missing: " + voiceFile.getName());
        }
        if (voiceFile.length() != VOICE_BIN_BYTES) {
            throw new IOException("Kokoro voice file invalid length: " + voiceFile.length());
        }
        long offset = voiceRowByteOffset(unpaddedTokenCount);
        byte[] raw = new byte[VOICE_DIM * 4];
        try (RandomAccessFile raf = new RandomAccessFile(voiceFile, "r")) {
            raf.seek(offset);
            raf.readFully(raw);
        }
        ByteBuffer bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        float[] out = new float[VOICE_DIM];
        for (int i = 0; i < VOICE_DIM; i++) {
            out[i] = bb.getFloat();
        }
        return out;
    }

    @Nullable
    public JSONObject readInstalledMeta() {
        File metaFile = new File(getModelRoot(MODEL_ID), "installed.json");
        if (!metaFile.exists() || !metaFile.isFile()) return null;
        try {
            byte[] bytes = Files.readAllBytes(metaFile.toPath());
            JSONObject obj = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            JSONArray files = obj.optJSONArray("files");
            if (files == null || files.length() == 0) return null;
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.optJSONObject(i);
                if (f == null) return null;
                String rel = f.optString("path", "");
                long size = f.optLong("size", -1L);
                if (rel.isEmpty() || size <= 0L) return null;
                File disk = resolveInModelJail(MODEL_ID, rel);
                if (!disk.exists() || !disk.isFile() || disk.length() != size) {
                    return null;
                }
            }
            return obj;
        } catch (Exception e) {
            return null;
        }
    }

    public void writeInstalledMeta(JSONObject meta) throws IOException {
        File metaFile = new File(getModelRoot(MODEL_ID), "installed.json");
        AtomicFiles.writeAtomicFile(metaFile, meta.toString().getBytes(StandardCharsets.UTF_8));
    }

    public boolean isSelfTestPassed(String variant, String runtimeVersion, String osBuild) {
        JSONObject meta = readInstalledMeta();
        if (meta == null) return false;
        JSONObject st = meta.optJSONObject("selfTest");
        if (st == null || !st.optBoolean("passed", false)) return false;
        return variant.equals(st.optString("variant", ""))
            && runtimeVersion.equals(st.optString("runtimeVersion", ""))
            && osBuild.equals(st.optString("osBuild", ""));
    }

    public void recordSelfTestResult(
        String variant,
        String runtimeVersion,
        String osBuild,
        boolean passed,
        @Nullable String errorMessage
    ) {
        JSONObject meta = readInstalledMeta();
        if (meta == null) return;
        try {
            JSONObject st = new JSONObject();
            st.put("variant", variant);
            st.put("runtimeVersion", runtimeVersion);
            st.put("osBuild", osBuild);
            st.put("passed", passed);
            if (errorMessage != null) {
                st.put("error", errorMessage);
            }
            meta.put("selfTest", st);
            meta.put("backend", "ort-cpu");
            writeInstalledMeta(meta);
        } catch (Exception ignored) {}
    }

    public List<String> detectInstalledVoicesOnDisk() {
        File voicesDir = new File(getModelRoot(MODEL_ID), "voices");
        if (!voicesDir.exists() || !voicesDir.isDirectory()) return Collections.emptyList();
        File[] files = voicesDir.listFiles();
        if (files == null || files.length == 0) return Collections.emptyList();
        List<String> out = new ArrayList<>();
        for (File f : files) {
            if (f.isFile() && f.getName().endsWith(".bin") && f.length() == VOICE_BIN_BYTES) {
                String name = f.getName();
                out.add(name.substring(0, name.length() - 4));
            }
        }
        Collections.sort(out);
        return out;
    }

    public long totalModelsBytes() {
        return sumDirBytes(getModelsRoot());
    }

    private static long sumDirBytes(File dir) {
        if (dir == null || !dir.exists()) return 0L;
        if (dir.isFile()) {
            String n = dir.getName();
            if (n.contains(".tmp.")) return 0L;
            return dir.length();
        }
        File[] children = dir.listFiles();
        if (children == null) return 0L;
        long total = 0L;
        for (File c : children) {
            total += sumDirBytes(c);
        }
        return total;
    }

    public JSONObject buildReconciledStatus(
        @Nullable String activeBackend,
        double rtfEma,
        @Nullable JSONObject selfTestError
    ) {
        JSONObject meta = readInstalledMeta();
        if (meta != null) {
            long installedBytes = 0L;
            JSONArray files = meta.optJSONArray("files");
            if (files != null) {
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.optJSONObject(i);
                    if (f != null) installedBytes += Math.max(0L, f.optLong("size", 0L));
                }
            }
            JSONArray voicesArr = meta.optJSONArray("voices");
            if (voicesArr == null) {
                voicesArr = new JSONArray(detectInstalledVoicesOnDisk());
            }
            String state = selfTestError != null ? "error" : "ready";
            String variant = meta.optString("variant", DEFAULT_VARIANT);
            String source = meta.has("source") && !meta.isNull("source") ? meta.optString("source") : null;
            return buildStatusJson(
                state,
                variant,
                installedBytes,
                installedBytes,
                installedBytes,
                voicesArr,
                source,
                activeBackend != null ? activeBackend : (meta.has("backend") ? meta.optString("backend") : null),
                rtfEma > 0.0 ? rtfEma : null,
                selfTestError
            );
        }

        File root = getModelRoot(MODEL_ID);
        long diskBytes = sumDirBytes(root);
        List<String> installedVoices = detectInstalledVoicesOnDisk();
        String state = diskBytes > 0L ? "paused" : "absent";
        return buildStatusJson(
            state,
            DEFAULT_VARIANT,
            Math.min(diskBytes, DEFAULT_ESTIMATED_TOTAL_BYTES),
            DEFAULT_ESTIMATED_TOTAL_BYTES,
            0L,
            new JSONArray(installedVoices),
            null,
            null,
            null,
            null
        );
    }

    public static JSONObject buildStatusJson(
        String state,
        String variant,
        long bytesDone,
        long bytesTotal,
        long installedBytes,
        JSONArray installedVoices,
        @Nullable String source,
        @Nullable String backend,
        @Nullable Double rtf,
        @Nullable JSONObject error
    ) {
        JSONObject out = new JSONObject();
        try {
            out.put("id", MODEL_ID);
            out.put("state", state);
            out.put("variant", variant);
            out.put("bytesDone", bytesDone);
            out.put("bytesTotal", bytesTotal);
            out.put("installedBytes", installedBytes);
            out.put("installedVoices", installedVoices);
            if (source != null && !source.isEmpty()) {
                out.put("source", source);
            }
            if (backend != null && !backend.isEmpty()) {
                out.put("backend", backend);
            }
            if (rtf != null && Double.isFinite(rtf) && rtf > 0.0) {
                out.put("rtf", rtf);
            }
            if (error != null) {
                out.put("error", error);
            }
        } catch (JSONException ignored) {}
        return out;
    }

    public static JSONObject makeErrorJson(String code, String message) {
        JSONObject err = new JSONObject();
        try {
            err.put("code", code);
            err.put("message", message);
        } catch (JSONException ignored) {}
        return err;
    }
}
