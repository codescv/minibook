package dev.minibook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okio.Buffer;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class ModelDownloadManagerTest {
    private File tempRoot;
    private KokoroModelStore store;
    private final List<MockWebServer> servers = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        tempRoot = Files.createTempDirectory("minibook-dl-test-").toFile();
        store = new KokoroModelStore(tempRoot);
    }

    @After
    public void tearDown() throws Exception {
        for (MockWebServer s : servers) {
            try { s.shutdown(); } catch (Exception ignored) {}
        }
        AtomicFiles.deleteRecursively(tempRoot);
    }

    private MockWebServer newServer() throws IOException {
        MockWebServer s = new MockWebServer();
        s.start();
        servers.add(s);
        return s;
    }

    private static byte[] makeBytes(int len, int seed) {
        byte[] out = new byte[len];
        for (int i = 0; i < len; i++) {
            out[i] = (byte) ((i * 29 + seed) & 0xff);
        }
        return out;
    }

    private static String sha256(byte[] data) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(data);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : d) sb.append(String.format(Locale.US, "%02x", b & 0xff));
        return sb.toString();
    }

    private static JSONObject waitForTerminalState(
        List<JSONObject> events,
        CountDownLatch latch,
        long timeoutMs
    ) throws Exception {
        assertTrue("Timed out waiting for download terminal state", latch.await(timeoutMs, TimeUnit.MILLISECONDS));
        return events.get(events.size() - 1);
    }

    @Test
    public void resumesPartialDownloadWithHttp206AndReconcilesOnRestart() throws Exception {
        byte[] modelBytes = makeBytes(32 * 1024, 3);
        byte[] voiceBytes = makeBytes(8 * 1024, 5);
        String modelSha = sha256(modelBytes);
        String voiceSha = sha256(voiceBytes);

        List<String> rangesSeen = Collections.synchronizedList(new ArrayList<>());
        MockWebServer srv = newServer();
        srv.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                byte[] payload = request.getPath().contains("model_quantized.onnx")
                    ? modelBytes
                    : voiceBytes;
                String range = request.getHeader("Range");
                if (range != null && range.startsWith("bytes=")) {
                    rangesSeen.add(range);
                    int start = Integer.parseInt(range.substring(6, range.length() - 1));
                    Buffer buf = new Buffer().write(payload, start, payload.length - start);
                    return new MockResponse()
                        .setResponseCode(206)
                        .setHeader("Content-Range", "bytes " + start + "-" + (payload.length - 1) + "/" + payload.length)
                        .setBody(buf);
                }
                return new MockResponse()
                    .setResponseCode(200)
                    .setBody(new Buffer().write(payload));
            }
        });

        // Pre-seed .part file
        File partFile = store.resolveInModelJail(KokoroModelStore.MODEL_ID, "onnx/model_quantized.onnx.part");
        partFile.getParentFile().mkdirs();
        Files.write(partFile.toPath(), Arrays.copyOfRange(modelBytes, 0, 10_000));

        List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch done = new CountDownLatch(1);
        ModelDownloadManager mgr = new ModelDownloadManager(
            null,
            store,
            st -> {
                events.add(st);
                String s = st.optString("state");
                if ("ready".equals(s) || "error".equals(s)) done.countDown();
            },
            null,
            new long[] { 0L, 5L },
            2_000,
            2_000,
            0L,
            dir -> 100_000_000L,
            true
        );

        assertEquals("paused", mgr.getStatus(KokoroModelStore.MODEL_ID).optString("state"));

        List<ModelDownloadManager.FileSpec> files = Arrays.asList(
            new ModelDownloadManager.FileSpec("onnx/model_quantized.onnx", modelBytes.length, modelSha, "repo", "rev1"),
            new ModelDownloadManager.FileSpec("voices/zf_001.bin", voiceBytes.length, voiceSha, "repo", "rev1")
        );
        mgr.startDownload(new ModelDownloadManager.DownloadRequest(
            KokoroModelStore.MODEL_ID,
            "onnx-q8",
            files,
            Collections.singletonList(srv.url("/").toString().replaceAll("/$", "")),
            Arrays.asList("localhost", "127.0.0.1")
        ));

        JSONObject finalStatus = waitForTerminalState(events, done, 5_000L);
        assertEquals("ready", finalStatus.optString("state"));
        assertTrue(rangesSeen.contains("bytes=10000-"));
        assertFalse(partFile.exists());

        // Restart reconciliation
        ModelDownloadManager mgr2 = new ModelDownloadManager(null, store, st -> {}, null);
        assertEquals("ready", mgr2.getStatus(KokoroModelStore.MODEL_ID).optString("state"));

        mgr2.remove(KokoroModelStore.MODEL_ID);
        assertEquals("absent", mgr2.getStatus(KokoroModelStore.MODEL_ID).optString("state"));
        assertFalse(store.getModelRoot(KokoroModelStore.MODEL_ID).exists());
        mgr.shutdown();
        mgr2.shutdown();
    }

    @Test
    public void fallsBackToMirrorOn503Handles200IgnoredRangeAnd416AndAllowlist() throws Exception {
        byte[] modelBytes = makeBytes(12 * 1024, 11);
        String modelSha = sha256(modelBytes);

        MockWebServer primary = newServer();
        primary.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                return new MockResponse().setResponseCode(503);
            }
        });

        MockWebServer cdn = newServer();
        AtomicInteger cdnCalls = new AtomicInteger(0);
        cdn.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                int c = cdnCalls.incrementAndGet();
                if (c == 1 && request.getHeader("Range") != null) {
                    return new MockResponse().setResponseCode(416);
                }
                return new MockResponse().setResponseCode(200).setBody(new Buffer().write(modelBytes));
            }
        });

        MockWebServer mirror = newServer();
        String allowedCdnUrl = "http://localhost:" + cdn.getPort() + "/repo/resolve/rev1/onnx/model_quantized.onnx";
        mirror.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                return new MockResponse().setResponseCode(308).setHeader("Location", allowedCdnUrl);
            }
        });

        // Seed stale .part file to trigger Range -> 416 -> restart from 0
        File partFile = store.resolveInModelJail(KokoroModelStore.MODEL_ID, "onnx/model_quantized.onnx.part");
        partFile.getParentFile().mkdirs();
        Files.write(partFile.toPath(), Arrays.copyOfRange(modelBytes, 0, 2048));

        List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch done = new CountDownLatch(1);
        ModelDownloadManager mgr = new ModelDownloadManager(
            null,
            store,
            st -> {
                events.add(st);
                String s = st.optString("state");
                if ("ready".equals(s) || "error".equals(s)) done.countDown();
            },
            null,
            new long[] { 0L, 5L },
            2_000,
            2_000,
            0L,
            dir -> 100_000_000L,
            true
        );

        mgr.startDownload(new ModelDownloadManager.DownloadRequest(
            KokoroModelStore.MODEL_ID,
            "onnx-q8",
            Collections.singletonList(
                new ModelDownloadManager.FileSpec("onnx/model_quantized.onnx", modelBytes.length, modelSha, "repo", "rev1")
            ),
            Arrays.asList(
                primary.url("/").toString().replaceAll("/$", ""),
                mirror.url("/").toString().replaceAll("/$", "")
            ),
            Arrays.asList("127.0.0.1", "localhost")
        ));

        JSONObject finalStatus = waitForTerminalState(events, done, 5_000L);
        assertEquals("ready", finalStatus.optString("state"));
        assertTrue(cdnCalls.get() >= 2);
        mgr.shutdown();

        // Verify disallowed redirect host rejection
        assertFalse(ModelDownloadManager.isAllowedHost("evil.example.com", Arrays.asList("huggingface.co", ".hf.co")));
        assertTrue(ModelDownloadManager.isAllowedHost("cdn-lfs.hf.co", Arrays.asList("huggingface.co", ".hf.co")));
        assertTrue(ModelDownloadManager.isAllowedHost("hf-mirror.com", Arrays.asList("huggingface.co", "hf-mirror.com")));
    }

    @Test
    public void retriesOnceOnShaMismatchAndReportsStorageFull() throws Exception {
        byte[] validBytes = makeBytes(8 * 1024, 21);
        byte[] corruptBytes = makeBytes(8 * 1024, 99);
        String validSha = sha256(validBytes);

        MockWebServer srv = newServer();
        srv.enqueue(new MockResponse().setResponseCode(200).setBody(new Buffer().write(corruptBytes)));
        srv.enqueue(new MockResponse().setResponseCode(200).setBody(new Buffer().write(corruptBytes)));

        List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch done = new CountDownLatch(1);
        ModelDownloadManager mgr = new ModelDownloadManager(
            null,
            store,
            st -> {
                events.add(st);
                String s = st.optString("state");
                if ("ready".equals(s) || "error".equals(s)) done.countDown();
            },
            null,
            new long[] { 0L },
            2_000,
            2_000,
            0L,
            dir -> 100_000_000L,
            true
        );

        mgr.startDownload(new ModelDownloadManager.DownloadRequest(
            KokoroModelStore.MODEL_ID,
            "onnx-q8",
            Collections.singletonList(
                new ModelDownloadManager.FileSpec("onnx/model_quantized.onnx", validBytes.length, validSha, "repo", "rev1")
            ),
            Collections.singletonList(srv.url("/").toString().replaceAll("/$", "")),
            Arrays.asList("127.0.0.1", "localhost")
        ));

        JSONObject finalStatus = waitForTerminalState(events, done, 5_000L);
        assertEquals("error", finalStatus.optString("state"));
        assertEquals("model-integrity", finalStatus.getJSONObject("error").optString("code"));
        assertEquals(2, srv.getRequestCount());
        mgr.shutdown();

        // Storage full check
        ModelDownloadManager tightMgr = new ModelDownloadManager(
            null,
            store,
            st -> {},
            null,
            new long[] { 0L },
            2_000,
            2_000,
            64L * 1024L * 1024L,
            dir -> 1024L,
            true
        );
        JSONObject fullStatus = tightMgr.startDownload(new ModelDownloadManager.DownloadRequest(
            KokoroModelStore.MODEL_ID,
            "onnx-q8",
            Collections.singletonList(
                new ModelDownloadManager.FileSpec("onnx/model_quantized.onnx", validBytes.length, validSha, "repo", "rev1")
            ),
            Collections.singletonList(srv.url("/").toString().replaceAll("/$", "")),
            Collections.singletonList("127.0.0.1")
        ));
        assertEquals("error", fullStatus.optString("state"));
        assertEquals("storage-full", fullStatus.getJSONObject("error").optString("code"));
        tightMgr.shutdown();
    }
}
