package dev.minibook.app;

import android.os.Handler;
import android.os.HandlerThread;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native lookahead Kokoro-82M synthesis queue (`TTS_V2_SPEC.md` §5.2):
 *   - Runs entirely on background `HandlerThread("kokoro-synth")` (screen-off safe, never main looper)
 *   - Lookahead target: >= 45 s consecutive ready items, capped at 12 items ahead from `currentIndex`
 *   - `currentIndex` first (alone), then strictly forward; skips items without `phonemeIds`
 *   - Writes 24 kHz mono PCM16 WAV to `cacheDir/speech/kokoro-<sha256>.wav` (200 MB LRU cap)
 *   - Tracks 8-sample RTF EMA; emits `engine-slow` when `samples >= 3 && ema >= 0.9`
 *   - Closes ONNX session after 5 minutes without synthesis
 */
public final class KokoroSynthQueue implements ReadAloudQueueEngine.LocalSynth {
    public interface QueueCallback {
        void attachAudio(
            String utteranceId,
            String wavPath,
            long durationMs,
            List<ReadAloudQueueEngine.WordMarkSpec> marks
        );
        void onSynthFailed(String utteranceId, String errorCode, String message);
        void onEngineSlow(double rtf);
    }

    public static final long LOOKAHEAD_TARGET_MS = 45_000L;
    public static final int LOOKAHEAD_MAX_ITEMS = 12;
    private static final long MAX_SPEECH_CACHE_BYTES = 200L * 1024L * 1024L;
    private static final long IDLE_SESSION_CLOSE_MS = 5L * 60L * 1000L;
    private static final int RTF_EMA_WINDOW = 8;
    private static final int G2P_VERSION = 1;

    private final KokoroModelStore modelStore;
    private final KokoroInference inference;
    private final File speechCacheDir;
    private final QueueCallback callback;
    private final boolean ownsThread;
    @Nullable private final HandlerThread workerThread;
    @Nullable private final Handler workerHandler;
    @Nullable private final Executor customExecutor;

    private final AtomicInteger planGeneration = new AtomicInteger(0);
    private final Set<String> failedInPlan = new HashSet<>();
    @Nullable private String activeVoiceId;
    private double rtfEma = 0.0;
    private int rtfSamples = 0;
    private boolean slowEmittedForVoice = false;

    private final Runnable idleCloseTask = new Runnable() {
        @Override
        public void run() {
            inference.close();
        }
    };

    public KokoroSynthQueue(
        KokoroModelStore modelStore,
        KokoroInference inference,
        File speechCacheDir,
        QueueCallback callback
    ) {
        this.modelStore = modelStore;
        this.inference = inference;
        this.speechCacheDir = speechCacheDir;
        this.callback = callback;
        this.ownsThread = true;
        this.workerThread = new HandlerThread("kokoro-synth");
        this.workerThread.start();
        this.workerHandler = new Handler(this.workerThread.getLooper());
        this.customExecutor = null;
    }

    KokoroSynthQueue(
        KokoroModelStore modelStore,
        KokoroInference inference,
        File speechCacheDir,
        QueueCallback callback,
        Executor executor
    ) {
        this.modelStore = modelStore;
        this.inference = inference;
        this.speechCacheDir = speechCacheDir;
        this.callback = callback;
        this.ownsThread = false;
        this.workerThread = null;
        this.workerHandler = null;
        this.customExecutor = executor;
    }

    @Override
    public void onPlan(
        List<ReadAloudQueueEngine.UtteranceItem> queue,
        int currentIndex,
        ReadAloudQueueEngine.VoiceSpec voice,
        int engineGeneration
    ) {
        if (!"kokoro".equals(voice.kind) || voice.voiceId == null || voice.voiceId.isEmpty()) {
            return;
        }
        if (queue == null || queue.isEmpty() || currentIndex < 0 || currentIndex >= queue.size()) {
            return;
        }

        final String voiceId = voice.voiceId;
        if (!voiceId.equals(activeVoiceId)) {
            activeVoiceId = voiceId;
            rtfEma = 0.0;
            rtfSamples = 0;
            slowEmittedForVoice = false;
            synchronized (failedInPlan) {
                failedInPlan.clear();
            }
        }

        final int myPlanGen = planGeneration.incrementAndGet();
        final List<ReadAloudQueueEngine.UtteranceItem> snapshot = new ArrayList<>(queue);
        if (workerHandler != null) {
            workerHandler.removeCallbacks(idleCloseTask);
        }

        Runnable task = () -> processPlan(snapshot, currentIndex, voiceId, myPlanGen);
        if (workerHandler != null) {
            workerHandler.post(task);
        } else if (customExecutor != null) {
            customExecutor.execute(task);
        }
    }

    @Override
    public void cancelAll() {
        planGeneration.incrementAndGet();
        inference.cancel();
    }

    public void shutdown() {
        cancelAll();
        if (workerHandler != null) {
            workerHandler.removeCallbacks(idleCloseTask);
        }
        inference.close();
        if (ownsThread && workerThread != null) {
            workerThread.quitSafely();
        }
    }

    private void processPlan(
        List<ReadAloudQueueEngine.UtteranceItem> queue,
        int currentIndex,
        String voiceId,
        int myPlanGen
    ) {
        try {
            long readyAheadMs = 0L;
            int limit = Math.min(queue.size(), currentIndex + LOOKAHEAD_MAX_ITEMS);

            for (int i = currentIndex; i < limit; i++) {
                if (planGeneration.get() != myPlanGen) return;
                ReadAloudQueueEngine.UtteranceItem item = queue.get(i);
                if (item.phonemeIds == null || item.phonemeIds.length == 0) {
                    continue;
                }
                if (item.audio != null) {
                    readyAheadMs += Math.max(0L, item.audio.durationMs);
                    if (readyAheadMs >= LOOKAHEAD_TARGET_MS) break;
                    continue;
                }
                synchronized (failedInPlan) {
                    if (failedInPlan.contains(item.id + "@" + voiceId)) {
                        continue;
                    }
                }

                long durMs = synthesizeOrUseCache(item, voiceId, myPlanGen);
                if (planGeneration.get() != myPlanGen) return;
                if (durMs > 0L) {
                    readyAheadMs += durMs;
                    if (readyAheadMs >= LOOKAHEAD_TARGET_MS) break;
                }
            }
        } finally {
            if (workerHandler != null && planGeneration.get() == myPlanGen) {
                workerHandler.removeCallbacks(idleCloseTask);
                workerHandler.postDelayed(idleCloseTask, IDLE_SESSION_CLOSE_MS);
            }
        }
    }

    private long synthesizeOrUseCache(
        ReadAloudQueueEngine.UtteranceItem item,
        String voiceId,
        int myPlanGen
    ) {
        try {
            String key = computeCacheKey(voiceId, item);
            if (!speechCacheDir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                speechCacheDir.mkdirs();
            }
            File wavFile = new File(speechCacheDir, "kokoro-" + key + ".wav");
            if (wavFile.exists() && wavFile.isFile() && wavFile.length() > 44L) {
                long cachedDurMs = estimateWavDurationMs(wavFile.length());
                callback.attachAudio(item.id, wavFile.getAbsolutePath(), cachedDurMs, Collections.emptyList());
                return cachedDurMs;
            }

            inference.ensureReady(modelStore);
            if (planGeneration.get() != myPlanGen) return 0L;

            long t0 = System.nanoTime();
            ByteArrayOutputStream pcmOut = new ByteArrayOutputStream();
            List<ReadAloudQueueEngine.WordMarkSpec> marks = new ArrayList<>();
            long totalSamples = 0L;
            double tOffsetMs = 0.0;

            long[][] chunks = item.phonemeIds;
            float[] speeds = item.phonemeSpeeds;
            List<List<ReadAloudQueueEngine.KokoroWordSpanSpec>> spans = item.phonemeSpans;

            for (int c = 0; c < chunks.length; c++) {
                if (planGeneration.get() != myPlanGen) return 0L;
                long[] ids = chunks[c];
                if (ids == null || ids.length == 0) continue;

                float speed = (speeds != null && c < speeds.length) ? speeds[c] : 1.0f;
                float[] style = modelStore.styleRow(voiceId, ids.length);
                KokoroInference.SynthChunkResult res = inference.synthesize(ids, style, speed);
                if (planGeneration.get() != myPlanGen) return 0L;

                validateFiniteAndAudible(res.waveform);
                appendPcm16(res.waveform, pcmOut);
                totalSamples += res.waveform.length;

                if (spans != null && c < spans.size() && res.duration != null && res.duration.length >= 2) {
                    appendWordMarks(spans.get(c), res.duration, tOffsetMs, marks);
                }
                tOffsetMs += res.waveform.length / 24.0;
            }

            if (totalSamples == 0L) {
                throw new IllegalStateException("Kokoro produced 0 samples");
            }

            byte[] wavBytes = encodeMonoPcm16Wav(pcmOut.toByteArray(), KokoroModelStore.SAMPLE_RATE);
            AtomicFiles.writeAtomicFile(wavFile, wavBytes);
            pruneSpeechCacheLru(speechCacheDir, MAX_SPEECH_CACHE_BYTES);

            long durationMs = Math.round((totalSamples * 1000.0) / KokoroModelStore.SAMPLE_RATE);
            double synthMs = (System.nanoTime() - t0) / 1_000_000.0;
            recordRtfSample(synthMs / Math.max(100.0, (double) durationMs));

            if (planGeneration.get() != myPlanGen) return 0L;
            callback.attachAudio(item.id, wavFile.getAbsolutePath(), durationMs, marks);
            return durationMs;
        } catch (KokoroInference.SelfTestException ste) {
            synchronized (failedInPlan) {
                failedInPlan.add(item.id + "@" + voiceId);
            }
            callback.onSynthFailed(item.id, "model-selftest", ste.getMessage() != null ? ste.getMessage() : "Self-test failed");
            return 0L;
        } catch (Exception e) {
            if (planGeneration.get() != myPlanGen) return 0L;
            synchronized (failedInPlan) {
                failedInPlan.add(item.id + "@" + voiceId);
            }
            callback.onSynthFailed(
                item.id,
                "speech-unavailable",
                e.getMessage() != null ? e.getMessage() : "Kokoro synthesis failed"
            );
            return 0L;
        }
    }

    private void recordRtfSample(double sampleRtf) {
        if (!Double.isFinite(sampleRtf) || sampleRtf < 0.0) return;
        rtfSamples += 1;
        double alpha = 2.0 / (RTF_EMA_WINDOW + 1.0);
        rtfEma = (rtfSamples == 1) ? sampleRtf : (rtfEma * (1.0 - alpha) + sampleRtf * alpha);
        if (!slowEmittedForVoice && rtfSamples >= 3 && rtfEma >= 0.9) {
            slowEmittedForVoice = true;
            callback.onEngineSlow(rtfEma);
        }
    }

    public double getRtfEma() {
        return rtfEma;
    }

    static void validateFiniteAndAudible(float[] waveform) throws IOException {
        if (waveform == null || waveform.length == 0) {
            throw new IOException("Kokoro waveform is empty");
        }
        float peak = 0f;
        for (float s : waveform) {
            if (Float.isNaN(s) || Float.isInfinite(s)) {
                throw new IOException("Kokoro waveform contains NaN/Infinity");
            }
            float a = Math.abs(s);
            if (a > peak) peak = a;
        }
        if (peak < 1e-3f) {
            throw new IOException("Kokoro waveform is silent (peak=" + peak + ")");
        }
    }

    private static void appendPcm16(float[] samples, ByteArrayOutputStream out) {
        byte[] buf = new byte[samples.length * 2];
        int p = 0;
        for (float s : samples) {
            float clamped = Math.max(-1.0f, Math.min(1.0f, s));
            short pcm = (short) (clamped < 0f ? Math.round(clamped * 32768f) : Math.round(clamped * 32767f));
            buf[p++] = (byte) (pcm & 0xff);
            buf[p++] = (byte) ((pcm >>> 8) & 0xff);
        }
        out.write(buf, 0, buf.length);
    }

    static byte[] encodeMonoPcm16Wav(byte[] pcm16Bytes, int sampleRate) {
        int dataBytes = pcm16Bytes.length;
        ByteBuffer hdr = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        hdr.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        hdr.putInt(36 + dataBytes);
        hdr.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        hdr.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        hdr.putInt(16);
        hdr.putShort((short) 1); // PCM
        hdr.putShort((short) 1); // mono
        hdr.putInt(sampleRate);
        hdr.putInt(sampleRate * 2);
        hdr.putShort((short) 2);
        hdr.putShort((short) 16);
        hdr.put("data".getBytes(StandardCharsets.US_ASCII));
        hdr.putInt(dataBytes);

        byte[] wav = new byte[44 + dataBytes];
        System.arraycopy(hdr.array(), 0, wav, 0, 44);
        System.arraycopy(pcm16Bytes, 0, wav, 44, dataBytes);
        return wav;
    }

    private static void appendWordMarks(
        @Nullable List<ReadAloudQueueEngine.KokoroWordSpanSpec> spans,
        long[] paddedDurations,
        double chunkOffsetMs,
        List<ReadAloudQueueEngine.WordMarkSpec> out
    ) {
        if (spans == null || spans.isEmpty() || paddedDurations.length < 2) return;
        double[] prefixFrames = new double[paddedDurations.length + 1];
        for (int i = 0; i < paddedDurations.length; i++) {
            long d = paddedDurations[i];
            prefixFrames[i + 1] = prefixFrames[i] + (d > 0L ? (double) d : 0.0);
        }
        int maxUnpadded = Math.max(0, paddedDurations.length - 2);
        for (ReadAloudQueueEngine.KokoroWordSpanSpec sp : spans) {
            int t0 = Math.max(0, Math.min(maxUnpadded, sp.t0));
            int t1 = Math.max(t0, Math.min(maxUnpadded, sp.t1));
            double startFrames = prefixFrames[t0 + 1];
            long timeMs = Math.round(chunkOffsetMs + startFrames * 25.0);
            out.add(new ReadAloudQueueEngine.WordMarkSpec(sp.c0, sp.c1, timeMs));
        }
    }

    private static long estimateWavDurationMs(long fileLengthBytes) {
        long pcmBytes = Math.max(0L, fileLengthBytes - 44L);
        return Math.round((pcmBytes * 1000.0) / (KokoroModelStore.SAMPLE_RATE * 2.0));
    }

    static String computeCacheKey(String voiceId, ReadAloudQueueEngine.UtteranceItem item) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        StringBuilder sb = new StringBuilder();
        sb.append(KokoroModelStore.DEFAULT_VARIANT)
            .append('|')
            .append(voiceId)
            .append("|g2p")
            .append(G2P_VERSION)
            .append('|');
        if (item.phonemeIds != null) {
            for (int c = 0; c < item.phonemeIds.length; c++) {
                if (c > 0) sb.append(';');
                sb.append(Arrays.toString(item.phonemeIds[c]));
            }
        }
        if (item.phonemeSpeeds != null) {
            sb.append('|').append(Arrays.toString(item.phonemeSpeeds));
        }
        byte[] digest = md.digest(sb.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(String.format(Locale.US, "%02x", b & 0xff));
        }
        return hex.toString();
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
                if (f.delete()) total -= len;
            }
        }
    }
}
