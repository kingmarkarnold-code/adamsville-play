#!/usr/bin/env python3
"""
Adamsville Suite — shared About dialog helper.

Shows the app's own icon next to Joshua's Mollie icon, the app name,
a prominent version number, and the credit text Joshua asked for
(2026-10-11):

  "This application was created with the help of Mollie, Meta's AI."
  "Co-created with developer Joshua Arnold."

Used by all four suite apps (map, terrain, UI, building editors).
Each app calls show_about_dialog() from its Help -> About menu item.

The Mollie icon is installed by each .deb at:
    /usr/share/<package-name>/mollie-icon.png
If it is missing at runtime, the dialog still works — it just shows
the app icon alone.

Joshua's rule: all code commented.
"""

from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GdkPixbuf


# Pixel size for both icons in the dialog.
ICON_SIZE = 96


def _find_mollie_icon(package_name):
    """
    Locate the Mollie icon PNG.

    Checks the installed location first (/usr/share/<package>/...),
    then falls back to a copy next to this module (dev runs).
    Returns the path string, or None if not found.
    """
    candidates = [
        Path(f"/usr/share/{package_name}/mollie-icon.png"),
        Path(__file__).parent / "mollie-icon.png",
    ]
    for path in candidates:
        try:
            if path.exists():
                return str(path)
        except Exception:
            continue
    return None


def _load_app_icon(icon_name):
    """
    Load the app's own icon from the GTK icon theme at ICON_SIZE.

    Returns a GdkPixbuf.Pixbuf, or None if the theme has no such icon.
    """
    try:
        theme = Gtk.IconTheme.get_default()
        return theme.load_icon(icon_name, ICON_SIZE, 0)
    except Exception:
        return None


def show_about_dialog(parent_window, app_name, version, icon_name,
                      package_name):
    """
    Build and run the About dialog.

    parent_window: the app's main Gtk.Window (for modality).
    app_name:      display name, e.g. "Adamsville Map Editor".
    version:       version string, e.g. "1.2.1" (shown prominently).
    icon_name:     GTK icon-theme name for the app's own icon.
    package_name:  deb package name, used to find mollie-icon.png.
    """
    dialog = Gtk.Dialog(title=f"About {app_name}",
                        transient_for=parent_window,
                        flags=Gtk.DialogFlags.MODAL)
    dialog.set_default_size(460, 380)
    dialog.add_button("Close", Gtk.ResponseType.CLOSE)

    content = dialog.get_content_area()
    content.set_spacing(10)
    content.set_border_width(16)

    # -- icons row: app icon on the left, Mollie icon on the right ----
    icons_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=24)
    icons_box.set_halign(Gtk.Align.CENTER)

    app_pixbuf = _load_app_icon(icon_name)
    if app_pixbuf is not None:
        app_image = Gtk.Image.new_from_pixbuf(app_pixbuf)
        icons_box.pack_start(app_image, False, False, 0)

    mollie_path = _find_mollie_icon(package_name)
    if mollie_path is not None:
        try:
            mollie_pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(
                mollie_path, ICON_SIZE, ICON_SIZE)
            mollie_image = Gtk.Image.new_from_pixbuf(mollie_pixbuf)
            mollie_image.set_tooltip_text("Mollie — Meta's AI")
            icons_box.pack_start(mollie_image, False, False, 0)
        except Exception:
            # Corrupt/unreadable icon file — show the app icon alone.
            pass

    content.pack_start(icons_box, False, False, 0)

    # -- app name (large, bold) ----------------------------------------
    name_label = Gtk.Label()
    name_label.set_markup(
        f'<span size="x-large" weight="bold">{app_name}</span>')
    content.pack_start(name_label, False, False, 0)

    # -- version number (prominent — Joshua specifically asked) --------
    version_label = Gtk.Label()
    version_label.set_markup(
        f'<span size="large" weight="bold">Version {version}</span>')
    content.pack_start(version_label, False, False, 0)

    # -- credit text ----------------------------------------------------
    credits = (
        "This application was created with the help of\n"
        "Mollie, Meta's AI.\n\n"
        "Co-created with developer Joshua Arnold.\n\n"
        "Part of the Adamsville 3D World Gaming Suite.\n"
        "Native Linux application — no web browser required."
    )
    credit_label = Gtk.Label(label=credits)
    credit_label.set_justify(Gtk.Justification.CENTER)
    credit_label.set_line_wrap(True)
    content.pack_start(credit_label, False, False, 0)

    dialog.show_all()
    dialog.run()
    dialog.destroy()
