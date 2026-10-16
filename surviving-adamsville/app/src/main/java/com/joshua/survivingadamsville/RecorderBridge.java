package com.joshua.survivingadamsville;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * RecorderBridge (v1.10.1) — built-in game recorder for Joshua's test sessions.
 *
 * Uses Android's MediaProjection API (no root, no extra runtime permissions).
 * Records LOW-res video only: 640x360, 24fps, ~1.5Mbps H.264 — small files
 * are the point (test snippets for upload, not cinema). Video only, no
 * audio: keeps it permission-free.
 *
 * Storage: Movies/SurvivingAdamsville/ via MediaStore, files named
 * adamsville-YYYYMMDD-HHmmss.mp4. Total capped at 500MB — oldest
 * recordings are deleted first (rotation).
 *
 * v1.10.1 — NO SILENT FAILURES. Every step and every failure is written
 * to a timestamped event log in plain words. The game's JS drains the log
 * and files it in the diagnostic report, so if Record fails Joshua (and
 * the QA crew) can see exactly which step broke and why.
 *
 * v1.10.1 hardening (from the v1.10 field failure on Joshua's TCL):
 *  - beginCapture runs off the UI thread; it waits briefly for the
 *    foreground service to actually reach foreground state (some phones
 *    delay/kill services) and reports plainly if it never does.
 *  - SecurityException from getMediaProjection() is caught separately
 *    with a plain-words explanation instead of a cryptic message.
 *  - A MediaProjection.Callback reports if the SYSTEM kills the session.
 */
public class RecorderBridge {

    private static final String TAG = "SARecorder";
    public static final int REQ_CAPTURE = 7701;

    // Recording profile: small files are the point. ~1.5Mbps ~= 11MB/min.
    private static final int REC_W = 640;
    private static final int REC_H = 360;
    private static final int REC_FPS = 24;
    private static final int REC_BITRATE = 1_500_000;

    // 500MB total cap for recordings.
    private static final long CAP_BYTES = 500L * 1024L * 1024L;
    private static final String REL_PATH =
            Environment.DIRECTORY_MOVIES + "/SurvivingAdamsville";
    private static final String NAME_PREFIX = "adamsville-";

    /* ---------------- plain-words event log (v1.10.1) ---------------- */
    private static final ArrayList<String[]> REC_EVENTS = new ArrayList<String[]>();
    private static final int MAX_EVENTS = 60;

    /** Package-visible so RecorderService can file its own events. */
    static void logEv(String kind, String detail) {
        synchronized (REC_EVENTS) {
            String t = new SimpleDateFormat("HH:mm:ss", Locale.US)
                    .format(new Date());
            REC_EVENTS.add(new String[]{t, kind, detail});
            while (REC_EVENTS.size() > MAX_EVENTS) REC_EVENTS.remove(0);
        }
        Log.i(TAG, "[" + kind + "] " + detail);
    }

    /** JS drains this into the game report; returns JSON array, then clears. */
    @JavascriptInterface
    public String drainRecorderEvents() {
        synchronized (REC_EVENTS) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < REC_EVENTS.size(); i++) {
                String[] e = REC_EVENTS.get(i);
                if (i > 0) sb.append(",");
                sb.append("{\"t\":\"").append(e[0]).append("\",\"k\":\"")
                  .append(esc(e[1])).append("\",\"d\":\"")
                  .append(esc(e[2])).append("\"}");
            }
            sb.append("]");
            REC_EVENTS.clear();
            return sb.toString();
        }
    }

    private final Activity activity;
    private final Context appCtx;
    private final MediaProjectionManager projManager;
    private final ExecutorService bg = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private MediaRecorder recorder;
    private ParcelFileDescriptor pfd;
    private Uri pendingUri;

    private volatile boolean recording = false;
    private volatile String lastError = "";
    private volatile String currentFile = "";

    public RecorderBridge(Activity activity) {
        this.activity = activity;
        this.appCtx = activity.getApplicationContext();
        this.projManager = (MediaProjectionManager)
                appCtx.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    }

    /** JS: begin a recording (fires the system consent dialog first). */
    @JavascriptInterface
    public void startRecording() {
        try {
            if (recording) return;
            if (projManager == null) {
                lastError = "This phone has no screen-capture feature";
                logEv("recorder-error", lastError);
                return;
            }
            lastError = "";
            logEv("recorder", "Record tapped — starting recorder");
            enforceCap();  // make room BEFORE we start
            // Foreground service first (API 34 requirement for MediaProjection).
            Intent svc = new Intent(appCtx, RecorderService.class);
            svc.setAction(RecorderService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) {
                appCtx.startForegroundService(svc);
            } else {
                appCtx.startService(svc);
            }
            logEv("recorder", "Recorder service started, asking system for capture permission…");
            // System consent — must run on the UI thread.
            activity.runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        Intent cap = projManager.createScreenCaptureIntent();
                        activity.startActivityForResult(cap, REQ_CAPTURE);
                    } catch (Exception e) {
                        lastError = "Could not open the system capture dialog: "
                                + safeMsg(e);
                        logEv("recorder-error", lastError);
                        stopService();
                    }
                }
            });
        } catch (Exception e) {
            lastError = "Recorder failed to start: " + safeMsg(e);
            logEv("recorder-error", lastError);
        }
    }

    /** Called from MainActivity.onActivityResult — runs on the UI thread. */
    public void onCaptureResult(int resultCode, Intent data) {
        final int rc = resultCode;
        final Intent d = data;
        // Off the UI thread: beginCapture may wait on the service.
        bg.execute(new Runnable() {
            @Override public void run() {
                handleCaptureResult(rc, d);
            }
        });
    }

    private void handleCaptureResult(int resultCode, Intent data) {
        try {
            if (resultCode != Activity.RESULT_OK || data == null) {
                lastError = "Screen-capture permission was denied (you tapped "
                        + "\"Don't start\" or dismissed the dialog). Tap Record and "
                        + "choose \"Start now\" to allow it.";
                logEv("recorder-error", lastError);
                stopService();
                return;
            }
            logEv("recorder", "Capture permission granted by system");
            beginCapture(resultCode, data);
        } catch (SecurityException se) {
            lastError = "The phone's system blocked screen capture. The recorder "
                    + "service may have been stopped by the phone (battery "
                    + "optimization). Try tapping Record again; if it keeps "
                    + "failing, check battery settings for this app. ("
                    + safeMsg(se) + ")";
            logEv("recorder-error", lastError);
            teardown();
        } catch (Exception e) {
            lastError = "Recorder failed: " + plainWhy(e);
            logEv("recorder-error", lastError + " [" + e.getClass().getSimpleName() + "]");
            teardown();
        }
    }

    /** Translate technical failures into Joshua-readable reasons. */
    private static String plainWhy(Exception e) {
        String m = safeMsg(e);
        if (m.contains("null projection"))
            return "the system didn't hand back a capture session — try again. (" + m + ")";
        if (m.contains("MediaStore insert null"))
            return "could not create the video file in Movies/SurvivingAdamsville — storage may be unavailable. (" + m + ")";
        if (m.contains("null file descriptor"))
            return "could not open the video file for writing. (" + m + ")";
        if (m.contains("foreground service not ready"))
            return m; // already plain
        if (e instanceof java.io.IOException)
            return "the phone's video encoder refused to start (" + m + ") — try again; some phones need a retry on the first attempt.";
        return m;
    }

    private void beginCapture(int resultCode, Intent data) throws Exception {
        // v1.10.1: make sure the foreground service actually reached
        // foreground state — some phones (TCL battery manager) delay or
        // kill it, and getMediaProjection() then throws SecurityException.
        long t0 = SystemClock.uptimeMillis();
        while (!RecorderService.foregroundReady
                && SystemClock.uptimeMillis() - t0 < 2500) {
            try { Thread.sleep(100); } catch (InterruptedException ignored) {}
        }
        if (!RecorderService.foregroundReady) {
            throw new Exception("foreground service not ready: the recorder "
                    + "service never reached foreground state. The phone may "
                    + "be killing background services — try again, and check "
                    + "battery optimization settings for Surviving Adamsville "
                    + "if it keeps failing.");
        }

        projection = projManager.getMediaProjection(resultCode, data);
        if (projection == null) throw new Exception("null projection");
        logEv("recorder", "Capture session opened");

        // If the SYSTEM kills our session, say so plainly (no silent death).
        try {
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() {
                    logEv("recorder-error",
                            "The phone's system stopped the capture session.");
                    recording = false;
                }
            }, new Handler(Looper.getMainLooper()));
        } catch (Exception e) {
            logEv("recorder", "Could not watch for system stop: " + safeMsg(e));
        }

        // MediaStore entry (pending) -> file descriptor for MediaRecorder.
        ContentResolver cr = appCtx.getContentResolver();
        Uri coll = (Build.VERSION.SDK_INT >= 29)
                ? MediaStore.Video.Media.getContentUri(
                        MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        String name = NAME_PREFIX + new SimpleDateFormat("yyyyMMdd-HHmmss",
                Locale.US).format(new Date()) + ".mp4";
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4");
        if (Build.VERSION.SDK_INT >= 29) {
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, REL_PATH);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        }
        pendingUri = cr.insert(coll, v);
        if (pendingUri == null) throw new Exception("MediaStore insert null");
        pfd = cr.openFileDescriptor(pendingUri, "w");
        if (pfd == null) throw new Exception("null file descriptor");
        currentFile = name;
        logEv("recorder", "Video file created: " + name);

        recorder = (Build.VERSION.SDK_INT >= 31)
                ? new MediaRecorder(appCtx)
                : new MediaRecorder();
        recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
        recorder.setVideoSize(REC_W, REC_H);
        recorder.setVideoFrameRate(REC_FPS);
        recorder.setVideoEncodingBitRate(REC_BITRATE);
        recorder.setOutputFile(pfd.getFileDescriptor());
        recorder.prepare();
        logEv("recorder", "Video encoder ready (640x360, 24fps)");

        virtualDisplay = projection.createVirtualDisplay("SA-Recorder",
                REC_W, REC_H, 160,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                recorder.getSurface(), null, null);

        recorder.start();
        recording = true;
        logEv("recorder", "RECORDING STARTED -> " + name);
    }

    /** JS: stop the recording and finalize the file. Safe no-op when idle. */
    @JavascriptInterface
    public void stopRecording() {
        try {
            if (!recording && recorder == null) { stopService(); return; }
            teardown();
            enforceCap();
        } catch (Exception e) {
            lastError = "Recorder failed to stop cleanly: " + safeMsg(e);
            logEv("recorder-error", lastError);
        }
    }

    private void teardown() {
        recording = false;
        String finishedFile = currentFile;
        long finishedSize = -1;
        try {
            if (recorder != null) {
                try { recorder.stop(); } catch (Exception ignored) {}
                try { recorder.reset(); } catch (Exception ignored) {}
                try { recorder.release(); } catch (Exception ignored) {}
            }
        } finally { recorder = null; }
        try {
            if (virtualDisplay != null) virtualDisplay.release();
        } catch (Exception ignored) { } finally { virtualDisplay = null; }
        try {
            if (projection != null) projection.stop();
        } catch (Exception ignored) { } finally { projection = null; }
        // Finalize the MediaStore entry so it appears in the gallery.
        // Read the size BEFORE clearing pending so we can report it.
        try {
            if (pendingUri != null) {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    appCtx.getContentResolver().update(pendingUri, cv, null, null);
                }
                Cursor c = null;
                try {
                    c = appCtx.getContentResolver().query(pendingUri,
                            new String[]{ MediaStore.MediaColumns.SIZE },
                            null, null, null);
                    if (c != null && c.moveToFirst()) finishedSize = c.getLong(0);
                } catch (Exception ignored) { }
                finally { if (c != null) try { c.close(); } catch (Exception ignored) {} }
            }
        } catch (Exception ignored) { } finally { pendingUri = null; }
        try {
            if (pfd != null) pfd.close();
        } catch (Exception ignored) { } finally { pfd = null; }
        if (!finishedFile.isEmpty()) {
            String sizeTxt = finishedSize >= 0
                    ? (" (" + (finishedSize / 1024) + " KB)") : "";
            logEv("recorder", "RECORDING STOPPED -> " + finishedFile + sizeTxt
                    + " — saved in Movies/SurvivingAdamsville/");
        } else {
            logEv("recorder", "Recorder stopped (no file was being written)");
        }
        currentFile = "";
        stopService();
    }

    private void stopService() {
        try {
            Intent svc = new Intent(appCtx, RecorderService.class);
            svc.setAction(RecorderService.ACTION_STOP);
            appCtx.startService(svc);
        } catch (Exception ignored) {}
    }

    /** JS: pollable status JSON. */
    @JavascriptInterface
    public String getStatus() {
        return "{\"recording\":" + recording
                + ",\"file\":\"" + esc(currentFile) + "\""
                + ",\"error\":\"" + esc(lastError) + "\"}";
    }

    /**
     * Delete oldest recordings while our files are over the 500MB cap.
     * Matches DISPLAY_NAME LIKE 'adamsville-%' (works on all API levels;
     * RELATIVE_PATH filtering is API 29+ only).
     */
    private void enforceCap() {
        Cursor c = null;
        try {
            ContentResolver cr = appCtx.getContentResolver();
            Uri coll = (Build.VERSION.SDK_INT >= 29)
                    ? MediaStore.Video.Media.getContentUri(
                            MediaStore.VOLUME_EXTERNAL_PRIMARY)
                    : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            c = cr.query(coll,
                    new String[]{ MediaStore.MediaColumns._ID,
                            MediaStore.MediaColumns.SIZE },
                    MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                    new String[]{ NAME_PREFIX + "%" },
                    MediaStore.MediaColumns.DATE_ADDED + " ASC");
            if (c == null) return;
            long total = 0;
            ArrayList<long[]> rows = new ArrayList<long[]>();
            while (c.moveToNext()) {
                long id = c.getLong(0);
                long sz = c.getLong(1);
                rows.add(new long[]{ id, sz });
                total += sz;
            }
            for (int i = 0; i < rows.size(); i++) {
                if (total <= CAP_BYTES) break;
                long[] r = rows.get(i);
                Uri u = Uri.withAppendedPath(coll, String.valueOf(r[0]));
                try {
                    int n = cr.delete(u, null, null);
                    if (n > 0) {
                        total -= r[1];
                        logEv("recorder", "Deleted oldest recording to stay under "
                                + "500MB (freed " + (r[1] / 1024) + " KB)");
                    }
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            logEv("recorder", "Storage check failed: " + safeMsg(e));
        } finally {
            if (c != null) {
                try { c.close(); } catch (Exception ignored) {}
            }
        }
    }

    private static String safeMsg(Exception e) {
        return e.getMessage() != null ? e.getMessage()
                : e.getClass().getSimpleName();
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
