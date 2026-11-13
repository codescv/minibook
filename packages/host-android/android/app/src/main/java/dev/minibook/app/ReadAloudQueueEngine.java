package dev.minibook.app;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Platform-independent native Read-Aloud queue, 8s/2s paragraph-sticky fallback, inter-sentence
 * pause, and sleep-timer state machine (`ARCHITECTURE.md` §8.3, §8.5, §8.6).
 *
 * Pure Java (depends only on `org.json`), driven on the main thread in `ReadAloudService` and
 * deterministically tested with fake backends & manual scheduler in `ReadAloudQueueTest`.
 */
public final class ReadAloudQueueEngine {
    public static final long ONLINE_FALLBACK_TIMEOUT_MS = 8_000L;
    public static final long OFFLINE_FALLBACK_TIMEOUT_MS = 2_000L;
    public static final long LOCAL_SYNTH_FALLBACK_TIMEOUT_MS = 8_000L;
    public static final int QUEUE_LOW_THRESHOLD = 20;

    public interface LocalSynth {
        void onPlan(List<UtteranceItem> queue, int currentIndex, VoiceSpec voice, int generation);
        void cancelAll();
    }

    public interface CancelToken {
        void cancel();
    }

    public interface Scheduler {
        long nowMs();
        CancelToken postDelayed(long delayMs, Runnable task);
    }

    public interface NetworkChecker {
        boolean isOnline();
    }

    public interface TtsBackend {
        void speak(
            UtteranceItem item,
            @Nullable String voiceId,
            @Nullable String enginePkg,
            float rate,
            BackendCallback callback
        );
        void playSilence(long durationMs, Runnable onDone);
        void stop();
    }

    public interface FileBackend {
        void playFile(
            UtteranceItem item,
            AttachedAudioSpec audio,
            float rate,
            BackendCallback callback
        );
        void playSilence(long durationMs, Runnable onDone);
        void startBufferingKeepAlive();
        void stop();
        void setRate(float rate);
    }

    public interface BackendCallback {
        void onStarted();
        void onWordBoundary(int start, int end, long timeMs);
        void onCompleted();
        void onError(String message);
    }

    public interface EventListener {
        void onEvent(String eventName, JSONObject payload);
        void onAudibleChanged(boolean audible);
        void onPlayerStateInvalidate();
    }

    public static final class VoiceSpec {
        public final String kind; // "system" | "edge" | "openai" | "qwen" | "kokoro"
        @Nullable public final String voiceId;
        @Nullable public final String engine;
        @Nullable public final String model;

        public VoiceSpec(
            String kind,
            @Nullable String voiceId,
            @Nullable String engine,
            @Nullable String model
        ) {
            this.kind = kind;
            this.voiceId = voiceId;
            this.engine = engine;
            this.model = model;
        }

        public static VoiceSpec fromJson(@Nullable JSONObject obj) {
            if (obj == null) {
                return new VoiceSpec("system", null, null, null);
            }
            String kind = obj.optString("kind", "system");
            String voiceId = obj.has("voiceId") && !obj.isNull("voiceId")
                ? obj.optString("voiceId")
                : null;
            String engine = obj.has("engine") && !obj.isNull("engine")
                ? obj.optString("engine")
                : null;
            String model = obj.has("model") && !obj.isNull("model")
                ? obj.optString("model")
                : null;
            return new VoiceSpec(kind, voiceId, engine, model);
        }

        public JSONObject toJson() {
            JSONObject obj = new JSONObject();
            putJson(obj, "kind", kind);
            putJson(obj, "voiceId", voiceId != null ? voiceId : JSONObject.NULL);
            if ("system".equals(kind) && engine != null) {
                putJson(obj, "engine", engine);
            }
            if (("openai".equals(kind) || "qwen".equals(kind)) && model != null) {
                putJson(obj, "model", model);
            }
            return obj;
        }
    }

    public static final class KokoroWordSpanSpec {
        public final int t0;
        public final int t1;
        public final int c0;
        public final int c1;

        public KokoroWordSpanSpec(int t0, int t1, int c0, int c1) {
            this.t0 = t0;
            this.t1 = t1;
            this.c0 = c0;
            this.c1 = c1;
        }
    }

    public static final class WordMarkSpec {
        public final int start;
        public final int end;
        public final long timeMs;

        public WordMarkSpec(int start, int end, long timeMs) {
            this.start = start;
            this.end = end;
            this.timeMs = timeMs;
        }
    }

    public static final class AttachedAudioSpec {
        public final String path;
        public final long durationMs;
        public final List<WordMarkSpec> marks;

        public AttachedAudioSpec(String path, long durationMs, List<WordMarkSpec> marks) {
            this.path = path;
            this.durationMs = durationMs;
            this.marks = marks != null ? marks : Collections.emptyList();
        }
    }

    public static final class UtteranceItem {
        public final String id;
        public final int section;
        public final int start;
        public final int end;
        public final int blockIndex;
        public final String text;
        public final String lang;
        public final long pauseAfterMs;
        @Nullable public final long[][] phonemeIds;
        @Nullable public final float[] phonemeSpeeds;
        @Nullable public final List<List<KokoroWordSpanSpec>> phonemeSpans;
        @Nullable public AttachedAudioSpec audio;

        public UtteranceItem(
            String id,
            int section,
            int start,
            int end,
            int blockIndex,
            String text,
            String lang,
            long pauseAfterMs
        ) {
            this(id, section, start, end, blockIndex, text, lang, pauseAfterMs, null, null, null);
        }

        public UtteranceItem(
            String id,
            int section,
            int start,
            int end,
            int blockIndex,
            String text,
            String lang,
            long pauseAfterMs,
            @Nullable long[][] phonemeIds,
            @Nullable float[] phonemeSpeeds,
            @Nullable List<List<KokoroWordSpanSpec>> phonemeSpans
        ) {
            this.id = id;
            this.section = section;
            this.start = start;
            this.end = end;
            this.blockIndex = blockIndex;
            this.text = text;
            this.lang = lang;
            this.pauseAfterMs = Math.max(0L, pauseAfterMs);
            this.phonemeIds = phonemeIds;
            this.phonemeSpeeds = phonemeSpeeds;
            this.phonemeSpans = phonemeSpans;
        }

        public static UtteranceItem fromJson(JSONObject obj) {
            long[][] parsedIds = parsePhonemeIds(obj.optJSONArray("phonemeIds"));
            float[] parsedSpeeds = parsePhonemeSpeeds(obj.optJSONArray("phonemeSpeeds"));
            List<List<KokoroWordSpanSpec>> parsedSpans = parsePhonemeSpans(obj.optJSONArray("phonemeSpans"));
            return new UtteranceItem(
                obj.optString("id", ""),
                obj.optInt("section", 0),
                obj.optInt("start", 0),
                obj.optInt("end", 0),
                obj.optInt("blockIndex", 0),
                obj.optString("text", ""),
                obj.optString("lang", "en"),
                obj.optLong("pauseAfterMs", 200L),
                parsedIds,
                parsedSpeeds,
                parsedSpans
            );
        }

        @Nullable
        private static long[][] parsePhonemeIds(@Nullable JSONArray arr) {
            if (arr == null || arr.length() == 0) return null;
            long[][] out = new long[arr.length()][];
            for (int c = 0; c < arr.length(); c++) {
                JSONArray chunk = arr.optJSONArray(c);
                if (chunk == null) {
                    out[c] = new long[0];
                } else {
                    long[] ids = new long[chunk.length()];
                    for (int i = 0; i < chunk.length(); i++) {
                        ids[i] = chunk.optLong(i, 0L);
                    }
                    out[c] = ids;
                }
            }
            return out;
        }

        @Nullable
        private static float[] parsePhonemeSpeeds(@Nullable JSONArray arr) {
            if (arr == null || arr.length() == 0) return null;
            float[] out = new float[arr.length()];
            for (int i = 0; i < arr.length(); i++) {
                double v = arr.optDouble(i, 1.0);
                out[i] = (Double.isFinite(v) && v > 0.0) ? (float) v : 1.0f;
            }
            return out;
        }

        @Nullable
        private static List<List<KokoroWordSpanSpec>> parsePhonemeSpans(@Nullable JSONArray arr) {
            if (arr == null || arr.length() == 0) return null;
            List<List<KokoroWordSpanSpec>> out = new ArrayList<>(arr.length());
            for (int c = 0; c < arr.length(); c++) {
                JSONArray chunk = arr.optJSONArray(c);
                if (chunk == null) {
                    out.add(Collections.emptyList());
                    continue;
                }
                List<KokoroWordSpanSpec> spans = new ArrayList<>(chunk.length());
                for (int i = 0; i < chunk.length(); i++) {
                    JSONObject sp = chunk.optJSONObject(i);
                    if (sp != null) {
                        spans.add(new KokoroWordSpanSpec(
                            sp.optInt("t0", 0),
                            sp.optInt("t1", 0),
                            sp.optInt("c0", 0),
                            sp.optInt("c1", 0)
                        ));
                    }
                }
                out.add(spans);
            }
            return out;
        }
    }

    public static final class SessionSpec {
        public final String bookId;
        public final String title;
        public final String author;
        public final String chapterTitle;
        @Nullable public final String coverUrl;
        public VoiceSpec voice;
        @Nullable public final VoiceSpec systemFallback;
        public float rate;

        public SessionSpec(
            String bookId,
            String title,
            String author,
            String chapterTitle,
            @Nullable String coverUrl,
            VoiceSpec voice,
            @Nullable VoiceSpec systemFallback,
            float rate
        ) {
            this.bookId = bookId;
            this.title = title;
            this.author = author;
            this.chapterTitle = chapterTitle;
            this.coverUrl = coverUrl;
            this.voice = voice;
            this.systemFallback = systemFallback;
            this.rate = clampRate(rate);
        }

        public static SessionSpec fromJson(JSONObject obj) {
            VoiceSpec voice = VoiceSpec.fromJson(obj.optJSONObject("voice"));
            JSONObject fbObj = obj.optJSONObject("systemFallback");
            VoiceSpec fallback = fbObj != null ? VoiceSpec.fromJson(fbObj) : null;
            String cover = obj.has("coverUrl") && !obj.isNull("coverUrl")
                ? obj.optString("coverUrl")
                : null;
            return new SessionSpec(
                obj.optString("bookId", ""),
                obj.optString("title", ""),
                obj.optString("author", ""),
                obj.optString("chapterTitle", ""),
                cover,
                voice,
                fallback,
                (float) obj.optDouble("rate", 1.0)
            );
        }
    }

    private final Scheduler scheduler;
    private final NetworkChecker networkChecker;
    private final TtsBackend ttsBackend;
    private final FileBackend fileBackend;
    @Nullable private final SpeechJournal journal;
    private final EventListener listener;
    @Nullable private LocalSynth localSynth;

    @Nullable private SessionSpec session;
    private final List<UtteranceItem> queue = new ArrayList<>();
    private int currentIndex = -1;
    private String status = "idle"; // "idle" | "playing" | "paused" | "buffering" | "ended-of-buffer"
    private boolean usingFallback = false;
    private boolean stickyFallbackActive = false;
    private int stickyFallbackSection = -1;
    private int stickyFallbackBlockIndex = -1;
    private int playbackGeneration = 0;
    private boolean inInterUtterancePause = false;
    private boolean autoContinueOnBufferTopUp = false;
    private boolean queueLowEmitted = false;

    @Nullable private CancelToken fallbackTimer;
    @Nullable private CancelToken sleepTickTimer;
    private String sleepMode = "off"; // "off" | "minutes" | "endOfSection"
    private long sleepDeadlineMs = 0L;
    private boolean stopAfterCurrentUtterance = false;

    public ReadAloudQueueEngine(
        Scheduler scheduler,
        NetworkChecker networkChecker,
        TtsBackend ttsBackend,
        FileBackend fileBackend,
        @Nullable SpeechJournal journal,
        EventListener listener
    ) {
        this.scheduler = scheduler;
        this.networkChecker = networkChecker;
        this.ttsBackend = ttsBackend;
        this.fileBackend = fileBackend;
        this.journal = journal;
        this.listener = listener;
    }

    public void setLocalSynth(@Nullable LocalSynth localSynth) {
        this.localSynth = localSynth;
    }

    private void notifyLocalSynthPlan() {
        if (localSynth != null && session != null && currentIndex >= 0 && currentIndex < queue.size()) {
            localSynth.onPlan(queue, currentIndex, session.voice, playbackGeneration);
        }
    }

    private void cancelLocalSynth() {
        if (localSynth != null) {
            localSynth.cancelAll();
        }
    }

    public static float clampRate(float r) {
        if (Float.isNaN(r) || r <= 0f) return 1.0f;
        return Math.max(0.5f, Math.min(3.0f, r));
    }

    public boolean isAudible() {
        return "playing".equals(status) || "buffering".equals(status);
    }

    public String getStatus() {
        return status;
    }

    @Nullable
    public SessionSpec getSession() {
        return session;
    }

    @Nullable
    public UtteranceItem getCurrentItem() {
        if (currentIndex >= 0 && currentIndex < queue.size()) {
            return queue.get(currentIndex);
        }
        return null;
    }

    public void load(SessionSpec newSession) {
        stopInternal(false);
        this.session = newSession;
        this.status = "paused";
        this.usingFallback = false;
        this.stickyFallbackActive = false;
        this.autoContinueOnBufferTopUp = false;
        this.queueLowEmitted = false;
        emitState();
    }

    public void enqueue(List<UtteranceItem> items, @Nullable String replaceFromId) {
        if (replaceFromId != null && !replaceFromId.isEmpty()) {
            int replaceIdx = findIndexById(replaceFromId);
            if (replaceIdx >= 0) {
                while (queue.size() > replaceIdx) {
                    queue.remove(queue.size() - 1);
                }
                if (currentIndex >= queue.size()) {
                    currentIndex = queue.size() - 1;
                }
            }
        }

        for (UtteranceItem item : items) {
            int existingIdx = findIndexById(item.id);
            if (existingIdx >= 0) {
                AttachedAudioSpec prevAudio = queue.get(existingIdx).audio;
                item.audio = prevAudio;
                queue.set(existingIdx, item);
            } else {
                queue.add(item);
            }
        }

        int remaining = Math.max(0, queue.size() - Math.max(0, currentIndex));
        if (remaining > QUEUE_LOW_THRESHOLD) {
            queueLowEmitted = false;
        }

        if (currentIndex < 0 && !queue.isEmpty()) {
            currentIndex = 0;
        }

        if ("buffering".equals(status) && currentIndex >= 0 && currentIndex < queue.size()
            && playbackGeneration == 0) {
            startCurrentUtterance();
            return;
        }

        if ("ended-of-buffer".equals(status) && currentIndex + 1 < queue.size()) {
            currentIndex += 1;
            if (autoContinueOnBufferTopUp) {
                autoContinueOnBufferTopUp = false;
                startCurrentUtterance();
                return;
            } else {
                emitState();
            }
        }
        notifyLocalSynthPlan();
    }

    public void attachAudio(
        String utteranceId,
        String path,
        long durationMs,
        List<WordMarkSpec> marks
    ) {
        int idx = findIndexById(utteranceId);
        if (idx < 0) return;
        UtteranceItem item = queue.get(idx);
        item.audio = new AttachedAudioSpec(path, durationMs, marks);

        if ("buffering".equals(status) && idx == currentIndex) {
            cancelFallbackTimer();
            startCurrentUtterance();
        }
    }

    public void play() {
        if (session == null) return;
        if (queue.isEmpty()) {
            setStatus("buffering");
            fileBackend.startBufferingKeepAlive();
            emitQueueLowIfNeeded();
            return;
        }
        if ("ended-of-buffer".equals(status)) {
            autoContinueOnBufferTopUp = false;
            if (currentIndex + 1 < queue.size()) {
                currentIndex += 1;
            } else {
                currentIndex = 0;
            }
        } else if (currentIndex < 0 || currentIndex >= queue.size()) {
            currentIndex = 0;
        }
        startCurrentUtterance();
    }

    public void pause() {
        if ("idle".equals(status) || "paused".equals(status)) return;
        playbackGeneration++;
        // If paused during inter-sentence silence, currentIndex already finished speaking:
        // advance to the next sentence so resume does not repeat the finished sentence.
        if (inInterUtterancePause && currentIndex + 1 < queue.size()) {
            currentIndex += 1;
        }
        inInterUtterancePause = false;
        autoContinueOnBufferTopUp = false;
        cancelFallbackTimer();
        cancelLocalSynth();
        ttsBackend.stop();
        fileBackend.stop();
        setStatus("paused");
    }

    public void stop() {
        stopInternal(true);
    }

    private void stopInternal(boolean emitStoppedEvent) {
        playbackGeneration++;
        inInterUtterancePause = false;
        autoContinueOnBufferTopUp = false;
        queueLowEmitted = false;
        cancelFallbackTimer();
        cancelSleepTimer();
        cancelLocalSynth();
        ttsBackend.stop();
        fileBackend.stop();
        queue.clear();
        currentIndex = -1;
        usingFallback = false;
        stickyFallbackActive = false;
        stopAfterCurrentUtterance = false;
        sleepMode = "off";
        boolean wasActive = !"idle".equals(status);
        setStatus("idle");
        if (emitStoppedEvent && wasActive) {
            JSONObject ev = new JSONObject();
            putJson(ev, "reason", "stopped");
            listener.onEvent("speech-ended", ev);
        }
    }

    public void seekTo(String id) {
        int idx = findIndexById(id);
        if (idx < 0) return;
        boolean shouldKeepPlaying = isAudible();
        playbackGeneration++;
        inInterUtterancePause = false;
        autoContinueOnBufferTopUp = false;
        cancelFallbackTimer();
        cancelLocalSynth();
        ttsBackend.stop();
        fileBackend.stop();
        currentIndex = idx;
        stickyFallbackActive = false;
        int remaining = Math.max(0, queue.size() - currentIndex);
        if (remaining > QUEUE_LOW_THRESHOLD) {
            queueLowEmitted = false;
        }
        if (shouldKeepPlaying) {
            startCurrentUtterance();
        } else {
            notifyLocalSynthPlan();
            emitState();
        }
    }

    public void nextSentence() {
        if (queue.isEmpty()) return;
        int next = Math.min(queue.size() - 1, currentIndex + 1);
        if (next != currentIndex) {
            seekTo(queue.get(next).id);
        }
    }

    public void prevSentence() {
        if (queue.isEmpty()) return;
        int prev = Math.max(0, currentIndex - 1);
        seekTo(queue.get(prev).id);
    }

    public void setRate(float rate) {
        float clamped = clampRate(rate);
        if (session != null) {
            session.rate = clamped;
        }
        fileBackend.setRate(clamped);
        emitState();
    }

    public void setVoice(VoiceSpec voice) {
        if (session == null) return;
        session.voice = voice;
        stickyFallbackActive = false;
        usingFallback = false;
        cancelLocalSynth();
        if (isAudible()) {
            startCurrentUtterance();
        } else {
            notifyLocalSynthPlan();
            emitState();
        }
    }

    public void setSleepTimer(String mode, int minutes) {
        cancelSleepTimer();
        stopAfterCurrentUtterance = false;
        if ("minutes".equals(mode) && minutes > 0) {
            sleepMode = "minutes";
            sleepDeadlineMs = scheduler.nowMs() + minutes * 60_000L;
            scheduleSleepTick();
        } else if ("endOfSection".equals(mode)) {
            sleepMode = "endOfSection";
        } else {
            sleepMode = "off";
            sleepDeadlineMs = 0L;
        }
        emitSleepTimerEvent(false);
        emitState();
    }

    private void scheduleSleepTick() {
        if (!"minutes".equals(sleepMode)) return;
        long remaining = sleepDeadlineMs - scheduler.nowMs();
        if (remaining <= 0L) {
            onMinutesSleepDeadlineReached();
            return;
        }
        long step = Math.min(1_000L, remaining);
        sleepTickTimer = scheduler.postDelayed(step, () -> {
            if (!"minutes".equals(sleepMode)) return;
            long rem = sleepDeadlineMs - scheduler.nowMs();
            if (rem <= 0L) {
                onMinutesSleepDeadlineReached();
            } else {
                emitSleepTimerEvent(false);
                scheduleSleepTick();
            }
        });
    }

    private void onMinutesSleepDeadlineReached() {
        cancelSleepTimer();
        if (!isAudible()) {
            sleepMode = "off";
            emitSleepTimerEvent(true);
            emitState();
            return;
        }
        if ("buffering".equals(status) || inInterUtterancePause) {
            completeSleepTimerExpiry();
        } else {
            // Finish current sentence cleanly, then pause (`PRODUCT_DESIGN.md` §4.6)
            stopAfterCurrentUtterance = true;
        }
    }

    private void completeSleepTimerExpiry() {
        playbackGeneration++;
        inInterUtterancePause = false;
        stopAfterCurrentUtterance = false;
        sleepMode = "off";
        sleepDeadlineMs = 0L;
        cancelFallbackTimer();
        ttsBackend.stop();
        fileBackend.stop();
        setStatus("paused");
        emitSleepTimerEvent(true);
        JSONObject ended = new JSONObject();
        putJson(ended, "reason", "sleep-timer");
        listener.onEvent("speech-ended", ended);
    }

    private void startCurrentUtterance() {
        if (session == null || currentIndex < 0 || currentIndex >= queue.size()) {
            return;
        }
        playbackGeneration++;
        final int gen = playbackGeneration;
        inInterUtterancePause = false;
        cancelFallbackTimer();
        ttsBackend.stop();
        fileBackend.stop();

        final UtteranceItem item = queue.get(currentIndex);
        emitQueueLowIfNeeded();

        // Reset paragraph-sticky fallback as soon as we advance into a new paragraph/section
        if (stickyFallbackActive
            && (item.section != stickyFallbackSection || item.blockIndex != stickyFallbackBlockIndex)) {
            stickyFallbackActive = false;
        }

        VoiceSpec activeVoice = session.voice;
        if ("system".equals(activeVoice.kind)) {
            usingFallback = false;
            speakWithSystemVoice(item, activeVoice, false, gen);
            return;
        }

        final boolean isKokoro = "kokoro".equals(activeVoice.kind);
        if (isKokoro) {
            // Unannotated utterance (phonemeIds == null): speak with systemFallback immediately (NOT sticky)
            if (item.phonemeIds == null || item.phonemeIds.length == 0) {
                if (session.systemFallback != null) {
                    usingFallback = true;
                    speakWithSystemVoice(item, session.systemFallback, true, gen);
                } else {
                    onUtteranceFinished(item, true, gen);
                }
                notifyLocalSynthPlan();
                return;
            }
            notifyLocalSynthPlan();
        }

        // Synth engine ('edge' | 'openai' | 'qwen' | 'kokoro')
        if (stickyFallbackActive && session.systemFallback != null) {
            usingFallback = true;
            speakWithSystemVoice(item, session.systemFallback, true, gen);
            return;
        }

        if (item.audio != null) {
            usingFallback = false;
            playAttachedAudio(item, item.audio, gen);
            return;
        }

        // Audio not yet attached -> enter BUFFERING and arm fallback timer (§8.5, §5.2)
        setStatus("buffering");
        fileBackend.startBufferingKeepAlive();
        final long waitMs;
        final String reason;
        if (isKokoro) {
            waitMs = LOCAL_SYNTH_FALLBACK_TIMEOUT_MS;
            reason = "local-synth-timeout";
        } else {
            boolean online = networkChecker.isOnline();
            waitMs = online ? ONLINE_FALLBACK_TIMEOUT_MS : OFFLINE_FALLBACK_TIMEOUT_MS;
            reason = online ? "network-timeout" : "offline";
        }

        fallbackTimer = scheduler.postDelayed(waitMs, () -> {
            if (gen != playbackGeneration || !"buffering".equals(status)) return;
            if (item.audio != null) {
                startCurrentUtterance();
                return;
            }
            if (session != null && session.systemFallback != null) {
                stickyFallbackActive = true;
                stickyFallbackSection = item.section;
                stickyFallbackBlockIndex = item.blockIndex;
                usingFallback = true;

                JSONObject fbPayload = new JSONObject();
                putJson(fbPayload, "reason", reason);
                putJson(fbPayload, "utteranceId", item.id);
                listener.onEvent("speech-fallback", fbPayload);

                speakWithSystemVoice(item, session.systemFallback, true, gen);
            }
            // When systemFallback == null, stay in BUFFERING until attachAudio or user pauses (§8.5 #3)
        });
    }

    public void onLocalSynthFailed(String utteranceId, @Nullable String reason) {
        UtteranceItem cur = getCurrentItem();
        if (cur == null || !cur.id.equals(utteranceId) || !"buffering".equals(status)) {
            return;
        }
        cancelFallbackTimer();
        if (session != null && session.systemFallback != null) {
            stickyFallbackActive = true;
            stickyFallbackSection = cur.section;
            stickyFallbackBlockIndex = cur.blockIndex;
            usingFallback = true;

            JSONObject fbPayload = new JSONObject();
            putJson(fbPayload, "reason", reason != null ? reason : "local-synth-error");
            putJson(fbPayload, "utteranceId", cur.id);
            listener.onEvent("speech-fallback", fbPayload);

            speakWithSystemVoice(cur, session.systemFallback, true, playbackGeneration);
        } else {
            onUtteranceFinished(cur, true, playbackGeneration);
        }
    }

    private void speakWithSystemVoice(
        UtteranceItem item,
        VoiceSpec sysVoice,
        boolean fallbackFlag,
        int gen
    ) {
        setStatus("playing");
        ttsBackend.speak(
            item,
            sysVoice.voiceId,
            sysVoice.engine,
            session != null ? session.rate : 1.0f,
            createUtteranceCallback(item, fallbackFlag, true, gen)
        );
    }

    private void playAttachedAudio(
        UtteranceItem item,
        AttachedAudioSpec audio,
        int gen
    ) {
        setStatus("playing");
        fileBackend.playFile(
            item,
            audio,
            session != null ? session.rate : 1.0f,
            createUtteranceCallback(item, false, false, gen)
        );
    }

    private BackendCallback createUtteranceCallback(
        final UtteranceItem item,
        final boolean isFallbackUtterance,
        final boolean isTtsPath,
        final int gen
    ) {
        return new BackendCallback() {
            private boolean startedEmitted = false;

            @Override
            public void onStarted() {
                if (gen != playbackGeneration) return;
                if (startedEmitted) return;
                startedEmitted = true;
                emitUtteranceStarted(item, isFallbackUtterance);
            }

            @Override
            public void onWordBoundary(int start, int end, long timeMs) {
                if (gen != playbackGeneration) return;
                JSONObject wordEv = new JSONObject();
                putJson(wordEv, "id", item.id);
                putJson(wordEv, "start", Math.max(0, start));
                putJson(wordEv, "end", Math.max(start, end));
                if (timeMs >= 0L) {
                    putJson(wordEv, "timeMs", timeMs);
                }
                listener.onEvent("utterance-word", wordEv);
            }

            @Override
            public void onCompleted() {
                if (gen != playbackGeneration) return;
                if (!startedEmitted) {
                    startedEmitted = true;
                    emitUtteranceStarted(item, isFallbackUtterance);
                }
                JSONObject doneEv = new JSONObject();
                putJson(doneEv, "id", item.id);
                listener.onEvent("utterance-done", doneEv);

                onUtteranceFinished(item, isTtsPath, gen);
            }

            @Override
            public void onError(String message) {
                if (gen != playbackGeneration) return;
                // If file playback failed and fallback is enabled, try system voice for this paragraph
                if (!isTtsPath && session != null && session.systemFallback != null) {
                    stickyFallbackActive = true;
                    stickyFallbackSection = item.section;
                    stickyFallbackBlockIndex = item.blockIndex;
                    usingFallback = true;
                    JSONObject fbPayload = new JSONObject();
                    putJson(fbPayload, "reason", message != null ? message : "audio-error");
                    putJson(fbPayload, "utteranceId", item.id);
                    listener.onEvent("speech-fallback", fbPayload);
                    speakWithSystemVoice(item, session.systemFallback, true, gen);
                    return;
                }
                onUtteranceFinished(item, isTtsPath, gen);
            }
        };
    }

    private void emitUtteranceStarted(UtteranceItem item, boolean fallbackFlag) {
        if (journal != null && session != null) {
            journal.writeUtteranceStart(
                session.bookId,
                item.section,
                item.start,
                item.id,
                item.text,
                scheduler.nowMs()
            );
        }
        JSONObject startEv = new JSONObject();
        putJson(startEv, "id", item.id);
        putJson(startEv, "section", item.section);
        putJson(startEv, "start", item.start);
        putJson(startEv, "end", item.end);
        putJson(startEv, "usingFallback", fallbackFlag);
        listener.onEvent("utterance-start", startEv);
        emitState();
    }

    private void onUtteranceFinished(UtteranceItem finishedItem, boolean usedTts, int gen) {
        if (stopAfterCurrentUtterance) {
            completeSleepTimerExpiry();
            return;
        }

        boolean hasNext = currentIndex + 1 < queue.size();
        if ("endOfSection".equals(sleepMode)) {
            boolean sectionEnds = !hasNext || queue.get(currentIndex + 1).section != finishedItem.section;
            if (sectionEnds) {
                if (hasNext) {
                    currentIndex += 1;
                }
                completeSleepTimerExpiry();
                return;
            }
        }

        if (!hasNext) {
            inInterUtterancePause = false;
            autoContinueOnBufferTopUp = true;
            queueLowEmitted = false;
            emitQueueLowIfNeeded();
            setStatus("ended-of-buffer");
            JSONObject endedEv = new JSONObject();
            putJson(endedEv, "reason", "end-of-buffer");
            listener.onEvent("speech-ended", endedEv);
            return;
        }

        float rate = session != null ? session.rate : 1.0f;
        long scaledPauseMs = Math.round(finishedItem.pauseAfterMs / Math.max(0.5f, rate));
        if (scaledPauseMs <= 0L) {
            currentIndex += 1;
            startCurrentUtterance();
            return;
        }

        // Hold status = 'playing' & audio focus across inter-sentence pause (§8.3)
        inInterUtterancePause = true;
        Runnable afterPause = () -> {
            if (gen != playbackGeneration) return;
            inInterUtterancePause = false;
            if (stopAfterCurrentUtterance) {
                completeSleepTimerExpiry();
                return;
            }
            currentIndex += 1;
            startCurrentUtterance();
        };

        if (usedTts) {
            ttsBackend.playSilence(scaledPauseMs, afterPause);
        } else {
            fileBackend.playSilence(scaledPauseMs, afterPause);
        }
    }

    private void emitQueueLowIfNeeded() {
        int remaining = Math.max(0, queue.size() - Math.max(0, currentIndex));
        if (remaining <= QUEUE_LOW_THRESHOLD) {
            if (!queueLowEmitted) {
                queueLowEmitted = true;
                JSONObject low = new JSONObject();
                putJson(low, "remaining", remaining);
                listener.onEvent("queue-low", low);
            }
        } else {
            queueLowEmitted = false;
        }
    }

    private void emitSleepTimerEvent(boolean expired) {
        JSONObject ev = new JSONObject();
        putJson(ev, "mode", sleepMode);
        if ("minutes".equals(sleepMode)) {
            long rem = Math.max(0L, sleepDeadlineMs - scheduler.nowMs());
            putJson(ev, "remainingMs", rem);
        }
        if (expired) {
            putJson(ev, "expired", true);
        }
        listener.onEvent("sleep-timer", ev);
    }

    private void setStatus(String nextStatus) {
        boolean prevAudible = isAudible();
        this.status = nextStatus;
        boolean nextAudible = isAudible();
        if (prevAudible != nextAudible) {
            listener.onAudibleChanged(nextAudible);
        }
        listener.onPlayerStateInvalidate();
        emitState();
    }

    public JSONObject buildStateJson() {
        JSONObject out = new JSONObject();
        putJson(out, "status", status);
        putJson(out, "bookId", session != null ? session.bookId : JSONObject.NULL);
        UtteranceItem cur = getCurrentItem();
        putJson(out, "currentUtteranceId", cur != null ? cur.id : JSONObject.NULL);
        putJson(out, "section", cur != null ? cur.section : JSONObject.NULL);
        putJson(out, "offset", cur != null ? cur.start : JSONObject.NULL);
        putJson(out, "rate", session != null ? (double) session.rate : 1.0);
        putJson(out, "voice", session != null ? session.voice.toJson() : JSONObject.NULL);
        putJson(out, "usingFallback", usingFallback);

        JSONObject sleepObj = new JSONObject();
        putJson(sleepObj, "mode", sleepMode);
        if ("minutes".equals(sleepMode)) {
            putJson(sleepObj, "remainingMs", Math.max(0L, sleepDeadlineMs - scheduler.nowMs()));
        }
        putJson(out, "sleepTimer", sleepObj);
        return out;
    }

    private static void putJson(JSONObject obj, String key, Object value) {
        try {
            obj.put(key, value);
        } catch (JSONException ignored) {}
    }

    private void emitState() {
        listener.onEvent("speech-state", buildStateJson());
    }

    private int findIndexById(String id) {
        for (int i = 0; i < queue.size(); i++) {
            if (queue.get(i).id.equals(id)) return i;
        }
        return -1;
    }

    private void cancelFallbackTimer() {
        if (fallbackTimer != null) {
            fallbackTimer.cancel();
            fallbackTimer = null;
        }
    }

    private void cancelSleepTimer() {
        if (sleepTickTimer != null) {
            sleepTickTimer.cancel();
            sleepTickTimer = null;
        }
    }

    public static List<UtteranceItem> parseUtteranceList(@Nullable JSONArray arr) {
        if (arr == null) return Collections.emptyList();
        List<UtteranceItem> list = new ArrayList<>(arr.length());
        for (int i = 0; i < arr.length(); i++) {
            JSONObject obj = arr.optJSONObject(i);
            if (obj != null) {
                list.add(UtteranceItem.fromJson(obj));
            }
        }
        return list;
    }

    public static List<WordMarkSpec> parseWordMarks(@Nullable JSONArray arr) {
        if (arr == null) return Collections.emptyList();
        List<WordMarkSpec> list = new ArrayList<>(arr.length());
        for (int i = 0; i < arr.length(); i++) {
            JSONObject obj = arr.optJSONObject(i);
            if (obj != null) {
                list.add(new WordMarkSpec(
                    obj.optInt("start", 0),
                    obj.optInt("end", 0),
                    obj.optLong("timeMs", 0L)
                ));
            }
        }
        return list;
    }
}
