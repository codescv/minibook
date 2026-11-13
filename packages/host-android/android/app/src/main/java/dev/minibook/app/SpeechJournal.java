package dev.minibook.app;

import androidx.annotation.Nullable;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Atomic native position journal (`ARCHITECTURE.md` §7.2, §8.6):
 *   1. Writes `MiniBookData/speech-journal.json` for `speechReadJournal()` reconciliation.
 *   2. Updates `MiniBookData/books/<bookId>/state.json`'s `position` atomically on every
 *      `utterance-start` (preserving `bookmarks` and existing `fraction`) so killing the app
 *      or WebView during screen-off listening loses at most one sentence.
 */
public final class SpeechJournal {
    private static final String JOURNAL_REL_PATH = "speech-journal.json";
    private final File miniBookDataRoot;
    private final Object lock = new Object();

    public static final class Checkpoint {
        public final String bookId;
        public final int section;
        public final int offset;
        @Nullable public final String utteranceId;
        public final long wallMs;

        public Checkpoint(
            String bookId,
            int section,
            int offset,
            @Nullable String utteranceId,
            long wallMs
        ) {
            this.bookId = bookId;
            this.section = section;
            this.offset = offset;
            this.utteranceId = utteranceId;
            this.wallMs = wallMs;
        }

        public JSONObject toJson() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("bookId", bookId);
                obj.put("section", section);
                obj.put("offset", offset);
                if (utteranceId != null) {
                    obj.put("utteranceId", utteranceId);
                }
                obj.put("wallMs", wallMs);
            } catch (org.json.JSONException ignored) {}
            return obj;
        }
    }

    public SpeechJournal(File miniBookDataRoot) {
        this.miniBookDataRoot = miniBookDataRoot;
    }

    public void writeUtteranceStart(
        String bookId,
        int section,
        int offset,
        @Nullable String utteranceId,
        @Nullable String snippet,
        long wallMs
    ) {
        if (bookId == null || bookId.trim().isEmpty()) return;
        synchronized (lock) {
            Checkpoint cp = new Checkpoint(bookId, section, offset, utteranceId, wallMs);
            try {
                AtomicFiles.writeAtomic(
                    miniBookDataRoot,
                    JOURNAL_REL_PATH,
                    cp.toJson().toString().getBytes(StandardCharsets.UTF_8)
                );
            } catch (Exception ignored) {
                // best-effort journal write
            }

            // Also update books/<bookId>/state.json atomically (same schema as FileLibraryStore.ts)
            String stateRelPath = "books/" + bookId + "/state.json";
            try {
                File stateFile = AtomicFiles.resolveInJail(miniBookDataRoot, stateRelPath, false);
                JSONObject stateJson = readExistingJson(stateFile);
                JSONArray bookmarks = stateJson != null ? stateJson.optJSONArray("bookmarks") : null;
                if (bookmarks == null) {
                    bookmarks = new JSONArray();
                }

                double preservedFraction = 0.0;
                String preservedSnippet = snippet != null ? snippet : "";
                if (stateJson != null) {
                    JSONObject prevPos = stateJson.optJSONObject("position");
                    if (prevPos != null) {
                        preservedFraction = prevPos.optDouble("fraction", 0.0);
                        if (preservedSnippet.isEmpty()) {
                            preservedSnippet = prevPos.optString("snippet", "");
                        }
                    }
                }
                if (preservedSnippet.length() > 32) {
                    preservedSnippet = preservedSnippet.substring(0, 32);
                }

                JSONObject nextPos = new JSONObject();
                nextPos.put("section", Math.max(0, section));
                nextPos.put("offset", Math.max(0, offset));
                nextPos.put("fraction", preservedFraction);
                nextPos.put("snippet", preservedSnippet);
                nextPos.put("updatedAt", wallMs);

                JSONObject nextState = new JSONObject();
                nextState.put("position", nextPos);
                nextState.put("bookmarks", bookmarks);

                AtomicFiles.writeAtomicFile(
                    stateFile,
                    nextState.toString().getBytes(StandardCharsets.UTF_8)
                );
            } catch (Exception ignored) {
                // ignore if book directory was removed concurrently
            }
        }
    }

    @Nullable
    public Checkpoint readCheckpoint() {
        synchronized (lock) {
            try {
                File f = AtomicFiles.resolveInJail(miniBookDataRoot, JOURNAL_REL_PATH, false);
                JSONObject obj = readExistingJson(f);
                if (obj == null) return null;
                String bookId = obj.optString("bookId", "");
                if (bookId.isEmpty()) return null;
                int section = obj.optInt("section", 0);
                int offset = obj.optInt("offset", 0);
                String utteranceId = obj.has("utteranceId") && !obj.isNull("utteranceId")
                    ? obj.optString("utteranceId")
                    : null;
                long wallMs = obj.optLong("wallMs", 0L);
                return new Checkpoint(bookId, section, offset, utteranceId, wallMs);
            } catch (Exception e) {
                return null;
            }
        }
    }

    @Nullable
    private static JSONObject readExistingJson(File file) {
        if (file == null || !file.exists() || !file.isFile()) return null;
        try {
            byte[] raw = Files.readAllBytes(file.toPath());
            return new JSONObject(new String(raw, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }
}
