package dev.minibook.app;

/**
 * Pure-Java inference seam behind `KokoroOnnxBackend` so `KokoroSynthQueue` can be
 * deterministically unit-tested on the JVM without native `libonnxruntime.so` (`TTS_V2_SPEC.md` §5.2).
 */
public interface KokoroInference {
    final class SynthChunkResult {
        public final float[] waveform;
        public final long[] duration;

        public SynthChunkResult(float[] waveform, long[] duration) {
            this.waveform = waveform;
            this.duration = duration;
        }
    }

    final class SelfTestException extends Exception {
        public SelfTestException(String message) {
            super(message);
        }

        public SelfTestException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /**
     * Ensures the ONNX session is loaded and passes the mandatory load-time self-test (`ㄋㄧ2ㄏㄠ3.`).
     */
    void ensureReady(KokoroModelStore store) throws Exception;

    /**
     * Synthesizes a single unpadded phoneme id chunk `[0, ...unpaddedIds, 0]`.
     */
    SynthChunkResult synthesize(long[] unpaddedIds, float[] style256, float speed) throws Exception;

    /**
     * Terminates any currently running inference (`RunOptions.setTerminate(true)`).
     */
    void cancel();

    /**
     * Closes the underlying ONNX session & frees native buffers.
     */
    void close();
}
