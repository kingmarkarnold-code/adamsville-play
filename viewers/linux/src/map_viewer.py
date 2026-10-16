#!/usr/bin/env python3
# Adamsville Map Viewer - Linux desktop app (GTK4 + WebKitGTK).
#
# A real installed desktop application (Graphics menu), following the same
# pattern as Joshua's editor suite: a native GTK window hosting the map
# viewer. The viewer UI itself is the shared web viewer (viewer.html,
# bundled); all map DATA loads live from the map-data repo, so data updates
# never require an app update. Use the header-bar globe button to switch to
# the fully live web viewer page instead of the bundled copy.
#
# Written 2026-10-14 (code only; packaging not yet built, per Joshua).

import os
import sys

import gi

# Prefer WebKitGTK 6.0 (GTK4); fall back to 4.1 (GTK3-era) if that's what
# the system ships.
try:
    gi.require_version("Gtk", "4.0")
    gi.require_version("WebKit", "6.0")
    from gi.repository import Gtk, WebKit

    WEBKIT6 = True
except (ValueError, ImportError):
    gi.require_version("Gtk", "3.0")
    gi.require_version("WebKit2", "4.1")
    from gi.repository import Gtk, WebKit2 as WebKit

    WEBKIT6 = False

APP_ID = "org.adamsville.mapviewer"
LIVE_URL = "https://kingmarkarnold-code.github.io/map-viewer-web/"
SHARE_DIR = "/usr/share/map-viewer"
LOCAL_VIEWER = os.path.join(SHARE_DIR, "viewer.html")
# When running uninstalled from the repo, use the sibling share/ copy.
if not os.path.exists(LOCAL_VIEWER):
    LOCAL_VIEWER = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "share", "viewer.html"
    )


class ViewerWindow(Gtk.ApplicationWindow):
    """Main window: header bar (reload / live / about) + the WebView."""

    def __init__(self, app):
        super().__init__(application=app, title="Adamsville Map Viewer")
        self.set_default_size(1280, 800)

        # --- WebView with the settings the map app needs.
        self.web = WebKit.WebView()
        settings = self.web.get_settings()
        settings.set_enable_javascript(True)
        settings.set_enable_webgl(True)
        settings.set_enable_media_stream(False)
        if WEBKIT6:
            settings.set_hardware_acceleration_policy(
                WebKit.HardwareAccelerationPolicy.ALWAYS
            )

        # --- Header bar with the app's few native actions.
        header = Gtk.HeaderBar()
        reload_btn = Gtk.Button(label="Reload")
        reload_btn.connect("clicked", lambda *_: self.web.reload())
        header.pack_start(reload_btn)

        live_btn = Gtk.Button(label="Open live viewer")
        live_btn.connect("clicked", lambda *_: self.web.load_uri(LIVE_URL))
        header.pack_start(live_btn)

        about_btn = Gtk.Button(label="About")
        about_btn.connect("clicked", self._about)
        header.pack_end(about_btn)
        self.set_titlebar(header)

        # Content: scrolled-less WebView fills the window.
        if WEBKIT6 or hasattr(self, "set_child"):
            self.set_child(self.web)
        else:  # GTK3 fallback
            self.add(self.web)

        # Bundled viewer first (works offline except data), live available
        # from the header bar.
        if os.path.exists(LOCAL_VIEWER):
            self.web.load_uri("file://" + os.path.abspath(LOCAL_VIEWER))
        else:
            self.web.load_uri(LIVE_URL)
        self.show_all() if hasattr(self, "show_all") else self.present()

    def _about(self, *_):
        dialog = Gtk.AboutDialog(transient_for=self, modal=True)
        dialog.set_program_name("Adamsville Map Viewer")
        dialog.set_version("1.0.0")
        dialog.set_comments(
            "Reference map viewer for Surviving Adamsville.\n"
            "Data: map-data repo (live). Viewer: shared web viewer."
        )
        dialog.present()


def main():
    app = Gtk.Application(application_id=APP_ID)
    app.connect("activate", lambda a: ViewerWindow(a))
    return app.run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
