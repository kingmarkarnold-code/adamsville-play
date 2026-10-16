#!/bin/bash
# Build the Adamsville Map Viewer .deb (NOT run yet - code-first, per Joshua).
# Layout installed:
#   /usr/bin/map-viewer                 -> launcher (python entry point)
#   /usr/lib/map-viewer/map_viewer.py   -> the GTK/WebKit app
#   /usr/share/map-viewer/viewer.html   -> bundled web viewer copy
#   /usr/share/applications/org.adamsville.mapviewer.desktop
set -e
VERSION="1.0.0"
PKG="map-viewer_${VERSION}_amd64"
ROOT="$(mktemp -d)/$PKG"
mkdir -p "$ROOT/DEBIAN" "$ROOT/usr/bin" "$ROOT/usr/lib/map-viewer" \
         "$ROOT/usr/share/map-viewer" "$ROOT/usr/share/applications"

cp src/map_viewer.py "$ROOT/usr/lib/map-viewer/map_viewer.py"
cat > "$ROOT/usr/bin/map-viewer" <<'LAUNCH'
#!/bin/sh
exec python3 /usr/lib/map-viewer/map_viewer.py "$@"
LAUNCH
chmod 755 "$ROOT/usr/bin/map-viewer"
cp share/viewer.html "$ROOT/usr/share/map-viewer/viewer.html"
cp packaging/org.adamsville.mapviewer.desktop \
   "$ROOT/usr/share/applications/org.adamsville.mapviewer.desktop"

cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: map-viewer
Version: $VERSION
Section: graphics
Priority: optional
Architecture: amd64
Depends: python3, python3-gi, gir1.2-gtk-4.0, gir1.2-webkit-6.0
Maintainer: Joshua Arnold
Description: Adamsville Map Viewer
 Reference map viewer for Surviving Adamsville. Native GTK window hosting
 the shared web viewer; map data loads live from the map-data repo.
CONTROL

dpkg-deb --build "$ROOT"
mv "$(dirname "$ROOT")/${PKG}.deb" .
echo "Built ${PKG}.deb"
