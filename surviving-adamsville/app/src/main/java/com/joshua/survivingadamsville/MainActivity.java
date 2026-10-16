package com.joshua.survivingadamsville;

import android.app.Activity;
import android.graphics.PorterDuff;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;

/**
 * Surviving Adamsville Demo — fullscreen WebView running the Three.js game.
 * Everything (engine, world, textures) is bundled locally: no permissions,
 * no network needed.
 *
 * v1.10.1: LOADING SCREEN. The game used to sit on a black screen while
 * Three.js initialized. Now a splash shows the app icon centered with a
 * neon-green progress bar along the BOTTOM (landscape layout). The bar
 * tracks WebView page load (0-80%), then the game itself fires gameReady()
 * after its first rendered frame (80-100% + fade out). A 25s failsafe hides
 * the splash no matter what — it can never trap the player.
 */
public class MainActivity extends Activity {

    private WebView webView;
    private RecorderBridge recorderBridge;  // v1.10: built-in game recorder
    private ReportBridge reportBridge;

    // v1.10.1 loading screen
    private View splashView;
    private ProgressBar splashBar;
    private volatile boolean splashHidden = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep the screen awake while playing.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Root: game WebView underneath, splash overlay on top.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF000000);

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        splashView = buildSplash();
        root.addView(splashView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        // Progress bar tracks page load; game hides the splash when ready.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                // Page load drives the bar 0-80%; the game itself finishes it.
                if (!splashHidden && splashBar != null) {
                    final int p = Math.min(80, (int) (newProgress * 0.8));
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            if (splashBar != null) splashBar.setProgress(p);
                        }
                    });
                }
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                // Failsafe: never trap the player behind the splash.
                if (splashView != null) {
                    splashView.postDelayed(new Runnable() {
                        @Override public void run() { hideSplash(); }
                    }, 25000);
                }
            }
        });

        // v0.4: JSON error/status report -> Documents ("Surviving Adamsville
        // Report.json"), same MediaStore pattern as the Voice Companion.
        reportBridge = new ReportBridge(this);
        reportBridge.setOnGameReady(new Runnable() {
            @Override public void run() { hideSplash(); }
        });
        webView.addJavascriptInterface(reportBridge, "ReportBridge");

        // v1.10: built-in game recorder (MediaProjection, low-res).
        recorderBridge = new RecorderBridge(this);
        webView.addJavascriptInterface(recorderBridge, "RecorderBridge");

        // v0.6: write the report stub IMMEDIATELY on every launch — no
        // dependency on the WebView/JS. If the game script is broken, the
        // file still exists, so telemetry can never silently vanish again.
        try {
            String v = "?";
            try {
                android.content.pm.PackageInfo pi = getPackageManager()
                        .getPackageInfo(getPackageName(), 0);
                v = pi.versionName + " (" + pi.versionCode + ")";
            } catch (Exception ignored) { }
            ReportBridge.writeStubNow(this, v);
        } catch (Exception ignored) { }

        setContentView(root);
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    /**
     * v1.10.1 loading screen: black background (landscape — the activity is
     * locked to landscape), app icon centered, neon-green progress bar
     * pinned to the BOTTOM of the screen.
     */
    private View buildSplash() {
        float density = getResources().getDisplayMetrics().density;
        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(0xFF000000);

        // App icon, centered. Loaded via PackageManager so it always matches
        // the real launcher icon — no R class needed.
        ImageView icon = new ImageView(this);
        try {
            icon.setImageDrawable(
                    getPackageManager().getApplicationIcon(getPackageName()));
        } catch (Exception ignored) { }
        int iconPx = (int) (110 * density);
        FrameLayout.LayoutParams ip = new FrameLayout.LayoutParams(
                iconPx, iconPx, Gravity.CENTER);
        splash.addView(icon, ip);

        // Neon-green progress bar along the bottom.
        ProgressBar bar = new ProgressBar(this, null,
                android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(0);
        try {
            bar.getProgressDrawable().setColorFilter(
                    0xFF39FF14, PorterDuff.Mode.SRC_IN);
        } catch (Exception ignored) { }
        bar.setScaleY(2.5f);  // chunky, readable bar
        int mPx = (int) (40 * density);
        int bPx = (int) (48 * density);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM);
        bp.setMargins(mPx, 0, mPx, bPx);
        splash.addView(bar, bp);
        splashBar = bar;

        return splash;
    }

    /** Jump to 100% and fade the splash out. Idempotent. */
    private void hideSplash() {
        if (splashHidden) return;
        splashHidden = true;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (splashBar != null) splashBar.setProgress(100);
                    if (splashView != null) {
                        splashView.animate().alpha(0f).setDuration(400)
                                .withEndAction(new Runnable() {
                                    @Override public void run() {
                                        if (splashView != null)
                                            splashView.setVisibility(View.GONE);
                                    }
                                }).start();
                    }
                } catch (Exception ignored) {
                    if (splashView != null)
                        splashView.setVisibility(View.GONE);
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode,
                                    android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        // v1.10: screen-capture consent result -> recorder bridge.
        if (requestCode == RecorderBridge.REQ_CAPTURE
                && recorderBridge != null) {
            recorderBridge.onCaptureResult(resultCode, data);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            // Immersive sticky: hide nav + status bars for the game.
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        // v1.10: never leave a recording running into a dead activity.
        try {
            if (recorderBridge != null) recorderBridge.stopRecording();
        } catch (Exception ignored) {}
        if (webView != null) {
            webView.removeAllViews();
            webView.destroy();
        }
        super.onDestroy();
    }
}
