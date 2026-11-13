package dev.minibook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class KokoroVoicePackTest {
    private File tempRoot;
    private KokoroModelStore store;

    @Before
    public void setUp() throws Exception {
        tempRoot = Files.createTempDirectory("minibook-voice-test-").toFile();
        store = new KokoroModelStore(tempRoot);
    }

    @After
    public void tearDown() {
        AtomicFiles.deleteRecursively(tempRoot);
    }

    @Test
    public void clampsStyleRowAndSlicesExactLittleEndian256Floats() throws Exception {
        assertEquals(0, KokoroModelStore.clampStyleRow(0));
        assertEquals(0, KokoroModelStore.clampStyleRow(1));
        assertEquals(54, KokoroModelStore.clampStyleRow(55));
        assertEquals(509, KokoroModelStore.clampStyleRow(510));
        assertEquals(509, KokoroModelStore.clampStyleRow(999));

        assertEquals(0L, KokoroModelStore.voiceRowByteOffset(1));
        assertEquals(54L * 1024L, KokoroModelStore.voiceRowByteOffset(55));
        assertEquals(509L * 1024L, KokoroModelStore.voiceRowByteOffset(800));

        // Build exact 522,240-byte (510, 1, 256) float32-LE voice pack
        ByteBuffer bb = ByteBuffer.allocate(KokoroModelStore.VOICE_BIN_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        for (int row = 0; row < KokoroModelStore.VOICE_ROWS; row++) {
            for (int col = 0; col < KokoroModelStore.VOICE_DIM; col++) {
                bb.putFloat(row + col * 0.001f);
            }
        }
        File voiceFile = store.resolveInModelJail(KokoroModelStore.MODEL_ID, "voices/zf_001.bin");
        AtomicFiles.writeAtomicFile(voiceFile, bb.array());

        float[] row0 = store.styleRow("zf_001", 1);
        assertEquals(256, row0.length);
        assertEquals(0.0f, row0[0], 1e-6f);
        assertEquals(0.255f, row0[255], 1e-6f);

        float[] row54 = store.styleRow("zf_001", 55);
        assertEquals(54.0f, row54[0], 1e-6f);
        assertEquals(54.255f, row54[255], 1e-6f);

        float[] rowClamped = store.styleRow("zf_001", 900);
        assertEquals(509.0f, rowClamped[0], 1e-6f);
        assertEquals(509.255f, rowClamped[255], 1e-6f);
    }

    @Test
    public void rejectsPathTraversalInModelJail() {
        try {
            store.resolveInModelJail(KokoroModelStore.MODEL_ID, "../secrets.xml");
            fail("Expected IllegalArgumentException for traversal");
        } catch (Exception expected) {
            // pass
        }
    }
}
