package com.joshua.survivingadamsville;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.UriMatcher;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * ReportProvider (v0.9) — serves the shareable report JSON to the Android
 * share sheet without any storage permission. Self-contained ContentProvider
 * (no androidx dependency in this manual aapt2/d8 pipeline): serves files
 * from <cache>/shared/, read-only, with per-Intent URI grants.
 *
 * Authority: com.joshua.survivingadamsville.reportprovider
 */
public class ReportProvider extends ContentProvider {

    public static final String AUTHORITY =
            "com.joshua.survivingadamsville.reportprovider";

    private static File sharedFile(android.content.Context ctx, Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("..") || name.contains("/")) {
            return null;
        }
        return new File(new File(ctx.getCacheDir(), "shared"), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode)
            throws FileNotFoundException {
        File f = sharedFile(getContext(), uri);
        if (f == null || !f.exists()) {
            throw new FileNotFoundException("no such shared report");
        }
        return ParcelFileDescriptor.open(f,
                ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f = sharedFile(getContext(), uri);
        String[] cols = { OpenableColumns.DISPLAY_NAME,
                OpenableColumns.SIZE };
        MatrixCursor c = new MatrixCursor(cols, 1);
        if (f != null && f.exists()) {
            c.addRow(new Object[]{ f.getName(), f.length() });
        }
        return c;
    }

    @Override
    public String getType(Uri uri) {
        return "application/json";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection,
                      String[] selectionArgs) {
        return 0;
    }
}
