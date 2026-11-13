package dev.minibook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class KeyPolicyTest {

    @Test
    public void passesToSystemWhenVolumePagingDisabled() {
        KeyPolicy policy = new KeyPolicy();
        policy.setVolumePaging(false);

        assertEquals(
            KeyPolicy.Decision.PASS_TO_SYSTEM,
            policy.decide(KeyPolicy.KEYCODE_VOLUME_DOWN, KeyPolicy.ACTION_DOWN, 0, false)
        );
        assertEquals(
            KeyPolicy.Decision.PASS_TO_SYSTEM,
            policy.decide(KeyPolicy.KEYCODE_VOLUME_UP, KeyPolicy.ACTION_DOWN, 0, false)
        );
    }

    @Test
    public void emitsSinglePageEventAndSuppressesRepeatsAndUpWhenSilent() {
        KeyPolicy policy = new KeyPolicy();
        policy.setVolumePaging(true);

        KeyPolicy.Decision downInitial = policy.decide(
            KeyPolicy.KEYCODE_VOLUME_DOWN,
            KeyPolicy.ACTION_DOWN,
            0,
            false
        );
        assertEquals(KeyPolicy.Decision.EMIT_VOLUME_DOWN, downInitial);
        assertEquals("volume-down", KeyPolicy.hardwareKeyName(downInitial));

        KeyPolicy.Decision upInitial = policy.decide(
            KeyPolicy.KEYCODE_VOLUME_UP,
            KeyPolicy.ACTION_DOWN,
            0,
            false
        );
        assertEquals(KeyPolicy.Decision.EMIT_VOLUME_UP, upInitial);
        assertEquals("volume-up", KeyPolicy.hardwareKeyName(upInitial));

        // Key auto-repeat and ACTION_UP are consumed silently (no smear, no volume toast)
        KeyPolicy.Decision repeat = policy.decide(
            KeyPolicy.KEYCODE_VOLUME_DOWN,
            KeyPolicy.ACTION_DOWN,
            3,
            false
        );
        assertEquals(KeyPolicy.Decision.CONSUME_SILENTLY, repeat);
        assertNull(KeyPolicy.hardwareKeyName(repeat));

        KeyPolicy.Decision keyUp = policy.decide(
            KeyPolicy.KEYCODE_VOLUME_DOWN,
            KeyPolicy.ACTION_UP,
            0,
            false
        );
        assertEquals(KeyPolicy.Decision.CONSUME_SILENTLY, keyUp);
    }

    @Test
    public void yieldsVolumeKeysToSystemImmediatelyWhileReadAloudIsAudible() {
        KeyPolicy policy = new KeyPolicy();
        policy.setVolumePaging(true);

        // Audible (playing or buffering) -> volume keys adjust media volume!
        assertEquals(
            KeyPolicy.Decision.PASS_TO_SYSTEM,
            policy.decide(KeyPolicy.KEYCODE_VOLUME_DOWN, KeyPolicy.ACTION_DOWN, 0, true)
        );
        assertEquals(
            KeyPolicy.Decision.PASS_TO_SYSTEM,
            policy.decide(KeyPolicy.KEYCODE_VOLUME_UP, KeyPolicy.ACTION_DOWN, 0, true)
        );

        // Once paused/stopped (!audible) -> volume keys turn pages again immediately
        assertEquals(
            KeyPolicy.Decision.EMIT_VOLUME_DOWN,
            policy.decide(KeyPolicy.KEYCODE_VOLUME_DOWN, KeyPolicy.ACTION_DOWN, 0, false)
        );
    }

    @Test
    public void ignoresNonVolumeKeysSoWebViewHandlesPageAndBackKeys() {
        KeyPolicy policy = new KeyPolicy();
        policy.setVolumePaging(true);

        // KEYCODE_PAGE_DOWN = 93, KEYCODE_BACK = 4
        assertEquals(
            KeyPolicy.Decision.PASS_TO_SYSTEM,
            policy.decide(93, KeyPolicy.ACTION_DOWN, 0, false)
        );
        assertEquals(
            KeyPolicy.Decision.PASS_TO_SYSTEM,
            policy.decide(4, KeyPolicy.ACTION_DOWN, 0, false)
        );
    }
}
