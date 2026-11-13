package dev.minibook.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class BoundedReadTest {
    private File tempRoot;

    @Before
    public void setUp() throws Exception {
        tempRoot = Files.createTempDirectory("minibook-bounded-read-").toFile();
    }

    @After
    public void tearDown() {
        AtomicFiles.deleteRecursively(tempRoot);
    }

    @Test
    public void readsExactByteRangesAndEnforces1MiBCap() throws Exception {
        byte[] sample = new byte[4096];
        for (int i = 0; i < sample.length; i++) {
            sample[i] = (byte) ((i * 31) & 0xff);
        }
        AtomicFiles.writeAtomic(tempRoot, "books/b_test/book.epub", sample);

        AtomicFiles.BoundedReadResult mid = AtomicFiles.readBounded(
            tempRoot,
            "books/b_test/book.epub",
            500L,
            128
        );
        assertEquals(128, mid.bytesRead);
        assertArrayEquals(Arrays.copyOfRange(sample, 500, 628), mid.bytes);

        // Clamps cleanly at EOF
        AtomicFiles.BoundedReadResult tail = AtomicFiles.readBounded(
            tempRoot,
            "books/b_test/book.epub",
            4000L,
            500
        );
        assertEquals(96, tail.bytesRead);
        assertArrayEquals(Arrays.copyOfRange(sample, 4000, 4096), tail.bytes);

        // Offset past EOF returns 0 bytes
        AtomicFiles.BoundedReadResult pastEof = AtomicFiles.readBounded(
            tempRoot,
            "books/b_test/book.epub",
            9000L,
            64
        );
        assertEquals(0, pastEof.bytesRead);

        // > 1 MiB read MUST be rejected
        try {
            AtomicFiles.readBounded(
                tempRoot,
                "books/b_test/book.epub",
                0L,
                AtomicFiles.MAX_READ_BYTES + 1
            );
            fail("Expected IllegalArgumentException for length > 1 MiB");
        } catch (IllegalArgumentException expected) {
            // expected
        }

        // Negative offset or non-positive length rejected
        try {
            AtomicFiles.readBounded(tempRoot, "books/b_test/book.epub", -1L, 16);
            fail("Expected IllegalArgumentException for negative offset");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }

    @Test
    public void blocksPathTraversalAndSupportsAtomicAppendListRemove() throws Exception {
        String[] maliciousPaths = {
            "../outside.txt",
            "books/../../outside.txt",
            "books/b_1/../../../etc/passwd",
            "bad\0null.txt"
        };
        for (String bad : maliciousPaths) {
            try {
                AtomicFiles.writeAtomic(tempRoot, bad, "nope".getBytes(StandardCharsets.UTF_8));
                fail("Expected traversal path to be rejected: " + bad);
            } catch (IllegalArgumentException expected) {
                // expected
            }
        }

        AtomicFiles.append(tempRoot, "books/b_2/text.bin", "Hello ".getBytes(StandardCharsets.UTF_8));
        AtomicFiles.append(tempRoot, "books/b_2/text.bin", "World!".getBytes(StandardCharsets.UTF_8));

        AtomicFiles.Stat st = AtomicFiles.stat(tempRoot, "books/b_2/text.bin");
        assertTrue(st.exists);
        assertFalse(st.isDirectory);
        assertEquals(12L, st.size);

        List<AtomicFiles.Entry> listed = AtomicFiles.list(tempRoot, "books/b_2");
        assertEquals(1, listed.size());
        assertEquals("books/b_2/text.bin", listed.get(0).path);

        AtomicFiles.remove(tempRoot, "books/b_2");
        assertFalse(AtomicFiles.stat(tempRoot, "books/b_2/text.bin").exists);
    }

    @Test
    public void extractsSafeIntegersAndLongsAcrossJsonNumberRepresentations() throws Exception {
        JSONObject obj = new JSONObject();
        obj.put("intVal", Integer.valueOf(65536));
        obj.put("longVal", Long.valueOf(5_000_000_000L));
        obj.put("doubleVal", Double.valueOf(1024.0));
        obj.put("strVal", "2048");

        assertEquals(65536, MiniBookPlugin.extractSafeInt(obj, "intVal", -1));
        assertEquals(5_000_000_000L, MiniBookPlugin.extractSafeLong(obj, "longVal", -1L));
        assertEquals(1024, MiniBookPlugin.extractSafeInt(obj, "doubleVal", -1));
        assertEquals(2048L, MiniBookPlugin.extractSafeLong(obj, "strVal", -1L));
        assertEquals(42, MiniBookPlugin.extractSafeInt(obj, "missing", 42));
    }
}
