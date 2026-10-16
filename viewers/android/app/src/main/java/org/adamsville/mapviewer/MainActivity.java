package org.adamsville.mapviewer;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

// Adamsville Map Viewer (Android) - a thin native shell around the web viewer.
// The viewer itself (map UI, tabs, layers) is the SAME index.html as the web
// repo; this activity only hosts it in a WebView. Data loads live from the
// map-data repo, so this app never needs an update when the map data changes.
// Loading strategy: try the live Pages URL first; if the network load fails,
// fall back to the bundled copy in assets (data still comes from the network).
public class MainActivity extends Activity {

    private static final String LIVE_URL =
            "https://kingmarkarnold-code.github.io/map-viewer-web/";
    private static final String FALLBACK_URL = "file:///android_asset/viewer.html";

    private WebView web;
    private ProgressBar progress;
    private boolean fellBack = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // the viewer is a MapLibre web app
        s.setDomStorageEnabled(true);          // layer/tab state persistence
        s.setGeolocationEnabled(true);         // "my location" control
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);       // the map handles its own zoom gestures
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Progress bar follows page loading.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                progress.setProgress(p);
                progress.setVisibility(p >= 100 ? View.GONE : View.VISIBLE);
            }

            // Grant the page's geolocation request (the user still controls
            // the Android runtime location permission at the system level).
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
            }

            // If the live viewer cannot load (no network), swap in the
            // bundled copy once and tell the user why.
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req,
                                        WebResourceError err) {
                if (req.isForMainFrame() && !fellBack) {
                    fellBack = true;
                    Toast.makeText(MainActivity.this,
                            "Live viewer unreachable - showing bundled copy",
                            Toast.LENGTH_LONG).show();
                    view.loadUrl(FALLBACK_URL);
                }
            }
        });

        web.loadUrl(LIVE_URL);
    }

    // Hardware back walks the web history before it leaves the app.
    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
