package com.joshua.survivingadamsville;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * RecorderService (v1.10.1) — foreground service hosting the MediaProjection
 * screen recorder.
 *
 * Android 14 (API 34) REQUIRES a foreground service of type mediaProjection
 * (with the FOREGROUND_SERVICE_MEDIA_PROJECTION permission declared) before
 * MediaProjectionManager.getMediaProjection() may be called. This service
 * exists solely to satisfy that requirement; all recording logic lives in
 * RecorderBridge.
 *
 * v1.10.1: START_STICKY (so the system restarts us if killed), a public
 * foregroundReady flag the bridge waits on (some phones delay/kill
 * services — the bridge now reports that plainly instead of failing
 * silent), and startForeground failures are filed to the recorder event
 * log instead of being swallowed.
 */
public class RecorderService extends Service {

    public static final String CHANNEL_ID = "sa_recorder";
    public static final int NOTIF_ID = 4401;
    public static final String ACTION_START =
            "com.joshua.survivingadamsville.REC_START";
    public static final String ACTION_STOP =
            "com.joshua.survivingadamsville.REC_STOP";

    /** v1.10.1: true once startForeground() succeeded. The bridge waits on this. */
    public static volatile boolean foregroundReady = false;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
                        "Screen recorder", NotificationManager.IMPORTANCE_LOW);
                ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                        .createNotificationChannel(ch);
            } catch (Exception e) {
                RecorderBridge.logEv("recorder-error",
                        "Could not create recorder notification channel: "
                                + e.getMessage());
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = buildNotif();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIF_ID, n);
            }
            foregroundReady = true;
        } catch (Exception e) {
            // v1.10.1: NEVER swallow this — it's the #1 suspect when
            // getMediaProjection() later throws SecurityException.
            foregroundReady = false;
            RecorderBridge.logEv("recorder-error",
                    "Recorder service could not go foreground: "
                    + (e.getMessage() != null ? e.getMessage()
                            : e.getClass().getSimpleName())
                    + " — the phone may be blocking it.");
        }
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopSelf();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        foregroundReady = false;
        super.onDestroy();
    }

    private Notification buildNotif() {
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("Surviving Adamsville")
         .setContentText("Screen recorder ready")
         .setSmallIcon(android.R.drawable.presence_video_online)
         .setOngoing(true);
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
