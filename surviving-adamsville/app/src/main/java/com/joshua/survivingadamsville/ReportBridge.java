package com.joshua.survivingadamsville;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ReportBridge (v0.4) — JSON error/status report for the game.
 *
 * Mirrors the Voice Companion's CrashReporter/StatusReporter pattern:
 * the WebView game calls ReportBridge.saveReport(json) and the native
 * side writes "Surviving Adamsville Report.json" into the user's
 * Documents folder via MediaStore — no storage permission needed on
 * Android 10+. Same single-threaded background writer, same silent
 * failure policy: diagnostics must never break the game.
 *
 * Throttling lives on both sides: JS only calls saveReport on new
 * errors / session start, and native ignores calls more often than
 * SAVE_MIN_MS apart.
 */
public class ReportBridge {

    private static final String TAG = "SAReport";

    public static final String FILE_NAME = "Surviving Adamsville Report.json";

    /** v0.7: rotated report files. fileIdx 0 -> "Surviving Adamsville Report.json",
     *  1 -> "Surviving Adamsville Report 2.json", etc. JS rotates near the
     *  500MB cap so detail is never truncated. */
    public static String fileNameFor(int fileIdx) {
        return fileIdx <= 0 ? FILE_NAME
                : "Surviving Adamsville Report " + (fileIdx + 1) + ".json";
    }

    private static final long SAVE_MIN_MS = 5000;
    // v0.7: raised from 64KB — Joshua wants full detail; rotation (not
    // truncation) is now the size policy. 32MB is the native safety net.
    private static final int MAX_JSON_CHARS = 32 * 1024 * 1024;

    private static final ExecutorService WRITER =
            Executors.newSingleThreadExecutor();

    private final Context appCtx;
    private long lastSaveMs = 0;

    // v0.6: honest write telemetry — the game (and Joshua) can ask whether
    // the last Documents write actually worked, instead of failing silent.
    // v0.9: HONEST now — only "ok" when bytes were truly written. Plus a
    // full detail string (step, exception, sizes) for the VIEW REPORT screen.
    private volatile String lastWriteStatus = "never";
    private static volatile String lastWriteDetail =
            "{\"status\":\"never\",\"step\":\"none\"}";

    public ReportBridge(Context ctx) {
        this.appCtx = ctx.getApplicationContext();
    }

    /** App version, Android version, device model — for the report header. */
    @JavascriptInterface
    public String getMeta() {
        String ver = "?";
        try {
            PackageInfo pi = appCtx.getPackageManager()
                    .getPackageInfo(appCtx.getPackageName(), 0);
            ver = pi.versionName + " (" + pi.versionCode + ")";
        } catch (Exception ignored) { }
        String android = Build.VERSION.RELEASE
                + " (API " + Build.VERSION.SDK_INT + ")";
        String device = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        return "{\"ver\":\"" + esc(ver)
                + "\",\"android\":\"" + esc(android)
                + "\",\"device\":\"" + esc(device) + "\"}";
    }

    /** v0.6: did the last Documents write actually succeed? For the game's
     *  health badge — no more silent failure. */
    @JavascriptInterface
    public String getLastWriteStatus() {
        return lastWriteStatus;
    }

    // v1.10.1: the game calls this once after its first rendered frame so
    // the native loading screen can fade out. Never throws.
    private volatile Runnable onGameReadyCb = null;
    public void setOnGameReady(Runnable r) { onGameReadyCb = r; }
    @JavascriptInterface
    public void gameReady() {
        try {
            Runnable r = onGameReadyCb;
            if (r != null) r.run();
        } catch (Exception ignored) {}
    }

    /**
     * Writes the full JSON report to Documents. Called from JS on new
     * errors and session start; throttled here as a second line of
     * defense. Never throws, never blocks the WebView thread.
     * v0.7: fileIdx selects the rotated report file (0 = main report).
     */
    @JavascriptInterface
    public void saveReport(String json, int fileIdx) {
        try {
            if (json == null || json.isEmpty()) return;
            long now = System.currentTimeMillis();
            synchronized (this) {
                if (now - lastSaveMs < SAVE_MIN_MS) return;
                lastSaveMs = now;
            }
            final String content = json.length() > MAX_JSON_CHARS
                    ? json.substring(0, MAX_JSON_CHARS) : json;
            final String name = fileNameFor(fileIdx);
            WRITER.execute(() -> {
                // v0.9: writeWhole now RETURNS the outcome instead of
                // swallowing it — no more false "ok".
                WriteOutcome o = writeWhole(appCtx, content, name);
                if (o.ok) {
                    // v1.3: plain-words location — the writes were succeeding
                    // all along; Joshua was looking in Downloads/recent docs
                    // instead of Documents. Name the winning strategy AND
                    // exactly where the file lives.
                    lastWriteStatus = "ok " + stamp() + " [" + o.winStrategy
                            + "] " + o.bytes + "B — saved in the Documents "
                            + "folder (open your file manager > Documents)";
                } else {
                    // v1.3: name every strategy tried and its exact result.
                    lastWriteStatus = "not saved — tried: " + o.strategies
                            + " — use SHARE WITH MUSE instead";
                }
                lastWriteDetail = o.toJson(name);
                if (!o.ok) Log.e(TAG, "write failed: " + o.step + " — "
                        + o.error + " [" + name + "]");
                else Log.i(TAG, "wrote " + o.bytes + "B -> " + name);
            });
        } catch (Exception ignored) { }
    }

    /** Backwards-compatible single-arg form (writes the main report file). */
    @JavascriptInterface
    public void saveReport(String json) {
        saveReport(json, 0);
    }

    /** v0.9: full native write diagnostics for the in-game VIEW REPORT
     *  screen — so the failure reason is readable even if no file exists. */
    @JavascriptInterface
    public String getWriteDetail() {
        return lastWriteDetail;
    }

    private volatile String lastShareStatus = "never";

    /** v0.9: did the last share-sheet launch work? */
    @JavascriptInterface
    public String getShareStatus() {
        return lastShareStatus;
    }

    /**
     * v0.9: SHARE button on the View Report screen. Writes the supplied
     * report JSON to a temp file in the app cache and opens the Android
     * share sheet with it (content:// via ReportProvider — no storage
     * permission needed, one tap, no permission flow).
     * Never throws; file write happens off the WebView thread.
     */
    @JavascriptInterface
    public void shareReport(final String json) {
        WRITER.execute(() -> {
            try {
                if (json == null || json.isEmpty()) {
                    lastShareStatus = "FAIL: empty report";
                    return;
                }
                File dir = new File(appCtx.getCacheDir(), "shared");
                if (!dir.exists() && !dir.mkdirs()) {
                    lastShareStatus = "FAIL: cache dir";
                    Log.e(TAG, "share failed: cannot create cache/shared");
                    return;
                }
                // v1.3: single stable share file — delete any strays so one
                // share = one file. (The 10 dup-suffixed copies Joshua saw
                // are made by the RECEIVING app's save policy, which the game
                // can't override; keeping our side to exactly one file is
                // the most we can do here.)
                try {
                    File[] strays = dir.listFiles();
                    if (strays != null) for (File s : strays) {
                        if (!"adamsville-report.json".equals(s.getName())) {
                            try { s.delete(); } catch (Exception ignored) {}
                        }
                    }
                } catch (Exception ignored) {}
                File f = new File(dir, "adamsville-report.json");
                FileOutputStream fos = new FileOutputStream(f);
                try {
                    fos.write(json.getBytes("UTF-8"));
                } finally {
                    try { fos.close(); } catch (Exception ignored) { }
                }
                Uri uri = Uri.parse("content://"
                        + ReportProvider.AUTHORITY + "/" + f.getName());
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("application/json");
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_SUBJECT,
                        "Surviving Adamsville report");
                send.putExtra(Intent.EXTRA_TEXT,
                        "Diagnostics from Surviving Adamsville (see attached JSON).");
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send,
                        "Share report with Muse");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                appCtx.startActivity(chooser);
                lastShareStatus = "ok " + stamp() + " " + f.length() + "B";
                Log.i(TAG, "share sheet opened, " + f.length() + "B");
            } catch (Exception e) {
                lastShareStatus = "FAIL: " + e.getClass().getSimpleName()
                        + ": " + (e.getMessage() != null
                                ? e.getMessage() : "?");
                Log.e(TAG, "share failed", e);
            }
        });
    }

    /** Outcome of one write attempt — replaces silent swallowing.
     *  v1.3: + winStrategy/strategies so the on-device status line can say
     *  WHICH strategy was tried and its exact result (and, on success,
     *  exactly where the file lives in plain words). */
    private static class WriteOutcome {
        boolean ok = false;
        String step = "init";
        String error = "";
        long bytes = 0;
        String winStrategy = "";   // label of the strategy that won, e.g. "docs/json"
        String strategies = "";    // per-strategy tried=>result log
        String toJson(String name) {
            return "{\"status\":\"" + (ok ? "ok" : "FAIL")
                    + "\",\"step\":\"" + escStatic(step)
                    + "\",\"error\":\"" + escStatic(error)
                    + "\",\"file\":\"" + escStatic(name)
                    + "\",\"bytes\":" + bytes
                    + ",\"winStrategy\":\"" + escStatic(winStrategy)
                    + "\",\"strategies\":\"" + escStatic(strategies)
                    + "\",\"api\":" + android.os.Build.VERSION.SDK_INT
                    + ",\"t\":\"" + stamp() + "\"}";
        }
    }

    /** Creates or fully replaces the report file.
     *  v1.0: multi-strategy insert — Joshua's TCL fails at the MediaStore
     *  insert() step ("fail insert"). We now try, in order:
     *   1. Files/Documents + application/json   (the original path)
     *   2. Files/Documents + text/plain         (some OEMs filter MIME types)
     *   3. Downloads collection + application/json
     *   4. Downloads collection + text/plain
     *  using VOLUME_EXTERNAL_PRIMARY on API 29+ and the IS_PENDING
     *  protocol (insert pending -> write -> clear pending), which is the
     *  documented-correct pattern that some OEM MediaStore builds require.
     *  Every attempt is recorded in the outcome; if all fail, the status
     *  line says so in plain words and points at SHARE WITH MUSE. */
    private static WriteOutcome writeWhole(Context ctx, String content,
                                           String name) {
        WriteOutcome o = new WriteOutcome();
        StringBuilder tried = new StringBuilder();
        try {
            o.step = "resolver";
            ContentResolver cr = ctx.getContentResolver();
            String volume = (Build.VERSION.SDK_INT >= 29)
                    ? MediaStore.VOLUME_EXTERNAL_PRIMARY : "external";
            o.step = "content-uri";
            Uri filesUri = MediaStore.Files.getContentUri(volume);
            Uri dlUri = (Build.VERSION.SDK_INT >= 29)
                    ? MediaStore.Downloads.getContentUri(volume) : null;
            Uri[] uris = new Uri[]{ filesUri, filesUri, dlUri, dlUri };
            String[] paths = new String[]{ Environment.DIRECTORY_DOCUMENTS,
                    Environment.DIRECTORY_DOCUMENTS,
                    Environment.DIRECTORY_DOWNLOADS,
                    Environment.DIRECTORY_DOWNLOADS };
            String[] mimes = new String[]{ "application/json", "text/plain",
                    "application/json", "text/plain" };
            String[] labels = new String[]{ "docs/json", "docs/plain",
                    "downloads/json", "downloads/plain" };

            Uri target = null;
            for (int s = 0; s < uris.length && target == null; s++) {
                if (uris[s] == null) continue;
                o.step = "insert";
                String lastErr;
                try {
                    Uri existing = findFile(cr, uris[s], name);
                    if (existing != null) { target = existing; o.winStrategy = labels[s] + "(reuse)"; break; }
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mimes[s]);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, paths[s]);
                    if (Build.VERSION.SDK_INT >= 29)
                        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri ins = cr.insert(uris[s], v);
                    if (ins != null) { target = ins; o.winStrategy = labels[s]; break; }
                    lastErr = "insert returned null uri";
                } catch (Exception e) {
                    lastErr = e.getClass().getSimpleName() + ": "
                            + (e.getMessage() != null ? e.getMessage() : "?");
                }
                tried.append(labels[s]).append("=>").append(lastErr)
                        .append("; ");
            }
            o.strategies = tried.toString().trim();
            if (target == null) {
                o.error = "MediaStore insert failed everywhere on this phone. "
                        + "tried [" + o.strategies + "]";
                return o;
            }
            o.step = "open";
            OutputStream out = cr.openOutputStream(target, "w");
            if (out == null) {
                o.error = "openOutputStream returned null";
                return o;
            }
            o.step = "write";
            byte[] data = content.getBytes("UTF-8");
            out.write(data);
            o.step = "close";
            try { out.flush(); } catch (Exception ignored) {}  // v1.3: explicit flush
            out.close();
            o.bytes = data.length;
            if (Build.VERSION.SDK_INT >= 29) {
                o.step = "unpend";
                try {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    cr.update(target, cv, null, null);
                } catch (Exception e) {
                    // non-fatal: bytes are on disk; file may show as pending
                    Log.w(TAG, "clear IS_PENDING failed: " + e);
                }
            }
            o.ok = true;
            o.step = "done";
        } catch (Exception e) {
            o.error = e.getClass().getSimpleName() + ": "
                    + (e.getMessage() != null ? e.getMessage() : "?");
        }
        return o;
    }

    /** Legacy single-file writer (native stub). */
    private static WriteOutcome writeWhole(Context ctx, String content) {
        return writeWhole(ctx, content, FILE_NAME);
    }

    private static String stamp() {
        try {
            return new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss",
                    java.util.Locale.US).format(new java.util.Date());
        } catch (Exception e) {
            return "?";
        }
    }

    private static String escStatic(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }

    /**
     * v0.6: writes a minimal "session started" stub IMMEDIATELY at app
     * launch, with no dependency on the WebView or JS. If the game JS is
     * broken — or the bridge never gets called — this file still exists,
     * so a missing report can no longer hide a broken pipeline.
     */
    public static void writeStubNow(final Context ctx, final String ver) {
        try {
            final Context appCtx = ctx.getApplicationContext();
            WRITER.execute(() -> {
                try {
                    String device = (android.os.Build.MANUFACTURER + " "
                            + android.os.Build.MODEL).trim();
                    String osVer = android.os.Build.VERSION.RELEASE
                            + " (API " + android.os.Build.VERSION.SDK_INT
                            + ")";
                    String t = stamp();
                    String stub = "{\"app\":\"Surviving Adamsville\","
                            + "\"ver\":\"" + escStatic(ver) + "\","
                            + "\"built\":\"2026-10-07\","
                            + "\"device\":\"" + escStatic(device) + "\","
                            + "\"android\":\"" + escStatic(osVer) + "\","
                            + "\"sessionStart\":\"" + t + "\","
                            + "\"note\":\"native stub — webview not yet loaded; "
                            + "JS overwrites with full health report on first save\","
                            + "\"errors\":0,\"systems\":{\"report\":"
                            + "{\"lastWrite\":\"" + t + "\","
                            + "\"ok\":true,\"writes\":1,\"src\":\"native-stub\"}},"
                            + "\"events\":[{\"t\":\"" + t
                            + "\",\"k\":\"start\",\"src\":\"native\"}]}";
                    writeWhole(appCtx, stub);
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    /** Finds the existing report file, newest first. */
    private static Uri findFile(ContentResolver cr, Uri filesUri,
                                String name) {
        Cursor c = null;
        try {
            c = cr.query(filesUri,
                    new String[]{ MediaStore.MediaColumns._ID },
                    MediaStore.MediaColumns.DISPLAY_NAME + "=?",
                    new String[]{ name },
                    MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
            if (c != null && c.moveToFirst()) {
                return ContentUris.withAppendedId(filesUri, c.getLong(0));
            }
        } catch (Exception ignored) { }
        finally {
            if (c != null) {
                try { c.close(); } catch (Exception ignored) { }
            }
        }
        return null;
    }

    /** JSON-escape for embedding in double quotes. */
    private static String esc(String s) {
        if (s == null) return "";
        StringBuilder o = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  o.append("\\\""); break;
                case '\\': o.append("\\\\"); break;
                case '\n': o.append("\\n");  break;
                case '\r': o.append("\\r");  break;
                case '\t': o.append("\\t");  break;
                default:
                    if (c < 0x20) {
                        o.append(String.format(Locale.US, "\\u%04x",
                                (int) c));
                    } else {
                        o.append(c);
                    }
            }
        }
        return o.toString();
    }
}
