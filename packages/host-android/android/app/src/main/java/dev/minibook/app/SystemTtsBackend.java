package dev.minibook.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Android `TextToSpeech` backend (`ARCHITECTURE.md` §8.3, §8.6):
 *   - Enumerates ALL installed TTS engines (Google TTS, MultiTTS, sherpa-onnx TTS, etc.)
 *   - Switches engine package dynamically when `voice.engine` changes
 *   - Respects `TextToSpeech.getMaxSpeechInputLength()`
 *   - Reports word boundaries via `onRangeStart` and gapless silent pauses via `playSilentUtterance`
 */
public final class SystemTtsBackend implements ReadAloudQueueEngine.TtsBackend {
    private static final AtomicInteger UTTERANCE_SEQ = new AtomicInteger(1);

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Nullable private TextToSpeech activeTts;
    @Nullable private String activeEnginePkg;
    private boolean ttsReady = false;
    @Nullable private Runnable pendingSpeakTask;
    private final Map<String, ActiveRequest> inFlight = new HashMap<>();

    private static final class ActiveRequest {
        final ReadAloudQueueEngine.BackendCallback callback;
        final boolean isSilence;
        @Nullable final Runnable silenceDone;
        final int offsetAdjustment;

        ActiveRequest(
            @Nullable ReadAloudQueueEngine.BackendCallback callback,
            boolean isSilence,
            @Nullable Runnable silenceDone,
            int offsetAdjustment
        ) {
            this.callback = callback;
            this.isSilence = isSilence;
            this.silenceDone = silenceDone;
            this.offsetAdjustment = offsetAdjustment;
        }
    }

    public SystemTtsBackend(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /**
     * Enumerates voices across all installed Android TTS engines (blocking call; run on IO thread).
     */
    public JSONArray listAllInstalledVoices() {
        JSONArray result = new JSONArray();
        List<TextToSpeech.EngineInfo> engines = new ArrayList<>();

        CountDownLatch probeLatch = new CountDownLatch(1);
        final TextToSpeech[] probeHolder = new TextToSpeech[1];
        mainHandler.post(() -> {
            probeHolder[0] = new TextToSpeech(appContext, status -> probeLatch.countDown());
        });
        try {
            probeLatch.await(4, TimeUnit.SECONDS);
            if (probeHolder[0] != null) {
                List<TextToSpeech.EngineInfo> found = probeHolder[0].getEngines();
                if (found != null) {
                    engines.addAll(found);
                }
            }
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } finally {
            if (probeHolder[0] != null) {
                final TextToSpeech p = probeHolder[0];
                mainHandler.post(p::shutdown);
            }
        }

        if (engines.isEmpty()) {
            return result;
        }

        for (TextToSpeech.EngineInfo engineInfo : engines) {
            String pkg = engineInfo.name;
            if (pkg == null || pkg.isEmpty()) continue;
            collectVoicesForEngine(pkg, engineInfo.label, result);
        }

        return result;
    }

    private void collectVoicesForEngine(String enginePkg, @Nullable String engineLabel, JSONArray sink) {
        CountDownLatch latch = new CountDownLatch(1);
        final int[] initStatus = { TextToSpeech.ERROR };
        final TextToSpeech[] holder = new TextToSpeech[1];

        mainHandler.post(() -> {
            try {
                holder[0] = new TextToSpeech(appContext, status -> {
                    initStatus[0] = status;
                    latch.countDown();
                }, enginePkg);
            } catch (Exception e) {
                latch.countDown();
            }
        });

        try {
            if (!latch.await(4, TimeUnit.SECONDS) || initStatus[0] != TextToSpeech.SUCCESS || holder[0] == null) {
                return;
            }
            Set<Voice> voices = holder[0].getVoices();
            if (voices == null || voices.isEmpty()) {
                JSONObject fallbackObj = new JSONObject();
                fallbackObj.put("id", enginePkg + ":default");
                fallbackObj.put("engine", enginePkg);
                fallbackObj.put("provider", "system");
                fallbackObj.put("name", engineLabel != null && !engineLabel.isEmpty() ? engineLabel : enginePkg);
                fallbackObj.put("lang", normalizeLanguageTag(Locale.getDefault().toLanguageTag()));
                fallbackObj.put("quality", "enhanced");
                fallbackObj.put("local", true);
                sink.put(fallbackObj);
                return;
            }
            List<RawVoiceEntry> rawEntries = new ArrayList<>(voices.size());
            for (Voice v : voices) {
                if (v == null) continue;
                Locale loc = v.getLocale();
                String langTag = loc != null ? loc.toLanguageTag() : "und";
                boolean local = !v.isNetworkConnectionRequired();
                rawEntries.add(new RawVoiceEntry(v.getName(), langTag, v.getQuality(), local));
            }
            JSONArray deduped = filterAndDeduplicateEngineVoices(enginePkg, engineLabel, rawEntries);
            for (int i = 0; i < deduped.length(); i++) {
                JSONObject item = deduped.optJSONObject(i);
                if (item != null) {
                    sink.put(item);
                }
            }
        } catch (Exception ignored) {
            // skip broken engine
        } finally {
            if (holder[0] != null) {
                final TextToSpeech tts = holder[0];
                mainHandler.post(tts::shutdown);
            }
        }
    }

    /** Lightweight value snapshot of an Android `Voice` for JVM unit testing without Robolectric. */
    static final class RawVoiceEntry {
        final String id;
        final String langTag;
        final int androidQuality;
        final boolean local;

        RawVoiceEntry(String id, String langTag, int androidQuality, boolean local) {
            this.id = id != null ? id : "";
            this.langTag = langTag != null ? langTag : "und";
            this.androidQuality = androidQuality;
            this.local = local;
        }
    }

    /**
     * Normalizes Android/Google TTS BCP-47 variants (`"cmn-Hans-CN"`, `"yue-Hant-HK"`, bare `"zh"`)
     * into standard regional tags (`"zh-CN"`, `"zh-TW"`, `"zh-HK"`, `"en-US"`, `"ja-JP"`, `"ko-KR"`).
     */
    public static String normalizeLanguageTag(@Nullable String rawTag) {
        if (rawTag == null) return "und";
        String cleaned = rawTag.trim().replace('_', '-');
        if (cleaned.isEmpty()) return "und";
        String lower = cleaned.toLowerCase(Locale.ROOT);
        switch (lower) {
            case "zh":
            case "zh-cn":
            case "zh-hans":
            case "zh-hans-cn":
            case "zh-sg":
            case "zh-hans-sg":
            case "cmn":
            case "cmn-cn":
            case "cmn-hans":
            case "cmn-hans-cn":
                return "zh-CN";
            case "zh-tw":
            case "zh-hant":
            case "zh-hant-tw":
            case "cmn-tw":
            case "cmn-hant":
            case "cmn-hant-tw":
                return "zh-TW";
            case "zh-hk":
            case "zh-hant-hk":
            case "zh-mo":
            case "zh-hant-mo":
            case "yue":
            case "zh-yue":
            case "yue-hk":
            case "yue-hant":
            case "yue-hant-hk":
                return "zh-HK";
            case "en":
                return "en-US";
            case "ja":
                return "ja-JP";
            case "ko":
                return "ko-KR";
            default:
                return cleaned;
        }
    }

    /**
     * Collapses `com.google.android.tts` `-local` / `-network` duplicate pairs (preferring `local = true`)
     * while preserving 100% of third-party Android TTS engine voices (`MultiTTS`, `sherpa-onnx`, OEM TTS).
     */
    static JSONArray filterAndDeduplicateEngineVoices(
        String enginePkg,
        @Nullable String engineLabel,
        List<RawVoiceEntry> entries
    ) {
        JSONArray out = new JSONArray();
        if (entries == null || entries.isEmpty()) return out;
        boolean isGoogleTts = "com.google.android.tts".equalsIgnoreCase(enginePkg);
        Map<String, RawVoiceEntry> chosen = new LinkedHashMap<>();
        for (RawVoiceEntry entry : entries) {
            if (entry == null || entry.id.isEmpty()) continue;
            String normLang = normalizeLanguageTag(entry.langTag);
            String key;
            if (isGoogleTts) {
                String stem = entry.id.replaceAll("(?i)-(local|network)$", "").toLowerCase(Locale.ROOT);
                key = normLang.toLowerCase(Locale.ROOT) + "|" + stem;
            } else {
                key = enginePkg + ":" + entry.id;
            }
            RawVoiceEntry prev = chosen.get(key);
            if (prev == null) {
                chosen.put(key, entry);
            } else if (entry.local != prev.local) {
                if (entry.local) {
                    chosen.put(key, entry);
                }
            } else if (entry.androidQuality > prev.androidQuality) {
                chosen.put(key, entry);
            }
        }

        for (RawVoiceEntry v : chosen.values()) {
            try {
                String normLang = normalizeLanguageTag(v.langTag);
                String quality = mapQuality(v.androidQuality, v.local);
                JSONObject obj = new JSONObject();
                obj.put("id", v.id);
                obj.put("engine", enginePkg);
                obj.put("provider", "system");
                obj.put("name", formatVoiceDisplayName(v.id, enginePkg, engineLabel));
                obj.put("lang", normLang);
                obj.put("quality", quality);
                obj.put("local", v.local);
                out.put(obj);
            } catch (Exception ignored) {
                // skip malformed entry
            }
        }
        return out;
    }

    private static String mapQuality(int androidQuality, boolean local) {
        if (!local) return "remote";
        if (androidQuality >= Voice.QUALITY_VERY_HIGH) return "neural";
        if (androidQuality >= Voice.QUALITY_HIGH) return "enhanced";
        return "compact";
    }

    private static String formatVoiceDisplayName(
        String rawId,
        String enginePkg,
        @Nullable String engineLabel
    ) {
        if ("com.google.android.tts".equalsIgnoreCase(enginePkg)) {
            return rawId.replaceAll("(?i)-(local|network)$", "");
        }
        if (engineLabel != null && !engineLabel.isEmpty()) {
            return engineLabel + " · " + rawId;
        }
        return rawId;
    }

    @Override
    public void speak(
        ReadAloudQueueEngine.UtteranceItem item,
        @Nullable String voiceId,
        @Nullable String enginePkg,
        float rate,
        ReadAloudQueueEngine.BackendCallback callback
    ) {
        ensureEngine(enginePkg, () -> speakReady(item, voiceId, rate, callback));
    }

    private void ensureEngine(@Nullable String requestedEngine, Runnable onReady) {
        String normReq = (requestedEngine != null && !requestedEngine.trim().isEmpty())
            ? requestedEngine.trim()
            : null;
        boolean sameEngine = (normReq == null && activeEnginePkg == null)
            || (normReq != null && normReq.equals(activeEnginePkg));

        if (activeTts != null && ttsReady && sameEngine) {
            onReady.run();
            return;
        }

        pendingSpeakTask = onReady;
        if (activeTts != null && !sameEngine) {
            try {
                activeTts.stop();
                activeTts.shutdown();
            } catch (Exception ignored) {}
            activeTts = null;
            ttsReady = false;
        }

        if (activeTts != null) {
            // Already initializing same engine
            return;
        }

        activeEnginePkg = normReq;
        TextToSpeech.OnInitListener initListener = status -> mainHandler.post(() -> {
            if (status == TextToSpeech.SUCCESS && activeTts != null) {
                ttsReady = true;
                configureTtsInstance(activeTts);
                Runnable task = pendingSpeakTask;
                pendingSpeakTask = null;
                if (task != null) {
                    task.run();
                }
            } else {
                ttsReady = false;
                pendingSpeakTask = null;
            }
        });

        activeTts = normReq != null
            ? new TextToSpeech(appContext, initListener, normReq)
            : new TextToSpeech(appContext, initListener);
    }

    private void configureTtsInstance(TextToSpeech tts) {
        try {
            tts.setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            );
        } catch (Exception ignored) {}

        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                mainHandler.post(() -> {
                    ActiveRequest req = inFlight.get(utteranceId);
                    if (req != null && !req.isSilence && req.callback != null) {
                        req.callback.onStarted();
                    }
                });
            }

            @Override
            public void onRangeStart(String utteranceId, int start, int end, int frame) {
                mainHandler.post(() -> {
                    ActiveRequest req = inFlight.get(utteranceId);
                    if (req != null && !req.isSilence && req.callback != null) {
                        req.callback.onWordBoundary(
                            req.offsetAdjustment + start,
                            req.offsetAdjustment + end,
                            -1L
                        );
                    }
                });
            }

            @Override
            public void onDone(String utteranceId) {
                mainHandler.post(() -> {
                    ActiveRequest req = inFlight.remove(utteranceId);
                    if (req == null) return;
                    if (req.isSilence) {
                        if (req.silenceDone != null) req.silenceDone.run();
                    } else if (req.callback != null) {
                        req.callback.onCompleted();
                    }
                });
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onError(String utteranceId) {
                onError(utteranceId, TextToSpeech.ERROR);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                mainHandler.post(() -> {
                    ActiveRequest req = inFlight.remove(utteranceId);
                    if (req == null) return;
                    if (req.isSilence) {
                        if (req.silenceDone != null) req.silenceDone.run();
                    } else if (req.callback != null) {
                        req.callback.onError("Android TextToSpeech error (" + errorCode + ")");
                    }
                });
            }
        });
    }

    private void speakReady(
        ReadAloudQueueEngine.UtteranceItem item,
        @Nullable String voiceId,
        float rate,
        ReadAloudQueueEngine.BackendCallback callback
    ) {
        if (activeTts == null || !ttsReady) {
            callback.onError("No Android TextToSpeech engine available");
            return;
        }

        inFlight.clear();
        activeTts.setSpeechRate(rate);

        boolean voiceApplied = false;
        if (voiceId != null && !voiceId.isEmpty() && !voiceId.endsWith(":default")) {
            try {
                Set<Voice> voices = activeTts.getVoices();
                if (voices != null) {
                    for (Voice v : voices) {
                        if (v != null && voiceId.equals(v.getName())) {
                            activeTts.setVoice(v);
                            voiceApplied = true;
                            break;
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        if (!voiceApplied && item.lang != null && !item.lang.isEmpty()) {
            try {
                Locale loc = Locale.forLanguageTag(normalizeLanguageTag(item.lang));
                activeTts.setLanguage(loc);
            } catch (Exception ignored) {}
        }

        int maxLen = Math.max(256, TextToSpeech.getMaxSpeechInputLength());
        String fullText = item.text != null ? item.text : "";
        if (fullText.length() <= maxLen) {
            String reqId = "mb_u_" + UTTERANCE_SEQ.getAndIncrement();
            inFlight.put(reqId, new ActiveRequest(callback, false, null, 0));
            Bundle params = new Bundle();
            int rc = activeTts.speak(fullText, TextToSpeech.QUEUE_FLUSH, params, reqId);
            if (rc == TextToSpeech.ERROR) {
                inFlight.remove(reqId);
                callback.onError("TextToSpeech.speak failed");
            }
            return;
        }

        // Split oversized utterance safely at maxLen boundary
        int chunks = (fullText.length() + maxLen - 1) / maxLen;
        for (int c = 0; c < chunks; c++) {
            final int startOff = c * maxLen;
            int endOff = Math.min(fullText.length(), startOff + maxLen);
            final boolean isFirst = (c == 0);
            final boolean isLast = (c == chunks - 1);
            String sub = fullText.substring(startOff, endOff);
            String reqId = "mb_u_" + UTTERANCE_SEQ.getAndIncrement();

            ReadAloudQueueEngine.BackendCallback chunkCb = new ReadAloudQueueEngine.BackendCallback() {
                @Override
                public void onStarted() {
                    if (isFirst) callback.onStarted();
                }

                @Override
                public void onWordBoundary(int start, int end, long timeMs) {
                    callback.onWordBoundary(start, end, timeMs);
                }

                @Override
                public void onCompleted() {
                    if (isLast) callback.onCompleted();
                }

                @Override
                public void onError(String message) {
                    callback.onError(message);
                }
            };

            inFlight.put(reqId, new ActiveRequest(chunkCb, false, null, startOff));
            int queueMode = isFirst ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD;
            activeTts.speak(sub, queueMode, new Bundle(), reqId);
        }
    }

    @Override
    public void playSilence(long durationMs, Runnable onDone) {
        if (activeTts == null || !ttsReady || durationMs <= 0L) {
            mainHandler.postDelayed(onDone, Math.max(0L, durationMs));
            return;
        }
        String reqId = "mb_sil_" + UTTERANCE_SEQ.getAndIncrement();
        inFlight.put(reqId, new ActiveRequest(null, true, onDone, 0));
        int rc = activeTts.playSilentUtterance(durationMs, TextToSpeech.QUEUE_ADD, reqId);
        if (rc == TextToSpeech.ERROR) {
            inFlight.remove(reqId);
            mainHandler.postDelayed(onDone, durationMs);
        }
    }

    @Override
    public void stop() {
        pendingSpeakTask = null;
        inFlight.clear();
        if (activeTts != null) {
            try {
                activeTts.stop();
            } catch (Exception ignored) {}
        }
    }

    public void shutdown() {
        stop();
        if (activeTts != null) {
            try {
                activeTts.shutdown();
            } catch (Exception ignored) {}
            activeTts = null;
            ttsReady = false;
        }
    }
}
