package dev.minibook.app;

import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import androidx.annotation.Nullable;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Exposes MiniBook's user-visible books folder (`MiniBookPlugin.getBooksExportRoot`) directly
 * as a top-level `Books` (`图书`) location inside the Android system Files (`文件`) app (`v0.2.3`).
 */
public class MiniBookDocumentsProvider extends DocumentsProvider {
    public static final String ROOT_ID = "books_root";
    public static final String ROOT_DOC_ID = "root";

    private static final String[] DEFAULT_ROOT_PROJECTION = new String[] {
        Root.COLUMN_ROOT_ID,
        Root.COLUMN_FLAGS,
        Root.COLUMN_ICON,
        Root.COLUMN_TITLE,
        Root.COLUMN_DOCUMENT_ID,
        Root.COLUMN_AVAILABLE_BYTES,
    };

    private static final String[] DEFAULT_DOCUMENT_PROJECTION = new String[] {
        Document.COLUMN_DOCUMENT_ID,
        Document.COLUMN_MIME_TYPE,
        Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_LAST_MODIFIED,
        Document.COLUMN_FLAGS,
        Document.COLUMN_SIZE,
    };

    private final Handler ioCallbackHandler = new Handler(Looper.getMainLooper());

    @Override
    public boolean onCreate() {
        return true;
    }

    private File requireBooksRoot() throws FileNotFoundException {
        Context ctx = getContext();
        if (ctx == null) {
            throw new FileNotFoundException("Context unavailable");
        }
        return MiniBookPlugin.getBooksExportRoot(ctx);
    }

    static File resolveDocumentFile(File booksRoot, @Nullable String documentId)
        throws FileNotFoundException {
        if (documentId == null || documentId.trim().isEmpty()) {
            throw new FileNotFoundException("Missing documentId");
        }
        if (ROOT_DOC_ID.equals(documentId)) {
            try {
                return AtomicFiles.resolveInJail(booksRoot, "", true);
            } catch (Exception e) {
                throw new FileNotFoundException(e.getMessage());
            }
        }
        String prefix = MiniBookPlugin.USERBOOKS_PREFIX + "/";
        if (!documentId.startsWith(prefix)) {
            throw new FileNotFoundException("Unknown documentId: " + documentId);
        }
        String rel = documentId.substring(prefix.length());
        try {
            return AtomicFiles.resolveInJail(booksRoot, rel, false);
        } catch (Exception e) {
            throw new FileNotFoundException("Invalid documentId: " + e.getMessage());
        }
    }

    static String documentIdForFile(File booksRoot, File target) throws IOException {
        File canonRoot = booksRoot.getCanonicalFile();
        File canonTarget = target.getCanonicalFile();
        if (canonTarget.equals(canonRoot)) {
            return ROOT_DOC_ID;
        }
        String rootPrefix = canonRoot.getPath() + File.separator;
        if (!canonTarget.getPath().startsWith(rootPrefix)) {
            throw new IOException("Target escapes books root");
        }
        String rel = canonTarget.getPath().substring(rootPrefix.length()).replace(File.separatorChar, '/');
        return MiniBookPlugin.USERBOOKS_PREFIX + "/" + rel;
    }

    private static String[] resolveRootProjection(@Nullable String[] projection) {
        return projection != null ? projection : DEFAULT_ROOT_PROJECTION;
    }

    private static String[] resolveDocumentProjection(@Nullable String[] projection) {
        return projection != null ? projection : DEFAULT_DOCUMENT_PROJECTION;
    }

    @Override
    public Cursor queryRoots(@Nullable String[] projection) throws FileNotFoundException {
        Context ctx = getContext();
        File booksRoot = requireBooksRoot();
        MatrixCursor result = new MatrixCursor(resolveRootProjection(projection));
        MatrixCursor.RowBuilder row = result.newRow();
        row.add(Root.COLUMN_ROOT_ID, ROOT_ID);
        row.add(
            Root.COLUMN_FLAGS,
            Root.FLAG_SUPPORTS_CREATE | Root.FLAG_LOCAL_ONLY | Root.FLAG_SUPPORTS_IS_CHILD
        );
        row.add(Root.COLUMN_ICON, R.mipmap.ic_launcher);
        row.add(Root.COLUMN_TITLE, ctx != null ? ctx.getString(R.string.app_name) : "Books");
        row.add(Root.COLUMN_DOCUMENT_ID, ROOT_DOC_ID);
        row.add(Root.COLUMN_AVAILABLE_BYTES, booksRoot.getUsableSpace());
        return result;
    }

    @Override
    public Cursor queryDocument(String documentId, @Nullable String[] projection)
        throws FileNotFoundException {
        File booksRoot = requireBooksRoot();
        File file = resolveDocumentFile(booksRoot, documentId);
        if (!file.exists()) {
            throw new FileNotFoundException("Document does not exist: " + documentId);
        }
        MatrixCursor result = new MatrixCursor(resolveDocumentProjection(projection));
        includeFile(result, booksRoot, documentId, file);
        return result;
    }

    @Override
    public Cursor queryChildDocuments(
        String parentDocumentId,
        @Nullable String[] projection,
        @Nullable String sortOrder
    ) throws FileNotFoundException {
        File booksRoot = requireBooksRoot();
        File dir = resolveDocumentFile(booksRoot, parentDocumentId);
        if (!dir.exists() || !dir.isDirectory()) {
            throw new FileNotFoundException("Directory not found: " + parentDocumentId);
        }
        MatrixCursor result = new MatrixCursor(resolveDocumentProjection(projection));
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                String name = child.getName();
                if (name.startsWith(".")) continue;
                includeFile(result, booksRoot, null, child);
            }
        }
        return result;
    }

    @Override
    public boolean isChildDocument(String parentDocumentId, String documentId) {
        try {
            File booksRoot = requireBooksRoot();
            File parent = resolveDocumentFile(booksRoot, parentDocumentId).getCanonicalFile();
            File child = resolveDocumentFile(booksRoot, documentId).getCanonicalFile();
            if (child.equals(parent)) return true;
            String prefix = parent.getPath() + File.separator;
            return child.getPath().startsWith(prefix);
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public ParcelFileDescriptor openDocument(
        String documentId,
        String mode,
        @Nullable CancellationSignal signal
    ) throws FileNotFoundException {
        File booksRoot = requireBooksRoot();
        File file = resolveDocumentFile(booksRoot, documentId);
        if (!file.exists() || !file.isFile()) {
            throw new FileNotFoundException("File not found: " + documentId);
        }
        int accessMode = ParcelFileDescriptor.parseMode(mode);
        boolean isWrite = mode != null && (mode.indexOf('w') >= 0 || mode.indexOf('a') >= 0);
        if (isWrite) {
            final Context ctx = getContext();
            try {
                return ParcelFileDescriptor.open(file, accessMode, ioCallbackHandler, e -> {
                    if (ctx != null) {
                        MiniBookPlugin.scanDroppedInUserBooks(ctx);
                    }
                });
            } catch (IOException e) {
                throw new FileNotFoundException(e.getMessage());
            }
        }
        return ParcelFileDescriptor.open(file, accessMode);
    }

    @Override
    public String createDocument(String parentDocumentId, String mimeType, String displayName)
        throws FileNotFoundException {
        File booksRoot = requireBooksRoot();
        File parent = resolveDocumentFile(booksRoot, parentDocumentId);
        if (!parent.exists() || !parent.isDirectory()) {
            throw new FileNotFoundException("Parent directory not found: " + parentDocumentId);
        }
        try {
            if (Document.MIME_TYPE_DIR.equals(mimeType)) {
                String safeDir = MiniBookPlugin.sanitizeFileName(displayName);
                File newDir = AtomicFiles.resolveInJail(parent, safeDir, false);
                if (!newDir.exists() && !newDir.mkdirs()) {
                    throw new FileNotFoundException("Failed to create directory: " + safeDir);
                }
                return documentIdForFile(booksRoot, newDir);
            }
            String safeName = MiniBookPlugin.sanitizeFileName(displayName);
            File target = AtomicFiles.resolveInJail(parent, safeName, false);
            int counter = 2;
            int dot = safeName.lastIndexOf('.');
            String stem = dot > 0 ? safeName.substring(0, dot) : safeName;
            String ext = dot > 0 ? safeName.substring(dot) : "";
            while (target.exists()) {
                target = AtomicFiles.resolveInJail(parent, stem + " (" + counter + ")" + ext, false);
                counter++;
            }
            if (!target.createNewFile()) {
                throw new FileNotFoundException("Failed to create file: " + target.getName());
            }
            return documentIdForFile(booksRoot, target);
        } catch (FileNotFoundException e) {
            throw e;
        } catch (Exception e) {
            throw new FileNotFoundException("createDocument failed: " + e.getMessage());
        }
    }

    @Override
    public void deleteDocument(String documentId) throws FileNotFoundException {
        if (ROOT_DOC_ID.equals(documentId)) {
            throw new FileNotFoundException("Cannot delete root directory");
        }
        File booksRoot = requireBooksRoot();
        File target = resolveDocumentFile(booksRoot, documentId);
        if (!target.exists()) {
            throw new FileNotFoundException("Document not found: " + documentId);
        }
        AtomicFiles.deleteRecursively(target);
    }

    private void includeFile(
        MatrixCursor result,
        File booksRoot,
        @Nullable String explicitDocId,
        File file
    ) throws FileNotFoundException {
        String docId = explicitDocId;
        if (docId == null) {
            try {
                docId = documentIdForFile(booksRoot, file);
            } catch (IOException e) {
                throw new FileNotFoundException(e.getMessage());
            }
        }
        boolean isRoot = ROOT_DOC_ID.equals(docId);
        boolean isDir = file.isDirectory();
        int flags = 0;
        if (isDir) {
            if (file.canWrite()) {
                flags |= Document.FLAG_DIR_SUPPORTS_CREATE;
            }
        } else if (file.canWrite()) {
            flags |= Document.FLAG_SUPPORTS_WRITE;
        }
        if (!isRoot && file.canWrite()) {
            flags |= Document.FLAG_SUPPORTS_DELETE;
        }

        Context ctx = getContext();
        String displayName = isRoot
            ? (ctx != null ? ctx.getString(R.string.app_name) : "Books")
            : file.getName();
        String mimeType = isDir
            ? Document.MIME_TYPE_DIR
            : MiniBookPlugin.guessBookMimeType(file.getName());

        MatrixCursor.RowBuilder row = result.newRow();
        row.add(Document.COLUMN_DOCUMENT_ID, docId);
        row.add(Document.COLUMN_MIME_TYPE, mimeType);
        row.add(Document.COLUMN_DISPLAY_NAME, displayName);
        row.add(Document.COLUMN_LAST_MODIFIED, file.lastModified());
        row.add(Document.COLUMN_FLAGS, flags);
        row.add(Document.COLUMN_SIZE, isDir ? 0L : file.length());
    }
}
