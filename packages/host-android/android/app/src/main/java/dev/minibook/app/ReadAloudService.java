package dev.minibook.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import org.json.JSONObject;

/**
 * Foreground Media3 `MediaSessionService` (`foregroundServiceType="mediaPlayback"`) hosting
 * `ReadAloudQueueEngine`, `SystemTtsBackend`, `FilePlayerBackend`, unified `AudioFocusRequest`,
 * `ACTION_AUDIO_BECOMING_NOISY`, `PARTIAL_WAKE_LOCK`, and `SpeechJournal` (`ARCHITECTURE.md` §8.6).
 */
@OptIn(markerClass = UnstableApi.class)
public class ReadAloudService extends MediaSessionService {
    public static final String CHANNEL_ID = "minibook_read_aloud";
    public static final int NOTIFICATION_ID = 2001;
    private static final long WAKE_LOCK_SAFETY_MS = 45 * 60 * 1000L; // 45 min refreshed on play

    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static final List<ServiceCommand> PENDING_COMMANDS = new ArrayList<>();
    private static final Set<PluginEventSink> EVENT_SINKS = new CopyOnWriteArraySet<>();

    @Nullable private static volatile ReadAloudService instance;
    private static volatile boolean audibleFlag = false;

    public interface ServiceCommand {
        void execute(ReadAloudService service);
    }

    public interface PluginEventSink {
        void onSpeechEvent(String eventName, JSONObject payload);
    }

    /**
     * Native truth read synchronously in `MainActivity.dispatchKeyEvent` (`ARCHITECTURE.md` §9.5):
     * true iff Read Aloud is actively `playing` OR `buffering`.
     */
    public static boolean isAudible() {
        return audibleFlag;
    }

    public static void addEventSink(PluginEventSink sink) {
        EVENT_SINKS.add(sink);
    }

    public static void removeEventSink(PluginEventSink sink) {
        EVENT_SINKS.remove(sink);
    }

    @Nullable
    public static ReadAloudService peekInstance() {
        return instance;
    }

    public static void runCommand(Context context, boolean startIfNeeded, ServiceCommand cmd) {
        final Context appCtx = context.getApplicationContext();
        MAIN_HANDLER.post(() -> {
            ReadAloudService svc = instance;
            if (svc != null && svc.queueEngine != null) {
                cmd.execute(svc);
                return;
            }
            if (!startIfNeeded) {
                return;
            }
            PENDING_COMMANDS.add(cmd);
            Intent intent = new Intent(appCtx, ReadAloudService.class);
            try {
                ContextCompat.startForegroundService(appCtx, intent);
            } catch (Exception ignored) {
                try {
                    appCtx.startService(intent);
                } catch (Exception ignored2) {}
            }
        });
    }

    private AudioManager audioManager;
    @Nullable private AudioFocusRequest audioFocusRequest;
    private boolean hasAudioFocus = false;
    private boolean resumeOnFocusGain = false;

    private SystemTtsBackend ttsBackend;
    private FilePlayerBackend fileBackend;
    private SpeechJournal speechJournal;
    private ReadAloudQueueEngine queueEngine;
    @Nullable private KokoroModelStore kokoroModelStore;
    @Nullable private KokoroOnnxBackend kokoroBackend;
    @Nullable private KokoroSynthQueue kokoroSynthQueue;
    private ReadAloudPlayer mediaPlayer;
    @Nullable private MediaSession mediaSession;
    @Nullable private PowerManager.WakeLock wakeLock;
    private boolean noisyReceiverRegistered = false;

    private final BroadcastReceiver becomingNoisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                pausePlayback();
            }
        }
    };

    private final AudioManager.OnAudioFocusChangeListener focusListener = focusChange ->
        MAIN_HANDLER.post(() -> {
            if (queueEngine == null) return;
            switch (focusChange) {
                case AudioManager.AUDIOFOCUS_LOSS:
                    hasAudioFocus = false;
                    resumeOnFocusGain = false;
                    pausePlayback();
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                    // Pause spoken narration rather than talking softly under notifications (§8.6)
                    if (queueEngine.isAudible()) {
                        resumeOnFocusGain = true;
                        queueEngine.pause();
                    }
                    break;
                case AudioManager.AUDIOFOCUS_GAIN:
                    hasAudioFocus = true;
                    if (resumeOnFocusGain) {
                        resumeOnFocusGain = false;
                        queueEngine.play();
                    }
                    break;
                default:
                    break;
            }
        });

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();
        DefaultMediaNotificationProvider notificationProvider =
            new DefaultMediaNotificationProvider.Builder(this)
                .setChannelId(CHANNEL_ID)
                .setNotificationId(NOTIFICATION_ID)
                .build();
        setMediaNotificationProvider(notificationProvider);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        File miniBookData = new File(getFilesDir(), "MiniBookData");
        speechJournal = new SpeechJournal(miniBookData);
        ttsBackend = new SystemTtsBackend(this);
        fileBackend = new FilePlayerBackend(this);

        ReadAloudQueueEngine.Scheduler scheduler = new ReadAloudQueueEngine.Scheduler() {
            @Override
            public long nowMs() {
                return System.currentTimeMillis();
            }

            @Override
            public ReadAloudQueueEngine.CancelToken postDelayed(long delayMs, Runnable task) {
                MAIN_HANDLER.postDelayed(task, Math.max(0L, delayMs));
                return () -> MAIN_HANDLER.removeCallbacks(task);
            }
        };

        ReadAloudQueueEngine.NetworkChecker netChecker = () -> isDeviceOnline(ReadAloudService.this);

        queueEngine = new ReadAloudQueueEngine(
            scheduler,
            netChecker,
            ttsBackend,
            fileBackend,
            speechJournal,
            new ReadAloudQueueEngine.EventListener() {
                @Override
                public void onEvent(String eventName, JSONObject payload) {
                    for (PluginEventSink sink : EVENT_SINKS) {
                        sink.onSpeechEvent(eventName, payload);
                    }
                }

                @Override
                public void onAudibleChanged(boolean audible) {
                    audibleFlag = audible;
                    if (audible) {
                        acquireWakeLock();
                        registerNoisyReceiver();
                    } else {
                        releaseWakeLock();
                        unregisterNoisyReceiver();
                    }
                }

                @Override
                public void onPlayerStateInvalidate() {
                    if (mediaPlayer != null) {
                        mediaPlayer.notifyStateChanged();
                    }
                }
            }
        );

        kokoroModelStore = new KokoroModelStore(miniBookData);
        kokoroBackend = new KokoroOnnxBackend();
        File speechCacheDir = new File(getCacheDir(), "speech");
        kokoroSynthQueue = new KokoroSynthQueue(
            kokoroModelStore,
            kokoroBackend,
            speechCacheDir,
            new KokoroSynthQueue.QueueCallback() {
                @Override
                public void attachAudio(
                    String utteranceId,
                    String wavPath,
                    long durationMs,
                    List<ReadAloudQueueEngine.WordMarkSpec> marks
                ) {
                    MAIN_HANDLER.post(() -> {
                        if (queueEngine != null) {
                            queueEngine.attachAudio(utteranceId, wavPath, durationMs, marks);
                        }
                    });
                }

                @Override
                public void attachAudio(
                    String utteranceId,
                    String wavPath,
                    long durationMs,
                    List<ReadAloudQueueEngine.WordMarkSpec> marks,
                    int engineGeneration
                ) {
                    MAIN_HANDLER.post(() -> {
                        if (queueEngine != null) {
                            queueEngine.attachLocalSynthAudio(
                                utteranceId,
                                wavPath,
                                durationMs,
                                marks,
                                engineGeneration
                            );
                        }
                    });
                }

                @Override
                public void onSynthFailed(String utteranceId, String errorCode, String message) {
                    MAIN_HANDLER.post(() -> {
                        if (queueEngine != null) {
                            queueEngine.onLocalSynthFailed(utteranceId, errorCode);
                        }
                    });
                }

                @Override
                public void onSynthFailed(
                    String utteranceId,
                    String errorCode,
                    String message,
                    int engineGeneration
                ) {
                    MAIN_HANDLER.post(() -> {
                        if (queueEngine != null) {
                            queueEngine.onLocalSynthFailed(utteranceId, errorCode, engineGeneration);
                        }
                        if ("model-selftest".equals(errorCode) && kokoroModelStore != null) {
                            JSONObject errStatus = kokoroModelStore.buildReconciledStatus(
                                "ort-cpu",
                                0.0,
                                KokoroModelStore.makeErrorJson("model-selftest", message)
                            );
                            for (PluginEventSink sink : EVENT_SINKS) {
                                sink.onSpeechEvent("speech-model", errStatus);
                            }
                        }
                    });
                }

                @Override
                public void onEngineSlow(double rtf) {
                    MAIN_HANDLER.post(() -> {
                        JSONObject payload = new JSONObject();
                        try {
                            payload.put("rtf", rtf);
                            payload.put("engine", "kokoro");
                        } catch (Exception ignored) {}
                        for (PluginEventSink sink : EVENT_SINKS) {
                            sink.onSpeechEvent("engine-slow", payload);
                        }
                    });
                }
            }
        );
        queueEngine.setLocalSynth(kokoroSynthQueue);

        mediaPlayer = new ReadAloudPlayer(Looper.getMainLooper(), new ReadAloudPlayer.Controls() {
            @Override
            public ReadAloudQueueEngine engine() {
                return queueEngine;
            }

            @Override
            public void requestPlay() {
                startPlayback();
            }

            @Override
            public void requestPause() {
                pausePlayback();
            }

            @Override
            public void requestStop() {
                stopPlayback();
            }

            @Override
            public void requestNextSentence() {
                queueEngine.nextSentence();
            }

            @Override
            public void requestPrevSentence() {
                queueEngine.prevSentence();
            }
        });

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent sessionActivity = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        mediaSession = new MediaSession.Builder(this, mediaPlayer)
            .setSessionActivity(sessionActivity)
            .build();

        instance = this;
        drainPendingCommands();
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        // Satisfy Android 12-16 startForegroundService 5s contract immediately
        promoteBootstrapForeground();
        int res = super.onStartCommand(intent, flags, startId);
        drainPendingCommands();
        MAIN_HANDLER.post(() -> {
            if (queueEngine == null || "idle".equals(queueEngine.getStatus())) {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelfResult(startId);
            }
        });
        return res;
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        if (queueEngine == null || !queueEngine.isAudible()) {
            stopPlayback();
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        audibleFlag = false;
        if (instance == this) {
            instance = null;
        }
        unregisterNoisyReceiver();
        abandonAudioFocus();
        releaseWakeLock();
        if (queueEngine != null) {
            queueEngine.stop();
        }
        if (kokoroSynthQueue != null) {
            kokoroSynthQueue.shutdown();
            kokoroSynthQueue = null;
        }
        if (kokoroBackend != null) {
            kokoroBackend.close();
            kokoroBackend = null;
        }
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        if (fileBackend != null) {
            fileBackend.release();
        }
        if (ttsBackend != null) {
            ttsBackend.shutdown();
        }
        super.onDestroy();
    }

    public ReadAloudQueueEngine getQueueEngine() {
        return queueEngine;
    }

    public SystemTtsBackend getTtsBackend() {
        return ttsBackend;
    }

    public static void unloadLocalModels() {
        ReadAloudService svc = instance;
        if (svc != null) {
            if (svc.kokoroSynthQueue != null) {
                svc.kokoroSynthQueue.cancelAll();
            }
            if (svc.kokoroBackend != null) {
                svc.kokoroBackend.close();
            }
            MAIN_HANDLER.post(() -> {
                if (svc.queueEngine != null) {
                    svc.queueEngine.onLocalModelVariantChanged();
                }
            });
        }
    }

    public void startPlayback() {
        resumeOnFocusGain = false;
        if (!requestAudioFocus()) {
            return;
        }
        promoteBootstrapForeground();
        queueEngine.play();
    }

    public void pausePlayback() {
        resumeOnFocusGain = false;
        queueEngine.pause();
        abandonAudioFocus();
    }

    public void stopPlayback() {
        resumeOnFocusGain = false;
        queueEngine.stop();
        abandonAudioFocus();
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void drainPendingCommands() {
        if (PENDING_COMMANDS.isEmpty()) return;
        List<ServiceCommand> copy = new ArrayList<>(PENDING_COMMANDS);
        PENDING_COMMANDS.clear();
        for (ServiceCommand cmd : copy) {
            cmd.execute(this);
        }
    }

    private boolean requestAudioFocus() {
        if (hasAudioFocus) return true;
        if (audioManager == null) return true;
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
        audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setAcceptsDelayedFocusGain(true)
            .setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(focusListener, MAIN_HANDLER)
            .build();
        int res = audioManager.requestAudioFocus(audioFocusRequest);
        if (res == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            hasAudioFocus = true;
            return true;
        }
        if (res == AudioManager.AUDIOFOCUS_REQUEST_DELAYED) {
            // Will auto-start in focusListener on AUDIOFOCUS_GAIN
            resumeOnFocusGain = true;
            promoteBootstrapForeground();
        }
        return false;
    }

    private void abandonAudioFocus() {
        hasAudioFocus = false;
        if (audioManager != null && audioFocusRequest != null) {
            try {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            } catch (Exception ignored) {}
        }
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.read_aloud_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                );
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void promoteBootstrapForeground() {
        try {
            Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(
                    queueEngine != null && queueEngine.getSession() != null
                        ? queueEngine.getSession().title
                        : getString(R.string.read_aloud_channel_name)
                )
                .setOngoing(true)
                .setSilent(true)
                .build();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception ignored) {
            // Android 12+ background start denial when already stopped; Media3 updates when active
        }
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "MiniBook:ReadAloud"
                    );
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(WAKE_LOCK_SAFETY_MS);
            }
        } catch (Exception ignored) {}
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    private void registerNoisyReceiver() {
        if (noisyReceiverRegistered) return;
        try {
            registerReceiver(
                becomingNoisyReceiver,
                new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            );
            noisyReceiverRegistered = true;
        } catch (Exception ignored) {}
    }

    private void unregisterNoisyReceiver() {
        if (!noisyReceiverRegistered) return;
        noisyReceiverRegistered = false;
        try {
            unregisterReceiver(becomingNoisyReceiver);
        } catch (Exception ignored) {}
    }

    public static boolean isDeviceOnline(Context context) {
        try {
            ConnectivityManager cm =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network net = cm.getActiveNetwork();
            if (net == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            return caps != null
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true;
        }
    }
}
