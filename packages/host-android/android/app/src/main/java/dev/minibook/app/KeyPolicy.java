package dev.minibook.app;

import androidx.annotation.Nullable;

/**
 * Hardware volume-key paging policy (`ARCHITECTURE.md` §9.5, `PRODUCT_DESIGN.md` §8.5).
 *
 * Rules:
 *   - Volume keys page ONLY when `volumePaging` is true AND speech is NOT audible
 *     (`!ReadAloudService.isAudible()` — neither playing nor buffering).
 *   - Only `ACTION_DOWN` with `repeatCount == 0` emits a single page event; key auto-repeat
 *     (`repeatCount > 0`) and `ACTION_UP` are consumed silently so the system volume panel
 *     never appears and holding a key never smears pages on E-Ink.
 */
public final class KeyPolicy {
    // Matches `android.view.KeyEvent` constants so JVM unit tests need no Robolectric stubs.
    public static final int KEYCODE_VOLUME_UP = 24;
    public static final int KEYCODE_VOLUME_DOWN = 25;
    public static final int ACTION_DOWN = 0;
    public static final int ACTION_UP = 1;

    public enum Decision {
        PASS_TO_SYSTEM,
        EMIT_VOLUME_UP,
        EMIT_VOLUME_DOWN,
        CONSUME_SILENTLY
    }

    private volatile boolean volumePaging = false;

    public boolean isVolumePaging() {
        return volumePaging;
    }

    public void setVolumePaging(boolean enabled) {
        this.volumePaging = enabled;
    }

    public Decision decide(int keyCode, int action, int repeatCount, boolean isSpeechAudible) {
        boolean isVolumeKey = keyCode == KEYCODE_VOLUME_DOWN || keyCode == KEYCODE_VOLUME_UP;
        if (!isVolumeKey) {
            return Decision.PASS_TO_SYSTEM;
        }
        if (!volumePaging || isSpeechAudible) {
            return Decision.PASS_TO_SYSTEM;
        }
        if (action == ACTION_DOWN && repeatCount == 0) {
            return keyCode == KEYCODE_VOLUME_DOWN
                ? Decision.EMIT_VOLUME_DOWN
                : Decision.EMIT_VOLUME_UP;
        }
        return Decision.CONSUME_SILENTLY;
    }

    @Nullable
    public static String hardwareKeyName(Decision decision) {
        if (decision == Decision.EMIT_VOLUME_DOWN) return "volume-down";
        if (decision == Decision.EMIT_VOLUME_UP) return "volume-up";
        return null;
    }
}
