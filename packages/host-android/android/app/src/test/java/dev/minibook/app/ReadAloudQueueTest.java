package dev.minibook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class ReadAloudQueueTest {

    private static final class ManualScheduler implements ReadAloudQueueEngine.Scheduler {
        long now = 1_000_000L;
        final List<ScheduledTask> tasks = new ArrayList<>();

        static final class ScheduledTask {
            final long runAt;
            final Runnable runnable;
            boolean cancelled = false;

            ScheduledTask(long runAt, Runnable runnable) {
                this.runAt = runAt;
                this.runnable = runnable;
            }
        }

        @Override
        public long nowMs() {
            return now;
        }

        @Override
        public ReadAloudQueueEngine.CancelToken postDelayed(long delayMs, Runnable task) {
            final ScheduledTask st = new ScheduledTask(now + Math.max(0L, delayMs), task);
            tasks.add(st);
            return () -> st.cancelled = true;
        }

        void advanceBy(long deltaMs) {
            long target = now + deltaMs;
            while (true) {
                ScheduledTask next = null;
                for (ScheduledTask t : tasks) {
                    if (!t.cancelled && t.runAt <= target) {
                        if (next == null || t.runAt < next.runAt) {
                            next = t;
                        }
                    }
                }
                if (next == null) break;
                now = next.runAt;
                tasks.remove(next);
                next.runnable.run();
            }
            now = target;
        }
    }

    private static final class FakeTtsBackend implements ReadAloudQueueEngine.TtsBackend {
        final List<String> spokenIds = new ArrayList<>();
        ReadAloudQueueEngine.BackendCallback activeCb;
        Runnable silenceDone;

        @Override
        public void speak(
            ReadAloudQueueEngine.UtteranceItem item,
            String voiceId,
            String enginePkg,
            float rate,
            ReadAloudQueueEngine.BackendCallback callback
        ) {
            spokenIds.add(item.id);
            activeCb = callback;
            callback.onStarted();
        }

        void finishCurrent() {
            ReadAloudQueueEngine.BackendCallback cb = activeCb;
            activeCb = null;
            if (cb != null) cb.onCompleted();
        }

        @Override
        public void playSilence(long durationMs, Runnable onDone) {
            silenceDone = onDone;
        }

        void finishSilence() {
            Runnable r = silenceDone;
            silenceDone = null;
            if (r != null) r.run();
        }

        @Override
        public void stop() {
            activeCb = null;
            silenceDone = null;
        }
    }

    private static final class FakeFileBackend implements ReadAloudQueueEngine.FileBackend {
        final List<String> playedIds = new ArrayList<>();
        boolean bufferingSilenceActive = false;
        ReadAloudQueueEngine.BackendCallback activeCb;
        Runnable silenceDone;

        @Override
        public void playFile(
            ReadAloudQueueEngine.UtteranceItem item,
            ReadAloudQueueEngine.AttachedAudioSpec audio,
            float rate,
            ReadAloudQueueEngine.BackendCallback callback
        ) {
            bufferingSilenceActive = false;
            playedIds.add(item.id);
            activeCb = callback;
            callback.onStarted();
        }

        void finishCurrent() {
            ReadAloudQueueEngine.BackendCallback cb = activeCb;
            activeCb = null;
            if (cb != null) cb.onCompleted();
        }

        @Override
        public void playSilence(long durationMs, Runnable onDone) {
            bufferingSilenceActive = false;
            silenceDone = onDone;
        }

        void finishSilence() {
            Runnable r = silenceDone;
            silenceDone = null;
            if (r != null) r.run();
        }

        @Override
        public void startBufferingKeepAlive() {
            bufferingSilenceActive = true;
        }

        @Override
        public void stop() {
            bufferingSilenceActive = false;
            activeCb = null;
            silenceDone = null;
        }

        @Override
        public void setRate(float rate) {}
    }

    private File tempRoot;
    private ManualScheduler scheduler;
    private boolean online;
    private FakeTtsBackend ttsBackend;
    private FakeFileBackend fileBackend;
    private SpeechJournal journal;
    private List<String> emittedEvents;
    private ReadAloudQueueEngine engine;

    @Before
    public void setUp() throws Exception {
        tempRoot = Files.createTempDirectory("minibook-queue-test-").toFile();
        scheduler = new ManualScheduler();
        online = true;
        ttsBackend = new FakeTtsBackend();
        fileBackend = new FakeFileBackend();
        journal = new SpeechJournal(tempRoot);
        emittedEvents = new ArrayList<>();

        engine = new ReadAloudQueueEngine(
            scheduler,
            () -> online,
            ttsBackend,
            fileBackend,
            journal,
            new ReadAloudQueueEngine.EventListener() {
                @Override
                public void onEvent(String eventName, JSONObject payload) {
                    emittedEvents.add(eventName + ":" + payload.toString());
                }

                @Override
                public void onAudibleChanged(boolean audible) {}

                @Override
                public void onPlayerStateInvalidate() {}
            }
        );
    }

    @After
    public void tearDown() {
        AtomicFiles.deleteRecursively(tempRoot);
    }

    @Test
    public void enforces8sOnlineAndParagraphStickySystemFallbackThenRecoversNextParagraph() throws Exception {
        // Seed state.json with an existing bookmark to ensure SpeechJournal preserves bookmarks!
        JSONObject initialState = new JSONObject();
        JSONObject initialPos = new JSONObject();
        initialPos.put("section", 0);
        initialPos.put("offset", 0);
        initialPos.put("fraction", 0.42);
        initialPos.put("snippet", "Initial");
        initialPos.put("updatedAt", 500L);
        initialState.put("position", initialPos);
        JSONArray bookmarks = new JSONArray();
        JSONObject bm = new JSONObject();
        bm.put("id", "bm_1");
        bm.put("section", 0);
        bm.put("offset", 10);
        bookmarks.put(bm);
        initialState.put("bookmarks", bookmarks);
        AtomicFiles.writeAtomic(
            tempRoot,
            "books/b_novel/state.json",
            initialState.toString().getBytes(StandardCharsets.UTF_8)
        );

        ReadAloudQueueEngine.SessionSpec session = new ReadAloudQueueEngine.SessionSpec(
            "b_novel",
            "Two Cities",
            "Dickens",
            "Chapter 1",
            null,
            new ReadAloudQueueEngine.VoiceSpec("edge", "en-US-AvaMultilingualNeural", null, null),
            new ReadAloudQueueEngine.VoiceSpec("system", null, null, null),
            1.0f
        );
        engine.load(session);

        // Paragraph 0 has two sentences (u1, u2); Paragraph 1 has one sentence (u3) with attached audio
        ReadAloudQueueEngine.UtteranceItem u1 =
            new ReadAloudQueueEngine.UtteranceItem("0:0-20", 0, 0, 20, 0, "First sentence.", "en", 200L);
        ReadAloudQueueEngine.UtteranceItem u2 =
            new ReadAloudQueueEngine.UtteranceItem("0:21-45", 0, 21, 45, 0, "Second in same para.", "en", 450L);
        ReadAloudQueueEngine.UtteranceItem u3 =
            new ReadAloudQueueEngine.UtteranceItem("0:46-70", 0, 46, 70, 1, "New paragraph ready!", "en", 450L);

        engine.enqueue(Arrays.asList(u1, u2, u3), null);
        // Attach audio to u2 and u3, leaving u1 unattached to trigger 8s timeout!
        engine.attachAudio("0:21-45", "/cache/u2.mp3", 1200L, Collections.emptyList());
        engine.attachAudio("0:46-70", "/cache/u3.mp3", 1300L, Collections.emptyList());

        engine.play();
        assertEquals("buffering", engine.getStatus());
        assertTrue(engine.isAudible());
        assertTrue(fileBackend.bufferingSilenceActive);

        // At 7.9s still buffering
        scheduler.advanceBy(7_900L);
        assertEquals("buffering", engine.getStatus());
        assertTrue(ttsBackend.spokenIds.isEmpty());

        // At 8.0s -> falls back to system voice for u1!
        scheduler.advanceBy(100L);
        assertEquals("playing", engine.getStatus());
        assertEquals(Collections.singletonList("0:0-20"), ttsBackend.spokenIds);
        assertTrue(emittedEvents.stream().anyMatch(e -> e.startsWith("speech-fallback:")));

        // Verify SpeechJournal wrote both checkpoint and books/b_novel/state.json (preserving bookmarks & fraction)
        SpeechJournal.Checkpoint cp = journal.readCheckpoint();
        assertNotNull(cp);
        assertEquals("b_novel", cp.bookId);
        assertEquals(0, cp.offset);
        File stateFile = new File(tempRoot, "books/b_novel/state.json");
        JSONObject updatedState = new JSONObject(
            new String(Files.readAllBytes(stateFile.toPath()), StandardCharsets.UTF_8)
        );
        assertEquals(1, updatedState.getJSONArray("bookmarks").length());
        assertEquals(0.42, updatedState.getJSONObject("position").getDouble("fraction"), 1e-6);

        // Finish u1 + inter-sentence pause -> u2 is in SAME paragraph (blockIndex == 0),
        // so paragraph-sticky rule MUST keep using system TTS even though u2 has audio attached!
        ttsBackend.finishCurrent();
        assertEquals("playing", engine.getStatus()); // stays 'playing' across pause!
        ttsBackend.finishSilence();
        assertEquals(Arrays.asList("0:0-20", "0:21-45"), ttsBackend.spokenIds);
        assertTrue(fileBackend.playedIds.isEmpty());

        // Finish u2 + paragraph pause -> u3 is in NEW paragraph (blockIndex == 1) and has audio attached,
        // so engine MUST smoothly return to synthesized FileBackend!
        ttsBackend.finishCurrent();
        ttsBackend.finishSilence();
        assertEquals(Collections.singletonList("0:46-70"), fileBackend.playedIds);
        assertFalse(engine.buildStateJson().getBoolean("usingFallback"));
    }

    @Test
    public void fallsBackIn2SecondsWhenOfflineAndHonoursSleepTimerAtSentenceBoundary() throws Exception {
        online = false;
        ReadAloudQueueEngine.SessionSpec session = new ReadAloudQueueEngine.SessionSpec(
            "b_offline",
            "Offline Book",
            "Author",
            "Ch 1",
            null,
            new ReadAloudQueueEngine.VoiceSpec("openai", "alloy", null, "tts-1"),
            new ReadAloudQueueEngine.VoiceSpec("system", null, null, null),
            1.0f
        );
        engine.load(session);

        ReadAloudQueueEngine.UtteranceItem u1 =
            new ReadAloudQueueEngine.UtteranceItem("0:0-15", 0, 0, 15, 0, "Sentence one.", "en", 200L);
        ReadAloudQueueEngine.UtteranceItem u2 =
            new ReadAloudQueueEngine.UtteranceItem("0:16-30", 0, 16, 30, 0, "Sentence two.", "en", 200L);
        engine.enqueue(Arrays.asList(u1, u2), null);

        engine.setSleepTimer("minutes", 1);
        engine.play();
        assertEquals("buffering", engine.getStatus());

        // Offline -> falls back after 2,000ms instead of 8,000ms!
        scheduler.advanceBy(2_000L);
        assertEquals("playing", engine.getStatus());
        assertEquals(Collections.singletonList("0:0-15"), ttsBackend.spokenIds);

        // Advance past the 1-minute sleep deadline WHILE u1 is mid-sentence:
        // speech MUST NOT cut off mid-sentence; it waits for u1 to finish, then pauses!
        scheduler.advanceBy(60_000L);
        assertEquals("playing", engine.getStatus());

        ttsBackend.finishCurrent();
        assertEquals("paused", engine.getStatus());
        assertFalse(engine.isAudible());
        assertTrue(
            emittedEvents.stream().anyMatch(
                e -> e.startsWith("speech-ended:") && e.contains("sleep-timer")
            )
        );
    }

    @Test
    public void autoContinuesFromEndedOfBufferOnEnqueueAndAdvancesWhenPausedInSilence() throws Exception {
        ReadAloudQueueEngine.SessionSpec session = new ReadAloudQueueEngine.SessionSpec(
            "b_cont",
            "Book",
            "Author",
            "Ch 1",
            null,
            new ReadAloudQueueEngine.VoiceSpec("system", null, null, null),
            null,
            1.0f
        );
        engine.load(session);

        ReadAloudQueueEngine.UtteranceItem u1 =
            new ReadAloudQueueEngine.UtteranceItem("0:0-10", 0, 0, 10, 0, "One.", "en", 300L);
        engine.enqueue(Collections.singletonList(u1), null);
        engine.play();
        assertEquals(Collections.singletonList("0:0-10"), ttsBackend.spokenIds);

        // u1 finishes with no next item -> ended-of-buffer
        ttsBackend.finishCurrent();
        assertEquals("ended-of-buffer", engine.getStatus());

        // Late top-up from awake JS -> automatically advances to u2 and continues speaking!
        ReadAloudQueueEngine.UtteranceItem u2 =
            new ReadAloudQueueEngine.UtteranceItem("0:11-20", 0, 11, 20, 0, "Two.", "en", 300L);
        ReadAloudQueueEngine.UtteranceItem u3 =
            new ReadAloudQueueEngine.UtteranceItem("0:21-30", 0, 21, 30, 0, "Three.", "en", 300L);
        engine.enqueue(Arrays.asList(u2, u3), null);
        assertEquals("playing", engine.getStatus());
        assertEquals(Arrays.asList("0:0-10", "0:11-20"), ttsBackend.spokenIds);

        // u2 finishes and enters inter-utterance silence; pausing during silence advances to u3
        // so resume speaks u3 rather than repeating u2!
        ttsBackend.finishCurrent();
        assertEquals("playing", engine.getStatus());
        engine.pause();
        assertEquals("paused", engine.getStatus());
        assertEquals("0:21-30", engine.buildStateJson().getString("currentUtteranceId"));

        engine.play();
        assertEquals(Arrays.asList("0:0-10", "0:11-20", "0:21-30"), ttsBackend.spokenIds);

        // Verify queue-low emitted once per threshold crossing, not spammed on every utterance
        long queueLowCount = emittedEvents.stream().filter(e -> e.startsWith("queue-low:")).count();
        assertTrue("Expected bounded queue-low emissions, got " + queueLowCount, queueLowCount <= 2);
    }

    @Test
    public void systemTtsBackendNormalizesCmnYueTagsAndDeduplicatesGoogleLocalNetworkPairs() throws Exception {
        assertEquals("zh-CN", SystemTtsBackend.normalizeLanguageTag("zh"));
        assertEquals("zh-CN", SystemTtsBackend.normalizeLanguageTag("cmn-Hans-CN"));
        assertEquals("zh-TW", SystemTtsBackend.normalizeLanguageTag("cmn-Hant-TW"));
        assertEquals("zh-HK", SystemTtsBackend.normalizeLanguageTag("yue-Hant-HK"));
        assertEquals("en-US", SystemTtsBackend.normalizeLanguageTag("en"));

        List<SystemTtsBackend.RawVoiceEntry> googleEntries = Arrays.asList(
            new SystemTtsBackend.RawVoiceEntry("cmn-cn-x-ccc-network", "cmn-Hans-CN", 400, false),
            new SystemTtsBackend.RawVoiceEntry("cmn-cn-x-ccc-local", "cmn-Hans-CN", 400, true),
            new SystemTtsBackend.RawVoiceEntry("en-us-x-sfg-local", "en-US", 500, true)
        );
        JSONArray googleOut = SystemTtsBackend.filterAndDeduplicateEngineVoices(
            "com.google.android.tts",
            "Speech Recognition and Synthesis from Google",
            googleEntries
        );
        assertEquals(2, googleOut.length());
        JSONObject zhVoice = googleOut.getJSONObject(0);
        assertEquals("cmn-cn-x-ccc-local", zhVoice.getString("id"));
        assertEquals("zh-CN", zhVoice.getString("lang"));
        assertTrue(zhVoice.getBoolean("local"));
        assertEquals("enhanced", zhVoice.getString("quality"));

        List<SystemTtsBackend.RawVoiceEntry> multiTtsEntries = Arrays.asList(
            new SystemTtsBackend.RawVoiceEntry("xiaoxiao", "zh-CN", 500, true),
            new SystemTtsBackend.RawVoiceEntry("yunxi", "zh-CN", 500, true)
        );
        JSONArray multiOut = SystemTtsBackend.filterAndDeduplicateEngineVoices(
            "org.nobody.multitts",
            "MultiTTS",
            multiTtsEntries
        );
        assertEquals(2, multiOut.length());
        assertEquals("MultiTTS · xiaoxiao", multiOut.getJSONObject(0).getString("name"));
    }
}
