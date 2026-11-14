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
    public static final String VARIANT_Q8 = "onnx-q8";
    public static final String VARIANT_FP32 = "onnx-fp32";
    public static final String DEFAULT_VARIANT = VARIANT_Q8;
    public static final long ONNX_Q8_BYTES = 127_356_597L;
    public static final long ONNX_FP32_BYTES = 339_369_442L;
    public static final int DEFAULT_VOICES_COUNT = 9;
    public static final int VOICE_BIN_BYTES = 522_240;
    public static final int VOICE_ROWS = 510;
    public static final int VOICE_DIM = 256;
    public static final int SAMPLE_RATE = 24_000;
    public static final int SAMPLES_PER_FRAME = 600; // 25 ms @ 24 kHz
    public static final long DEFAULT_ESTIMATED_TOTAL_BYTES =
        ONNX_Q8_BYTES + (long) DEFAULT_VOICES_COUNT * (long) VOICE_BIN_BYTES;

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

    public static String onnxRelativePathForVariant(String variant) {
        return VARIANT_FP32.equals(variant) ? "onnx/model.onnx" : "onnx/model_quantized.onnx";
    }

    public static long onnxSizeForVariant(String variant) {
        return VARIANT_FP32.equals(variant) ? ONNX_FP32_BYTES : ONNX_Q8_BYTES;
    }

    @Nullable
    public String readConfiguredPrecisionVariant() {
        File settingsFile = new File(miniBookDataRoot, "settings.json");
        if (!settingsFile.exists() || !settingsFile.isFile()) return null;
        try {
            byte[] bytes = Files.readAllBytes(settingsFile.toPath());
            JSONObject obj = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            String prec = obj.optString("kokoroPrecision", "");
            if ("fp32".equals(prec)) return VARIANT_FP32;
            if ("q8".equals(prec)) return VARIANT_Q8;
        } catch (Exception ignored) {}
        return null;
    }

    @Nullable
    public JSONObject readRawInstalledMeta() {
        File metaFile = new File(getModelRoot(MODEL_ID), "installed.json");
        if (!metaFile.exists() || !metaFile.isFile()) return null;
        try {
            byte[] bytes = Files.readAllBytes(metaFile.toPath());
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    public String getDesiredVariant() {
        String configured = readConfiguredPrecisionVariant();
        if (configured != null) return configured;
        JSONObject raw = readRawInstalledMeta();
        if (raw != null) {
            String v = raw.optString("variant", "");
            if (VARIANT_FP32.equals(v) || VARIANT_Q8.equals(v)) {
                return v;
            }
        }
        return DEFAULT_VARIANT;
    }

    public String getActiveVariant() {
        String desired = getDesiredVariant();
        if (readInstalledMetaForVariant(desired) != null) {
            return desired;
        }
        String alt = VARIANT_FP32.equals(desired) ? VARIANT_Q8 : VARIANT_FP32;
        if (readInstalledMetaForVariant(alt) != null) {
            return alt;
        }
        return desired;
    }

    @Nullable
    public JSONObject readInstalledMeta() {
        return readInstalledMetaForVariant(getActiveVariant());
    }

    @Nullable
    public JSONObject readInstalledMetaForVariant(String targetVariant) {
        JSONObject obj = readRawInstalledMeta();
        if (obj == null) return null;
        try {
            String metaVariant = obj.optString("variant", DEFAULT_VARIANT);
            if (targetVariant.equals(metaVariant)) {
                JSONArray files = obj.optJSONArray("files");
                if (files != null && files.length() > 0) {
                    boolean allPresent = true;
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject f = files.optJSONObject(i);
                        if (f == null) {
                            allPresent = false;
                            break;
                        }
                        String rel = f.optString("path", "");
                        long size = f.optLong("size", -1L);
                        if (rel.isEmpty() || size <= 0L) {
                            allPresent = false;
                            break;
                        }
                        File disk = resolveInModelJail(MODEL_ID, rel);
                        if (!disk.exists() || !disk.isFile() || disk.length() != size) {
                            allPresent = false;
                            break;
                        }
                    }
                    if (allPresent) {
                        return obj;
                    }
                }
            }

            // Also check multi-variant `variants` map so switching back between already-downloaded
            // `onnx-q8` and `onnx-fp32` is instant (0 network bytes) with shared `voices/*.bin`.
            JSONObject variantsObj = obj.optJSONObject("variants");
            JSONObject varSpec = variantsObj != null ? variantsObj.optJSONObject(targetVariant) : null;
            if (varSpec != null) {
                String onnxRel = varSpec.optString("path", "");
                long onnxSize = varSpec.optLong("size", -1L);
                if (!onnxRel.isEmpty() && onnxSize > 0L) {
                    File onnxDisk = resolveInModelJail(MODEL_ID, onnxRel);
                    List<String> voicesOnDisk = detectInstalledVoicesOnDisk();
                    if (onnxDisk.exists() && onnxDisk.isFile() && onnxDisk.length() == onnxSize && !voicesOnDisk.isEmpty()) {
                        JSONObject synthesized = new JSONObject(obj.toString());
                        synthesized.put("variant", targetVariant);
                        JSONArray filesArr = new JSONArray();
                        filesArr.put(new JSONObject(varSpec.toString()));
                        String repo = obj.optString("repo", "onnx-community/Kokoro-82M-v1.1-zh-ONNX");
                        String rev = obj.optString("revision", "");
                        for (String v : voicesOnDisk) {
                            JSONObject vf = new JSONObject();
                            vf.put("path", "voices/" + v + ".bin");
                            vf.put("size", VOICE_BIN_BYTES);
                            vf.put("repo", repo);
                            vf.put("revision", rev);
                            filesArr.put(vf);
                        }
                        synthesized.put("files", filesArr);
                        synthesized.put("voices", new JSONArray(voicesOnDisk));
                        return synthesized;
                    }
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    public void writeInstalledMeta(JSONObject meta) throws IOException {
        File metaFile = new File(getModelRoot(MODEL_ID), "installed.json");
        AtomicFiles.writeAtomicFile(metaFile, meta.toString().getBytes(StandardCharsets.UTF_8));
    }

    public boolean isSelfTestPassed(String variant, String runtimeVersion, String osBuild) {
        JSONObject meta = readRawInstalledMeta();
        if (meta == null) return false;
        JSONObject byVar = meta.optJSONObject("selfTests");
        JSONObject st = byVar != null ? byVar.optJSONObject(variant) : null;
        if (st == null) {
            st = meta.optJSONObject("selfTest");
        }
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
        JSONObject meta = readRawInstalledMeta();
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
            JSONObject byVar = meta.optJSONObject("selfTests");
            if (byVar == null) byVar = new JSONObject();
            byVar.put(variant, st);
            meta.put("selfTests", byVar);
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
        String targetVariant = getActiveVariant();
        JSONObject meta = readInstalledMetaForVariant(targetVariant);
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
            String variant = meta.optString("variant", targetVariant);
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

        List<String> installedVoices = detectInstalledVoicesOnDisk();
        long voicesBytes = (long) installedVoices.size() * (long) VOICE_BIN_BYTES;
        long expectedVoicesBytes = voicesBytes > 0L
            ? voicesBytes
            : (long) DEFAULT_VOICES_COUNT * (long) VOICE_BIN_BYTES;
        long expectedOnnxBytes = onnxSizeForVariant(targetVariant);
        long estimatedTotal = expectedOnnxBytes + expectedVoicesBytes;

        File root = getModelRoot(MODEL_ID);
        long partBytes = 0L;
        boolean hasPartForVariant = false;
        if (root.exists() && root.isDirectory()) {
            try {
                File onnxFile = resolveInModelJail(MODEL_ID, onnxRelativePathForVariant(targetVariant));
                File partFile = new File(onnxFile.getPath() + ".part");
                if (partFile.exists() && partFile.isFile()) {
                    partBytes = Math.min(partFile.length(), expectedOnnxBytes);
                    hasPartForVariant = partBytes > 0L;
                }
            } catch (IOException ignored) {}
        }

        JSONObject rawMeta = readRawInstalledMeta();
        long prevInstalledBytes = 0L;
        if (rawMeta != null) {
            JSONArray prevFiles = rawMeta.optJSONArray("files");
            if (prevFiles != null) {
                for (int i = 0; i < prevFiles.length(); i++) {
                    JSONObject f = prevFiles.optJSONObject(i);
                    if (f != null) prevInstalledBytes += Math.max(0L, f.optLong("size", 0L));
                }
            }
        }

        long diskBytes = sumDirBytes(root);
        // When switching precision (`q8 -> fp32`) after `q8` was already installed (`rawMeta != null`),
        // report `paused` ONLY if `.part` exists for the new variant; otherwise `absent` (with `voicesBytes`
        // already counted) so the UI knows the new variant's `.onnx` has not started downloading yet.
        String state;
        long doneBytes;
        if (rawMeta != null) {
            state = hasPartForVariant ? "paused" : "absent";
            doneBytes = Math.min(voicesBytes + partBytes, estimatedTotal);
        } else {
            state = diskBytes > 0L ? "paused" : "absent";
            doneBytes = Math.min(diskBytes, estimatedTotal);
        }
        return buildStatusJson(
            state,
            targetVariant,
            doneBytes,
            estimatedTotal,
            prevInstalledBytes,
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
