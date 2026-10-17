# Adamsville Map Viewer — Linux (code only, not yet compiled)

Native GTK4 + WebKitGTK desktop app in the same pattern as the editor
suite: installs to the Graphics menu and behaves like a desktop app.
Code written 2026-10-14 per Joshua's instruction to start all three
viewers without building the .deb yet.

## Layout
- `src/map_viewer.py` — the app (header bar: Reload / Open live viewer /
  About; WebView with JS + WebGL enabled).
- `share/viewer.html` — bundled copy of the web viewer (same file as
  map-viewer-web's index.html). Data still loads live from map-data.
- `packaging/org.adamsville.mapviewer.desktop` — Graphics-menu entry.
- `build-deb.sh` — stages the package and runs dpkg-deb (depends:
  python3-gi, GTK 4, WebKitGTK 6).

## Build (when Joshua says go)
`./build-deb.sh` produces `map-viewer_1.0.0_amd64.deb`; install with
`sudo dpkg -i map-viewer_1.0.0_amd64.deb`.
