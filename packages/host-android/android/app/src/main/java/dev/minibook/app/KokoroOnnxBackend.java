package dev.minibook.app;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import android.os.Build;
import androidx.annotation.Nullable;
import java.io.File;
import java.nio.FloatBuffer;
import java.nio.LongBuffer;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Native ONNX Runtime Android backend (`onnxruntime-android:1.32.0`, CPU EP only,
 * `model_quantized.onnx` q8) with mandatory load-time self-test (`TTS_V2_SPEC.md` §5.2).
 */
public final class KokoroOnnxBackend implements KokoroInference {
    private static final String ORT_RUNTIME_VERSION = "1.32.0";
    private static final long[] SELF_TEST_IDS = { 73L, 127L, 172L, 88L, 108L, 169L, 4L }; // ㄋㄧ2ㄏㄠ3.

    private final Object lock = new Object();
    @Nullable private OrtEnvironment env;
    @Nullable private OrtSession session;
    @Nullable private volatile OrtSession.RunOptions activeRunOptions;
    private boolean selfTestVerified = false;

    @Override
    public void ensureReady(KokoroModelStore store) throws Exception {
        synchronized (lock) {
            if (session != null && selfTestVerified) {
                return;
            }
            File modelFile = store.resolveInModelJail(KokoroModelStore.MODEL_ID, "onnx/model_quantized.onnx");
            if (!modelFile.exists() || !modelFile.isFile()) {
                throw new IllegalStateException("Kokoro model_quantized.onnx is not installed");
            }

            if (env == null) {
                env = OrtEnvironment.getEnvironment();
            }
            if (session == null) {
                OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
                try {
                    int cores = Runtime.getRuntime().availableProcessors();
                    int threads = Math.min(4, Math.max(2, cores - 2));
                    opts.setIntraOpNumThreads(threads);
                    opts.setInterOpNumThreads(1);
                    opts.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL);
                    opts.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
                    opts.addConfigEntry("session.intra_op.allow_spinning", "0");
                    session = env.createSession(modelFile.getAbsolutePath(), opts);
                } finally {
                    opts.close();
                }
            }

            String osBuild = Build.FINGERPRINT != null ? Build.FINGERPRINT : "unknown";
            if (store.isSelfTestPassed(KokoroModelStore.DEFAULT_VARIANT, ORT_RUNTIME_VERSION, osBuild)) {
                selfTestVerified = true;
                return;
            }

            try {
                String testVoice = "zf_001";
                File zf001 = store.resolveInModelJail(KokoroModelStore.MODEL_ID, "voices/zf_001.bin");
                if (!zf001.exists()) {
                    List<String> voices = store.detectInstalledVoicesOnDisk();
                    if (!voices.isEmpty()) {
                        testVoice = voices.get(0);
                    }
                }
                float[] style = store.styleRow(testVoice, SELF_TEST_IDS.length);
                SynthChunkResult res = runInternal(SELF_TEST_IDS, style, 1.0f);
                validateSelfTestResult(res.waveform);
                selfTestVerified = true;
                store.recordSelfTestResult(
                    KokoroModelStore.DEFAULT_VARIANT,
                    ORT_RUNTIME_VERSION,
                    osBuild,
                    true,
                    null
                );
            } catch (Exception e) {
                close();
                store.recordSelfTestResult(
                    KokoroModelStore.DEFAULT_VARIANT,
                    ORT_RUNTIME_VERSION,
                    osBuild,
                    false,
                    e.getMessage()
                );
                if (e instanceof SelfTestException) throw e;
                throw new SelfTestException("Kokoro ONNX load-time self-test failed: " + e.getMessage(), e);
            }
        }
    }

    static void validateSelfTestResult(float[] waveform) throws SelfTestException {
        if (waveform == null || waveform.length == 0) {
            throw new SelfTestException("Self-test returned empty waveform");
        }
        float durationSec = waveform.length / (float) KokoroModelStore.SAMPLE_RATE;
        if (durationSec < 0.5f || durationSec > 4.0f) {
            throw new SelfTestException("Self-test duration out of bounds: " + durationSec + "s");
        }
        float maxAbs = 0f;
        for (float s : waveform) {
            if (Float.isNaN(s) || Float.isInfinite(s)) {
                throw new SelfTestException("Self-test produced non-finite sample");
            }
            float a = Math.abs(s);
            if (a > maxAbs) maxAbs = a;
        }
        if (maxAbs < 0.01f) {
            throw new SelfTestException("Self-test produced silent audio (peak=" + maxAbs + ")");
        }
    }

    @Override
    public SynthChunkResult synthesize(long[] unpaddedIds, float[] style256, float speed) throws Exception {
        synchronized (lock) {
            if (session == null || env == null) {
                throw new IllegalStateException("Kokoro ONNX session is not initialized");
            }
            return runInternal(unpaddedIds, style256, speed);
        }
    }

    private SynthChunkResult runInternal(long[] unpaddedIds, float[] style256, float speed) throws OrtException {
        OrtEnvironment e = this.env;
        OrtSession s = this.session;
        if (e == null || s == null) {
            throw new IllegalStateException("ONNX session closed");
        }

        long[] padded = new long[unpaddedIds.length + 2];
        padded[0] = 0L;
        System.arraycopy(unpaddedIds, 0, padded, 1, unpaddedIds.length);
        padded[padded.length - 1] = 0L;

        float safeSpeed = Float.isFinite(speed) && speed > 0f ? speed : 1.0f;

        OnnxTensor idsTensor = null;
        OnnxTensor styleTensor = null;
        OnnxTensor speedTensor = null;
        OrtSession.RunOptions runOptions = null;
        OrtSession.Result result = null;
        try {
            idsTensor = OnnxTensor.createTensor(e, LongBuffer.wrap(padded), new long[] { 1L, padded.length });
            styleTensor = OnnxTensor.createTensor(
                e,
                FloatBuffer.wrap(style256),
                new long[] { 1L, KokoroModelStore.VOICE_DIM }
            );
            speedTensor = OnnxTensor.createTensor(
                e,
                FloatBuffer.wrap(new float[] { safeSpeed }),
                new long[] { 1L }
            );

            Map<String, OnnxTensor> feeds = new HashMap<>(3);
            feeds.put("input_ids", idsTensor);
            feeds.put("style", styleTensor);
            feeds.put("speed", speedTensor);

            runOptions = new OrtSession.RunOptions();
            activeRunOptions = runOptions;
            result = s.run(feeds, runOptions);

            OnnxValue waveVal = result.get("waveform").orElse(null);
            if (!(waveVal instanceof OnnxTensor)) {
                throw new IllegalStateException("Missing waveform tensor output");
            }
            FloatBuffer waveBuf = ((OnnxTensor) waveVal).getFloatBuffer();
            float[] waveform = new float[waveBuf.remaining()];
            waveBuf.get(waveform);

            long[] duration = new long[0];
            OnnxValue durVal = result.get("duration").orElse(null);
            if (durVal instanceof OnnxTensor) {
                LongBuffer durBuf = ((OnnxTensor) durVal).getLongBuffer();
                duration = new long[durBuf.remaining()];
                durBuf.get(duration);
            }

            return new SynthChunkResult(waveform, duration);
        } finally {
            activeRunOptions = null;
            if (result != null) {
                try { result.close(); } catch (Exception ignored) {}
            }
            if (runOptions != null) {
                try { runOptions.close(); } catch (Exception ignored) {}
            }
            if (idsTensor != null) {
                try { idsTensor.close(); } catch (Exception ignored) {}
            }
            if (styleTensor != null) {
                try { styleTensor.close(); } catch (Exception ignored) {}
            }
            if (speedTensor != null) {
                try { speedTensor.close(); } catch (Exception ignored) {}
            }
        }
    }

    @Override
    public void cancel() {
        OrtSession.RunOptions opts = activeRunOptions;
        if (opts != null) {
            try {
                opts.setTerminate(true);
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void close() {
        cancel();
        synchronized (lock) {
            selfTestVerified = false;
            if (session != null) {
                try { session.close(); } catch (Exception ignored) {}
                session = null;
            }
        }
    }
}
