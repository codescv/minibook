package dev.minibook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executor;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class KokoroSynthQueueTest {
    private File tempRoot;
    private File speechCacheDir;
    private KokoroModelStore modelStore;

    @Before
    public void setUp() throws Exception {
        tempRoot = Files.createTempDirectory("minibook-kokoro-queue-").toFile();
        speechCacheDir = new File(tempRoot, "cache/speech");
        speechCacheDir.mkdirs();
        modelStore = new KokoroModelStore(tempRoot);

        // Seed valid voice file zf_001.bin (522,240 bytes)
        ByteBuffer bb = ByteBuffer.allocate(KokoroModelStore.VOICE_BIN_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < KokoroModelStore.VOICE_ROWS * KokoroModelStore.VOICE_DIM; i++) {
            bb.putFloat(0.1f);
        }
        File vf = modelStore.resolveInModelJail(KokoroModelStore.MODEL_ID, "voices/zf_001.bin");
        AtomicFiles.writeAtomicFile(vf, bb.array());
    }

    @After
    public void tearDown() {
        AtomicFiles.deleteRecursively(tempRoot);
    }

    private static final class FakeKokoroInference implements KokoroInference {
        final List<long[]> seenIds = new ArrayList<>();
        boolean returnNaN = false;
        boolean failSelfTest = false;
        long artificialDelayMs = 0L;
        int cancelCount = 0;

        @Override
        public void ensureReady(KokoroModelStore store) throws Exception {
            if (failSelfTest) {
                throw new SelfTestException("Synthetic self-test failure");
            }
        }

        @Override
        public SynthChunkResult synthesize(long[] unpaddedIds, float[] style256, float speed) throws Exception {
            seenIds.add(unpaddedIds);
            if (artificialDelayMs > 0L) {
                Thread.sleep(artificialDelayMs);
            }
            // Produce 24000 samples (1.0s) or 12000 samples (0.5s)
            float[] wave = new float[12_000];
            if (returnNaN) {
                wave[0] = Float.NaN;
            } else {
                for (int i = 0; i < wave.length; i++) {
                    wave[i] = (float) Math.sin(i * 0.05) * 0.4f;
                }
            }
            long[] dur = new long[unpaddedIds.length + 2];
            Arrays.fill(dur, 2L);
            return new SynthChunkResult(wave, dur);
        }

        @Override
        public void cancel() {
            cancelCount++;
        }

        @Override
        public void close() {}
    }

    @Test
    public void enforces12Item45SecondLookaheadSkipsMissingIdsRejectsNaNAndEmitsSlowRtf() throws Exception {
        FakeKokoroInference fakeInf = new FakeKokoroInference();
        List<String> attachedIds = new ArrayList<>();
        List<String> failedIds = new ArrayList<>();
        List<Double> slowRtfs = new ArrayList<>();

        Executor directExecutor = Runnable::run;
        KokoroSynthQueue queueWorker = new KokoroSynthQueue(
            modelStore,
            fakeInf,
            speechCacheDir,
            new KokoroSynthQueue.QueueCallback() {
                @Override
                public void attachAudio(String utteranceId, String wavPath, long durationMs, List<ReadAloudQueueEngine.WordMarkSpec> marks) {
                    attachedIds.add(utteranceId + ":" + durationMs + ":" + new File(wavPath).exists());
                }

                @Override
                public void onSynthFailed(String utteranceId, String errorCode, String message) {
                    failedIds.add(utteranceId + ":" + errorCode);
                }

                @Override
                public void onEngineSlow(double rtf) {
                    slowRtfs.add(rtf);
                }
            },
            directExecutor
        );

        // Build 16 utterances starting at index 0: item 1 has null phonemeIds (skipped),
        // items 0, 2..14 have phonemeIds -> lookahead cap = 12 items from index 0 (0..11)
        List<ReadAloudQueueEngine.UtteranceItem> items = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            long[][] ids = (i == 1) ? null : new long[][] { { 73L, 127L, 172L, (long) (i + 10) } };
            items.add(new ReadAloudQueueEngine.UtteranceItem(
                "u_" + i,
                0,
                i * 10,
                i * 10 + 9,
                i,
                "Text " + i,
                "zh-CN",
                200L,
                ids,
                new float[] { 1.1f },
                null
            ));
        }

        ReadAloudQueueEngine.VoiceSpec voice = new ReadAloudQueueEngine.VoiceSpec("kokoro", "zf_001", null, null);
        queueWorker.onPlan(items, 0, voice, 1);

        // 12-item window [0..11] minus item 1 (null ids) = 11 synthesized utterances
        assertEquals(11, attachedIds.size());
        assertTrue(attachedIds.get(0).startsWith("u_0:500:true"));
        assertFalse(attachedIds.stream().anyMatch(s -> s.startsWith("u_1:")));
        assertFalse(attachedIds.stream().anyMatch(s -> s.startsWith("u_12:")));

        // Repeat plan for u_0 -> hits WAV disk cache without invoking inference again
        int runsBefore = fakeInf.seenIds.size();
        queueWorker.onPlan(items, 0, voice, 2);
        assertEquals(runsBefore, fakeInf.seenIds.size());

        // NaN waveform rejection
        fakeInf.returnNaN = true;
        ReadAloudQueueEngine.UtteranceItem nanItem = new ReadAloudQueueEngine.UtteranceItem(
            "u_nan",
            0,
            0,
            5,
            0,
            "NaN test",
            "zh-CN",
            200L,
            new long[][] { { 73L, 127L } },
            new float[] { 1.0f },
            null
        );
        queueWorker.onPlan(Collections.singletonList(nanItem), 0, voice, 3);
        assertTrue(failedIds.stream().anyMatch(s -> s.startsWith("u_nan:speech-unavailable")));

        // Slow RTF (>= 0.9 over >= 3 samples) triggers engine-slow
        fakeInf.returnNaN = false;
        fakeInf.artificialDelayMs = 520L; // > 500ms audio => RTF > 1.0
        List<ReadAloudQueueEngine.UtteranceItem> slowItems = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            slowItems.add(new ReadAloudQueueEngine.UtteranceItem(
                "u_slow_" + i,
                0,
                i,
                i + 1,
                i,
                "Slow " + i,
                "zh-CN",
                200L,
                new long[][] { { 88L, 108L, 169L, (long) (i + 30) } },
                new float[] { 1.0f },
                null
            ));
        }
        queueWorker.onPlan(slowItems, 0, new ReadAloudQueueEngine.VoiceSpec("kokoro", "zf_002", null, null), 4);
        // zf_002 isn't on disk, so test with zf_001 on fresh queue
        KokoroSynthQueue slowQueue = new KokoroSynthQueue(
            modelStore,
            fakeInf,
            speechCacheDir,
            new KokoroSynthQueue.QueueCallback() {
                @Override
                public void attachAudio(String utteranceId, String wavPath, long durationMs, List<ReadAloudQueueEngine.WordMarkSpec> marks) {}
                @Override
                public void onSynthFailed(String utteranceId, String errorCode, String message) {}
                @Override
                public void onEngineSlow(double rtf) {
                    slowRtfs.add(rtf);
                }
            },
            directExecutor
        );
        slowQueue.onPlan(slowItems, 0, voice, 1);
        assertEquals(1, slowRtfs.size());
        assertTrue(slowRtfs.get(0) >= 0.9);
    }

    @Test
    public void queueEngineHandlesKokoroMissingIdsNonStickyAnd8sLocalTimeoutIndependentOfNetwork() throws Exception {
        // Test ReadAloudQueueEngine directly with offline network + fake LocalSynth
        final long[] now = { 10_000L };
        final List<Runnable> timers = new ArrayList<>();
        final List<Long> timerDelays = new ArrayList<>();
        ReadAloudQueueEngine.Scheduler sched = new ReadAloudQueueEngine.Scheduler() {
            @Override
            public long nowMs() { return now[0]; }
            @Override
            public ReadAloudQueueEngine.CancelToken postDelayed(long delayMs, Runnable task) {
                timerDelays.add(delayMs);
                timers.add(task);
                return () -> timers.remove(task);
            }
        };

        final List<String> spoken = new ArrayList<>();
        ReadAloudQueueEngine.TtsBackend fakeTts = new ReadAloudQueueEngine.TtsBackend() {
            ReadAloudQueueEngine.BackendCallback cb;
            @Override
            public void speak(ReadAloudQueueEngine.UtteranceItem item, String voiceId, String enginePkg, float rate, ReadAloudQueueEngine.BackendCallback callback) {
                spoken.add(item.id);
                cb = callback;
                callback.onStarted();
                callback.onCompleted();
            }
            @Override
            public void playSilence(long durationMs, Runnable onDone) { onDone.run(); }
            @Override
            public void stop() {}
        };
        final List<String> played = new ArrayList<>();
        ReadAloudQueueEngine.FileBackend fakeFile = new ReadAloudQueueEngine.FileBackend() {
            @Override
            public void playFile(ReadAloudQueueEngine.UtteranceItem item, ReadAloudQueueEngine.AttachedAudioSpec audio, float rate, ReadAloudQueueEngine.BackendCallback callback) {
                played.add(item.id);
                callback.onStarted();
                callback.onCompleted();
            }
            @Override
            public void playSilence(long durationMs, Runnable onDone) { onDone.run(); }
            @Override
            public void startBufferingKeepAlive() {}
            @Override
            public void stop() {}
            @Override
            public void setRate(float rate) {}
        };

        final int[] planCalls = { 0 };
        final int[] cancelCalls = { 0 };
        ReadAloudQueueEngine.LocalSynth fakeLocal = new ReadAloudQueueEngine.LocalSynth() {
            @Override
            public void onPlan(List<ReadAloudQueueEngine.UtteranceItem> queue, int currentIndex, ReadAloudQueueEngine.VoiceSpec voice, int generation) {
                planCalls[0]++;
            }
            @Override
            public void cancelAll() {
                cancelCalls[0]++;
            }
        };

        final List<String> events = new ArrayList<>();
        ReadAloudQueueEngine engine = new ReadAloudQueueEngine(
            sched,
            () -> false, // OFFLINE!
            fakeTts,
            fakeFile,
            null,
            new ReadAloudQueueEngine.EventListener() {
                @Override
                public void onEvent(String eventName, JSONObject payload) {
                    events.add(eventName + ":" + payload.toString());
                }
                @Override
                public void onAudibleChanged(boolean audible) {}
                @Override
                public void onPlayerStateInvalidate() {}
            }
        );
        engine.setLocalSynth(fakeLocal);

        engine.load(new ReadAloudQueueEngine.SessionSpec(
            "b1",
            "Book",
            "Author",
            "Ch1",
            null,
            new ReadAloudQueueEngine.VoiceSpec("kokoro", "zf_001", null, null),
            new ReadAloudQueueEngine.VoiceSpec("system", null, null, null),
            1.0f
        ));

        // Parse UtteranceItem from JSON with phonemeIds / phonemeSpeeds
        JSONObject u0Json = new JSONObject();
        u0Json.put("id", "u0");
        u0Json.put("section", 0);
        u0Json.put("start", 0);
        u0Json.put("end", 5);
        u0Json.put("blockIndex", 0);
        u0Json.put("text", "Unannotated.");
        u0Json.put("lang", "ja");
        u0Json.put("pauseAfterMs", 100);

        JSONObject u1Json = new JSONObject();
        u1Json.put("id", "u1");
        u1Json.put("section", 0);
        u1Json.put("start", 6);
        u1Json.put("end", 12);
        u1Json.put("blockIndex", 0); // SAME paragraph as u0!
        u1Json.put("text", "你好。");
        u1Json.put("lang", "zh-CN");
        u1Json.put("pauseAfterMs", 100);
        u1Json.put("phonemeIds", new JSONArray().put(new JSONArray().put(73).put(127).put(172).put(4)));
        u1Json.put("phonemeSpeeds", new JSONArray().put(1.1));

        ReadAloudQueueEngine.UtteranceItem u0 = ReadAloudQueueEngine.UtteranceItem.fromJson(u0Json);
        ReadAloudQueueEngine.UtteranceItem u1 = ReadAloudQueueEngine.UtteranceItem.fromJson(u1Json);
        engine.enqueue(Arrays.asList(u0, u1), null);
        assertTrue(planCalls[0] >= 1);

        // u0 has no phonemeIds -> speaks via systemFallback immediately (NON-STICKY!), then u1 in SAME paragraph
        // still enters Kokoro buffering with 8000ms timer (ignoring networkChecker == false)!
        engine.play();
        assertEquals(Collections.singletonList("u0"), spoken);
        assertEquals("buffering", engine.getStatus());
        assertTrue(timerDelays.contains(ReadAloudQueueEngine.LOCAL_SYNTH_FALLBACK_TIMEOUT_MS));
        assertFalse(timerDelays.contains(2_000L));

        // Fire 20s local-synth timer -> falls back with local-synth-timeout
        timers.get(timers.size() - 1).run();
        assertTrue(events.stream().anyMatch(e -> e.contains("local-synth-timeout")));
        engine.stop();
        assertTrue(cancelCalls[0] >= 1);
    }

    @Test
    public void liveSwitchesSystemAndKokoroVoicesInReaderPurgesStaleAudioAndSeparatesVariantCacheKeys() throws Exception {
        // Seed extra curated voices zm_010 & zf_018 with distinct float values so style256[0] identifies the voice!
        for (Object[] entry : new Object[][] { { "zm_010", 0.25f }, { "zf_018", 0.75f } }) {
            String vid = (String) entry[0];
            float val = (Float) entry[1];
            ByteBuffer bb = ByteBuffer.allocate(KokoroModelStore.VOICE_BIN_BYTES).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i < KokoroModelStore.VOICE_ROWS * KokoroModelStore.VOICE_DIM; i++) {
                bb.putFloat(val);
            }
            File vf = modelStore.resolveInModelJail(KokoroModelStore.MODEL_ID, "voices/" + vid + ".bin");
            AtomicFiles.writeAtomicFile(vf, bb.array());
        }

        final List<Float> synthStyleSamples = new ArrayList<>();
        KokoroInference trackingInf = new KokoroInference() {
            @Override
            public void ensureReady(KokoroModelStore store) {}
            @Override
            public SynthChunkResult synthesize(long[] unpaddedIds, float[] style256, float speed) {
                synthStyleSamples.add(style256[0]);
                float[] wave = new float[12_000];
                for (int i = 0; i < wave.length; i++) wave[i] = (float) Math.sin(i * 0.05) * 0.4f;
                long[] dur = new long[unpaddedIds.length + 2];
                Arrays.fill(dur, 2L);
                return new SynthChunkResult(wave, dur);
            }
            @Override
            public void cancel() {}
            @Override
            public void close() {}
        };

        final List<String> spokenSystemIds = new ArrayList<>();
        final List<String> playedWavPaths = new ArrayList<>();
        final List<String> playedUtteranceIds = new ArrayList<>();
        final ReadAloudQueueEngine.BackendCallback[] activeTtsCb = { null };
        final ReadAloudQueueEngine.BackendCallback[] activeFileCb = { null };

        ReadAloudQueueEngine.Scheduler sched = new ReadAloudQueueEngine.Scheduler() {
            @Override
            public long nowMs() { return 10_000L; }
            @Override
            public ReadAloudQueueEngine.CancelToken postDelayed(long delayMs, Runnable task) {
                return () -> {};
            }
        };
        ReadAloudQueueEngine.TtsBackend fakeTts = new ReadAloudQueueEngine.TtsBackend() {
            @Override
            public void speak(ReadAloudQueueEngine.UtteranceItem item, String voiceId, String enginePkg, float rate, ReadAloudQueueEngine.BackendCallback callback) {
                spokenSystemIds.add(item.id);
                activeTtsCb[0] = callback;
                callback.onStarted();
            }
            @Override
            public void playSilence(long durationMs, Runnable onDone) { onDone.run(); }
            @Override
            public void stop() { activeTtsCb[0] = null; }
        };
        ReadAloudQueueEngine.FileBackend fakeFile = new ReadAloudQueueEngine.FileBackend() {
            @Override
            public void playFile(ReadAloudQueueEngine.UtteranceItem item, ReadAloudQueueEngine.AttachedAudioSpec audio, float rate, ReadAloudQueueEngine.BackendCallback callback) {
                playedUtteranceIds.add(item.id);
                playedWavPaths.add(audio.path);
                activeFileCb[0] = callback;
                callback.onStarted();
            }
            @Override
            public void playSilence(long durationMs, Runnable onDone) { onDone.run(); }
            @Override
            public void startBufferingKeepAlive() {}
            @Override
            public void stop() { activeFileCb[0] = null; }
            @Override
            public void setRate(float rate) {}
        };

        final ReadAloudQueueEngine[] engineRef = { null };
        KokoroSynthQueue synthQueue = new KokoroSynthQueue(
            modelStore,
            trackingInf,
            speechCacheDir,
            new KokoroSynthQueue.QueueCallback() {
                @Override
                public void attachAudio(String utteranceId, String wavPath, long durationMs, List<ReadAloudQueueEngine.WordMarkSpec> marks) {
                    engineRef[0].attachAudio(utteranceId, wavPath, durationMs, marks);
                }
                @Override
                public void onSynthFailed(String utteranceId, String errorCode, String message) {}
                @Override
                public void onEngineSlow(double rtf) {}
            },
            Runnable::run
        );

        ReadAloudQueueEngine engine = new ReadAloudQueueEngine(
            sched,
            () -> true,
            fakeTts,
            fakeFile,
            null,
            new ReadAloudQueueEngine.EventListener() {
                @Override
                public void onEvent(String eventName, JSONObject payload) {}
                @Override
                public void onAudibleChanged(boolean audible) {}
                @Override
                public void onPlayerStateInvalidate() {}
            }
        );
        engineRef[0] = engine;
        engine.setLocalSynth(synthQueue);

        // 1. Start on System voice at u0 -> finish u0 -> now speaking u1!
        engine.load(new ReadAloudQueueEngine.SessionSpec(
            "b1", "Book", "Author", "Ch1", null,
            new ReadAloudQueueEngine.VoiceSpec("system", null, null, null),
            new ReadAloudQueueEngine.VoiceSpec("system", null, null, null),
            1.0f
        ));
        List<ReadAloudQueueEngine.UtteranceItem> rawQueue = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            rawQueue.add(new ReadAloudQueueEngine.UtteranceItem(
                "u" + i, 0, i * 10, i * 10 + 8, 0, "句子" + i, "zh-CN", 100L, null, null, null
            ));
        }
        engine.enqueue(rawQueue, null);
        engine.play();
        assertEquals(Collections.singletonList("u0"), spokenSystemIds);
        activeTtsCb[0].onCompleted(); // advances to u1!
        assertEquals(Arrays.asList("u0", "u1"), spokenSystemIds);

        // 2. Live switch System -> Kokoro zf_001 on u1 (setVoice FIRST, then enqueue full slice from u1 with phonemeIds)
        List<ReadAloudQueueEngine.UtteranceItem> annotatedFromU1 = new ArrayList<>();
        for (int i = 1; i < 6; i++) {
            annotatedFromU1.add(new ReadAloudQueueEngine.UtteranceItem(
                "u" + i, 0, i * 10, i * 10 + 8, 0, "句子" + i, "zh-CN", 100L,
                new long[][] { { 73L, 127L, 172L, (long) (10 + i) } },
                new float[] { 1.0f },
                null
            ));
        }
        engine.setVoice(new ReadAloudQueueEngine.VoiceSpec("kokoro", "zf_001", null, null));
        engine.enqueue(annotatedFromU1, "u1");
        // Must play u1 (NOT clobbered back to u0!) with zf_001 WAV!
        assertEquals(Collections.singletonList("u1"), playedUtteranceIds);
        String zf001WavPath = playedWavPaths.get(0);
        assertEquals(0.1f, synthStyleSamples.get(0), 1e-5f);

        // 3. While all 5 lookahead WAVs for zf_001 are ALREADY attached on u1..u5, switch Kokoro zf_001 -> Kokoro zm_010!
        synthStyleSamples.clear();
        engine.setVoice(new ReadAloudQueueEngine.VoiceSpec("kokoro", "zm_010", null, null));
        assertEquals(Arrays.asList("u1", "u1"), playedUtteranceIds);
        String zm010WavPath = playedWavPaths.get(1);
        assertFalse("Must NOT replay stale zf_001 WAV after switching to zm_010!", zf001WavPath.equals(zm010WavPath));
        assertEquals(0.25f, synthStyleSamples.get(0), 1e-5f);

        // 4. Pause -> switch zm_010 -> zf_018 while paused -> press Play -> plays zf_018 immediately on u1!
        engine.pause();
        synthStyleSamples.clear();
        engine.setVoice(new ReadAloudQueueEngine.VoiceSpec("kokoro", "zf_018", null, null));
        assertEquals(0.75f, synthStyleSamples.get(0), 1e-5f);
        engine.play();
        assertEquals(Arrays.asList("u1", "u1", "u1"), playedUtteranceIds);
        String zf018WavPath = playedWavPaths.get(2);
        assertFalse(zm010WavPath.equals(zf018WavPath));

        // 5. Verify variant-keyed cache keys (`onnx-q8` vs `onnx-fp32`) never collide!
        String keyQ8 = KokoroSynthQueue.computeCacheKey("onnx-q8", "zf_018", annotatedFromU1.get(0));
        String keyFp32 = KokoroSynthQueue.computeCacheKey("onnx-fp32", "zf_018", annotatedFromU1.get(0));
        assertFalse("onnx-q8 and onnx-fp32 cache keys MUST differ", keyQ8.equals(keyFp32));
    }
}
