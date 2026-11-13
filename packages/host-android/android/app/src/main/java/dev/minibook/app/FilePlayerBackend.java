package dev.minibook.app;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.SilenceMediaSource;
import java.io.File;
import java.util.List;

/**
 * ExoPlayer synthesized-audio backend (`ARCHITECTURE.md` §8.3):
 *   - Plays cached MP3/WAV files at pitch-preserving `PlaybackParameters(rate, 1.0f)`
 *   - Emits `utterance-word` events from Edge `WordMarkSpec` timings every 80 ms
 *   - Plays real silent audio (`SilenceMediaSource`) during inter-sentence pauses and loops
 *     silence while `buffering` so Bluetooth A2DP headsets never suspend and clip audio starts.
 */
@OptIn(markerClass = UnstableApi.class)
public final class FilePlayerBackend implements ReadAloudQueueEngine.FileBackend {
    private static final long WORD_MARK_TICK_MS = 80L;
    private static final long BUFFERING_SILENCE_US = 2_000_000L; // 2s looped silence

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExoPlayer exoPlayer;

    @Nullable private ReadAloudQueueEngine.BackendCallback activeCallback;
    @Nullable private Runnable activeSilenceCallback;
    @Nullable private List<ReadAloudQueueEngine.WordMarkSpec> activeMarks;
    private int nextMarkIndex = 0;
    private boolean bufferingKeepAlive = false;

    private final Runnable markTicker = new Runnable() {
        @Override
        public void run() {
            if (activeCallback == null || activeMarks == null || activeMarks.isEmpty()) {
                return;
            }
            if (!exoPlayer.isPlaying()) {
                mainHandler.postDelayed(this, WORD_MARK_TICK_MS);
                return;
            }
            long posMs = Math.max(0L, exoPlayer.getCurrentPosition());
            while (nextMarkIndex < activeMarks.size()) {
                ReadAloudQueueEngine.WordMarkSpec m = activeMarks.get(nextMarkIndex);
                if (m.timeMs <= posMs) {
                    activeCallback.onWordBoundary(m.start, m.end, m.timeMs);
                    nextMarkIndex++;
                } else {
                    break;
                }
            }
            if (nextMarkIndex < activeMarks.size()) {
                mainHandler.postDelayed(this, WORD_MARK_TICK_MS);
            }
        }
    };

    public FilePlayerBackend(Context context) {
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build();
        // AudioFocus is managed centrally by ReadAloudService across both TTS and ExoPlayer
        this.exoPlayer = new ExoPlayer.Builder(context.getApplicationContext())
            .setAudioAttributes(attrs, false)
            .build();

        this.exoPlayer.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (isPlaying && !bufferingKeepAlive && activeCallback != null) {
                    activeCallback.onStarted();
                }
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_ENDED && !bufferingKeepAlive) {
                    mainHandler.removeCallbacks(markTicker);
                    if (activeSilenceCallback != null) {
                        Runnable done = activeSilenceCallback;
                        activeSilenceCallback = null;
                        done.run();
                    } else if (activeCallback != null) {
                        ReadAloudQueueEngine.BackendCallback cb = activeCallback;
                        activeCallback = null;
                        activeMarks = null;
                        cb.onCompleted();
                    }
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                if (bufferingKeepAlive) return;
                mainHandler.removeCallbacks(markTicker);
                activeSilenceCallback = null;
                if (activeCallback != null) {
                    ReadAloudQueueEngine.BackendCallback cb = activeCallback;
                    activeCallback = null;
                    activeMarks = null;
                    cb.onError(error.getMessage() != null ? error.getMessage() : "ExoPlayer error");
                }
            }
        });
    }

    @Override
    public void playFile(
        ReadAloudQueueEngine.UtteranceItem item,
        ReadAloudQueueEngine.AttachedAudioSpec audio,
        float rate,
        ReadAloudQueueEngine.BackendCallback callback
    ) {
        clearCallbacks();
        File file = new File(audio.path);
        if (!file.exists()) {
            callback.onError("Cached speech audio missing: " + audio.path);
            return;
        }
        bufferingKeepAlive = false;
        activeCallback = callback;
        activeMarks = audio.marks;
        nextMarkIndex = 0;

        exoPlayer.setRepeatMode(Player.REPEAT_MODE_OFF);
        exoPlayer.setPlaybackParameters(new PlaybackParameters(rate, 1.0f));
        exoPlayer.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)));
        exoPlayer.prepare();
        exoPlayer.play();

        if (activeMarks != null && !activeMarks.isEmpty()) {
            mainHandler.postDelayed(markTicker, WORD_MARK_TICK_MS);
        }
    }

    @Override
    public void playSilence(long durationMs, Runnable onDone) {
        clearCallbacks();
        if (durationMs <= 0L) {
            onDone.run();
            return;
        }
        bufferingKeepAlive = false;
        activeSilenceCallback = onDone;
        exoPlayer.setRepeatMode(Player.REPEAT_MODE_OFF);
        exoPlayer.setPlaybackParameters(PlaybackParameters.DEFAULT);
        exoPlayer.setMediaSource(new SilenceMediaSource(durationMs * 1_000L));
        exoPlayer.prepare();
        exoPlayer.play();
    }

    @Override
    public void startBufferingKeepAlive() {
        clearCallbacks();
        bufferingKeepAlive = true;
        exoPlayer.setRepeatMode(Player.REPEAT_MODE_ONE);
        exoPlayer.setPlaybackParameters(PlaybackParameters.DEFAULT);
        exoPlayer.setMediaSource(new SilenceMediaSource(BUFFERING_SILENCE_US));
        exoPlayer.prepare();
        exoPlayer.play();
    }

    @Override
    public void stop() {
        clearCallbacks();
        bufferingKeepAlive = false;
        exoPlayer.stop();
        exoPlayer.clearMediaItems();
    }

    @Override
    public void setRate(float rate) {
        if (!bufferingKeepAlive && activeSilenceCallback == null) {
            exoPlayer.setPlaybackParameters(new PlaybackParameters(rate, 1.0f));
        }
    }

    public void release() {
        stop();
        exoPlayer.release();
    }

    private void clearCallbacks() {
        mainHandler.removeCallbacks(markTicker);
        activeCallback = null;
        activeSilenceCallback = null;
        activeMarks = null;
        nextMarkIndex = 0;
    }
}
