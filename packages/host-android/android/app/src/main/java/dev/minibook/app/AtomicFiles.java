package dev.minibook.app;

import androidx.annotation.Nullable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Bounded random-access reads (`<= 1 MiB`), canonical path-traversal jail, and atomic
 * `.tmp` + `fsync` + `rename` writes rooted at `<filesDir>/MiniBookData` (`ARCHITECTURE.md` §3.2, §3.3, §7.2, §13).
 */
public final class AtomicFiles {
    public static final int MAX_READ_BYTES = 1_048_576; // 1 MiB

    private AtomicFiles() {}

    public static final class BoundedReadResult {
        public final byte[] bytes;
        public final int bytesRead;

        public BoundedReadResult(byte[] bytes, int bytesRead) {
            this.bytes = bytes;
            this.bytesRead = bytesRead;
        }
    }

    public static final class Entry {
        public final String name;
        public final String path;
        public final long size;
        public final long mtimeMs;
        public final boolean isDirectory;

        public Entry(String name, String path, long size, long mtimeMs, boolean isDirectory) {
            this.name = name;
            this.path = path;
            this.size = size;
            this.mtimeMs = mtimeMs;
            this.isDirectory = isDirectory;
        }
    }

    public static final class Stat {
        public final boolean exists;
        public final long size;
        public final long mtimeMs;
        public final boolean isDirectory;

        public Stat(boolean exists, long size, long mtimeMs, boolean isDirectory) {
            this.exists = exists;
            this.size = size;
            this.mtimeMs = mtimeMs;
            this.isDirectory = isDirectory;
        }
    }

    /**
     * Resolves a relative path strictly inside `baseRoot` (or `baseRoot` itself when `allowRoot` is true).
     * Rejects null bytes, absolute paths escaping `baseRoot`, and `..` traversal.
     */
    public static File resolveInJail(File baseRoot, @Nullable String relativePath, boolean allowRoot)
        throws IOException {
        if (relativePath == null) {
            throw new IllegalArgumentException("Path is required");
        }
        if (relativePath.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Invalid null byte in path");
        }
        if (!baseRoot.exists() && !baseRoot.mkdirs() && !baseRoot.isDirectory()) {
            throw new IOException("Cannot create root directory: " + baseRoot);
        }

        File canonicalRoot = baseRoot.getCanonicalFile();
        String trimmed = relativePath.trim();
        while (trimmed.startsWith("/")) {
            trimmed = trimmed.substring(1);
        }

        if (trimmed.isEmpty()) {
            if (allowRoot) {
                return canonicalRoot;
            }
            throw new IllegalArgumentException("Empty relative path is not allowed");
        }

        File candidate = new File(canonicalRoot, trimmed).getCanonicalFile();
        String rootPrefix = canonicalRoot.getPath() + File.separator;
        if (!candidate.getPath().startsWith(rootPrefix)) {
            throw new IllegalArgumentException("Path escapes MiniBookData jail: " + relativePath);
        }
        return candidate;
    }

    public static BoundedReadResult readBounded(
        File baseRoot,
        String relativePath,
        long offset,
        int length
    ) throws IOException {
        if (offset < 0L) {
            throw new IllegalArgumentException("offset must be >= 0 (got " + offset + ")");
        }
        if (length <= 0 || length > MAX_READ_BYTES) {
            throw new IllegalArgumentException(
                "length must be in 1.." + MAX_READ_BYTES + " (got " + length + ")"
            );
        }

        File target = resolveInJail(baseRoot, relativePath, false);
        if (!target.exists() || !target.isFile()) {
            throw new FileNotFoundException("File not found: " + relativePath);
        }

        try (RandomAccessFile raf = new RandomAccessFile(target, "r")) {
            long fileLen = raf.length();
            if (offset >= fileLen) {
                return new BoundedReadResult(new byte[0], 0);
            }
            int toRead = (int) Math.min((long) length, fileLen - offset);
            byte[] buffer = new byte[toRead];
            raf.seek(offset);
            int total = 0;
            while (total < toRead) {
                int n = raf.read(buffer, total, toRead - total);
                if (n < 0) break;
                total += n;
            }
            byte[] exact = total == buffer.length ? buffer : Arrays.copyOf(buffer, total);
            return new BoundedReadResult(exact, total);
        }
    }

    public static void writeAtomic(File baseRoot, String relativePath, byte[] data) throws IOException {
        File target = resolveInJail(baseRoot, relativePath, false);
        writeAtomicFile(target, data);
    }

    public static void writeAtomicFile(File target, byte[] data) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Failed to create parent directory: " + parent);
        }
        File tmp = new File(
            parent,
            "." + target.getName() + ".tmp." + Thread.currentThread().getId() + "." + System.nanoTime()
        );
        try {
            try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
                fos.write(data);
                fos.flush();
                fos.getFD().sync();
            }
            moveAtomically(tmp, target);
        } finally {
            if (tmp.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        }
    }

    public static void moveAtomically(File src, File dst) throws IOException {
        if (src.getCanonicalFile().equals(dst.getCanonicalFile())) {
            return;
        }
        File parent = dst.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Failed to create parent directory: " + parent);
        }
        try {
            Files.move(
                src.toPath(),
                dst.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE
            );
            return;
        } catch (AtomicMoveNotSupportedException ignored) {
            // Fall through to non-atomic or cross-mount copy+rename
        } catch (IOException ignored) {
            // Cross-device link (EXDEV) between internal filesDir and externalMediaDirs -> copy+sync+rename below
        }

        try {
            Files.move(src.toPath(), dst.toPath(), StandardCopyOption.REPLACE_EXISTING);
            return;
        } catch (IOException ignored) {
            // Cross-filesystem move fallback: stream-copy to sibling .tmp, fsync, atomic rename, delete src
        }

        File tmp = new File(
            parent,
            "." + dst.getName() + ".tmp." + Thread.currentThread().getId() + "." + System.nanoTime()
        );
        try {
            try (FileInputStream fis = new FileInputStream(src);
                 FileOutputStream fos = new FileOutputStream(tmp, false)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = fis.read(buf)) != -1) {
                    fos.write(buf, 0, n);
                }
                fos.flush();
                fos.getFD().sync();
            }
            try {
                Files.move(
                    tmp.toPath(),
                    dst.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE
                );
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp.toPath(), dst.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            //noinspection ResultOfMethodCallIgnored
            src.delete();
        } finally {
            if (tmp.exists()) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        }
    }

    public static void append(File baseRoot, String relativePath, byte[] data) throws IOException {
        File target = resolveInJail(baseRoot, relativePath, false);
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Failed to create parent directory: " + parent);
        }
        try (FileOutputStream fos = new FileOutputStream(target, true)) {
            if (data.length > 0) {
                fos.write(data);
                fos.flush();
                fos.getFD().sync();
            }
        }
    }

    public static List<Entry> list(File baseRoot, String relativePath) throws IOException {
        File dir = resolveInJail(baseRoot, relativePath, true);
        if (!dir.exists() || !dir.isDirectory()) {
            return Collections.emptyList();
        }
        File canonicalRoot = baseRoot.getCanonicalFile();
        String rootPrefix = canonicalRoot.getPath() + File.separator;

        File[] children = dir.listFiles();
        if (children == null || children.length == 0) {
            return Collections.emptyList();
        }

        List<Entry> out = new ArrayList<>(children.length);
        for (File child : children) {
            String name = child.getName();
            if (name.startsWith(".") && name.contains(".tmp.")) {
                continue;
            }
            String canonical = child.getCanonicalPath();
            String rel = canonical.startsWith(rootPrefix)
                ? canonical.substring(rootPrefix.length()).replace(File.separatorChar, '/')
                : name;
            boolean isDir = child.isDirectory();
            out.add(new Entry(name, rel, isDir ? 0L : child.length(), child.lastModified(), isDir));
        }
        out.sort(Comparator.comparing(e -> e.name));
        return out;
    }

    public static void remove(File baseRoot, String relativePath) throws IOException {
        File target = resolveInJail(baseRoot, relativePath, false);
        deleteRecursively(target);
    }

    public static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File c : children) {
                    deleteRecursively(c);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    public static Stat stat(File baseRoot, String relativePath) throws IOException {
        File target = resolveInJail(baseRoot, relativePath, true);
        if (!target.exists()) {
            return new Stat(false, 0L, 0L, false);
        }
        boolean isDir = target.isDirectory();
        return new Stat(true, isDir ? 0L : target.length(), target.lastModified(), isDir);
    }
}
