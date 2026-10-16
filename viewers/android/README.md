# Adamsville Map Viewer — Android (code only, not yet compiled)

Native shell (single Activity + WebView, no frameworks) around the web
viewer. Code was written 2026-10-14 per Joshua's instruction to start all
three viewers without compiling the APK/.deb yet.

## Layout
- `app/src/main/java/org/adamsville/mapviewer/MainActivity.java` — the app.
  Loads the live web viewer; falls back to the bundled copy in assets when
  the network is unreachable. Data always comes from the map-data repo.
- `app/src/main/assets/viewer.html` — bundled copy of the web viewer
  (same file as map-viewer-web's index.html; refresh it when the web
  viewer changes).
- Gradle project: AGP 8.5.2, compileSdk 34, minSdk 26, Java 17.

## Build (when Joshua says go)
1. Open in Android Studio, or `./gradlew assembleRelease`.
2. Sign with the existing release keystore (same key as the game APK).
3. Output: `app/build/outputs/apk/release/`.
