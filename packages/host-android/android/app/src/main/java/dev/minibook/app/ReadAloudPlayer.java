package dev.minibook.app;

import android.net.Uri;
import android.os.Looper;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * Media3 `SimpleBasePlayer` exposing the Read-Aloud utterance queue as a single continuous
 * spoken-audio session to the Android notification shade, lock screen, and Bluetooth AVRCP
 * (`ARCHITECTURE.md` §8.3, §8.6).
 *
 * Next / Previous media commands map to Next / Previous sentence.
 */
@OptIn(markerClass = UnstableApi.class)
public final class ReadAloudPlayer extends SimpleBasePlayer {
    public interface Controls {
        ReadAloudQueueEngine engine();
        void requestPlay();
        void requestPause();
        void requestStop();
        void requestNextSentence();
        void requestPrevSentence();
    }

    private final Controls controls;

    public ReadAloudPlayer(Looper looper, Controls controls) {
        super(looper);
        this.controls = controls;
    }

    public void notifyStateChanged() {
        invalidateState();
    }

    @Override
    protected State getState() {
        ReadAloudQueueEngine engine = controls.engine();
        ReadAloudQueueEngine.SessionSpec session = engine.getSession();
        String status = engine.getStatus();

        Player.Commands commands = new Player.Commands.Builder()
            .addAll(
                Player.COMMAND_PLAY_PAUSE,
                Player.COMMAND_STOP,
                Player.COMMAND_SEEK_TO_NEXT,
                Player.COMMAND_SEEK_TO_PREVIOUS,
                Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
                Player.COMMAND_GET_TIMELINE,
                Player.COMMAND_GET_METADATA
            )
            .build();

        if (session == null || "idle".equals(status)) {
            return new State.Builder()
                .setAvailableCommands(commands)
                .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
                .setPlaybackState(Player.STATE_IDLE)
                .build();
        }

        boolean playWhenReady = "playing".equals(status) || "buffering".equals(status);
        int playbackState;
        if ("buffering".equals(status)) {
            playbackState = Player.STATE_BUFFERING;
        } else if ("ended-of-buffer".equals(status)) {
            playbackState = Player.STATE_ENDED;
        } else {
            playbackState = Player.STATE_READY;
        }

        MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
            .setTitle(
                session.chapterTitle != null && !session.chapterTitle.isEmpty()
                    ? session.chapterTitle
                    : session.title
            )
            .setArtist(session.title)
            .setSubtitle(session.author)
            .setIsBrowsable(false)
            .setIsPlayable(true);

        if (session.coverUrl != null && !session.coverUrl.isEmpty()) {
            try {
                metaBuilder.setArtworkUri(Uri.parse(session.coverUrl));
            } catch (Exception ignored) {}
        }

        MediaItemData itemData = new MediaItemData.Builder(session.bookId)
            .setMediaMetadata(metaBuilder.build())
            .setIsSeekable(false)
            .build();

        return new State.Builder()
            .setAvailableCommands(commands)
            .setPlaylist(ImmutableList.of(itemData))
            .setCurrentMediaItemIndex(0)
            .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(playbackState)
            .build();
    }

    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        if (playWhenReady) {
            controls.requestPlay();
        } else {
            controls.requestPause();
        }
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleStop() {
        controls.requestStop();
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSeek(
        int mediaItemIndex,
        long positionMs,
        int seekCommand
    ) {
        if (seekCommand == Player.COMMAND_SEEK_TO_NEXT
            || seekCommand == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM) {
            controls.requestNextSentence();
        } else if (seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS
            || seekCommand == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM) {
            controls.requestPrevSentence();
        }
        return Futures.immediateVoidFuture();
    }
}
