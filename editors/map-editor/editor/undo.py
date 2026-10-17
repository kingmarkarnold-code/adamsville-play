#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Undo/Redo manager.

Command-pattern undo/redo for map edits (Joshua 2026-10-12: "The map
editor needs a undo").

Each edit operation pushes ONE UndoCommand onto the stack. A command
stores a human-readable label plus before/after snapshots of the full
map state (roads, overpasses, zones). Undo restores the before state,
redo restores the after state. Because the snapshots are full-state
(memento style), every kind of edit is covered without each tool
needing its own hand-written inverse logic:
  - road joins, merges, extends, deletes
  - road category / appearance / divided-section changes
  - cul-de-sac add/remove
  - overpass linking
  - zone boundary edits and new zones
  - 3D inspector endpoint snaps

The stacks are capped at MAX_DEPTH entries (default 50) — pushing a
new command drops the oldest undo entry. Pushing a new command always
clears the redo stack (standard behavior: a new edit invalidates the
redo future).

Joshua's rule: all code commented.
"""

# Maximum undo steps kept (Joshua's spec: at least 50).
MAX_DEPTH = 50


class UndoCommand:
    """
    One undoable edit.

    label: short human description shown in the Edit menu, e.g.
        "Join Roads" -> the menu reads "Undo: Join Roads".
    before / after: opaque map-state snapshots (whatever the caller
        uses — here dicts of deep-copied data). The manager never
        inspects them; it just hands them back to the caller's
        restore callback.
    """

    def __init__(self, label, before, after):
        # Human-readable description of the edit.
        self.label = label
        # Full map state before the edit (restored by undo).
        self.before = before
        # Full map state after the edit (restored by redo).
        self.after = after

    def __repr__(self):
        return "UndoCommand(%r)" % (self.label,)


class UndoManager:
    """
    Command-pattern undo/redo stacks.

    The caller pushes commands, then calls undo()/redo() which return
    the command to apply; the caller restores the snapshot itself via
    its own _map_state_restore(state) and refreshes the UI. This keeps
    GTK out of this module so the logic is headless-testable.
    """

    def __init__(self, max_depth=MAX_DEPTH):
        # Number of undo steps retained.
        self.max_depth = max_depth
        # Stack of commands that can be undone (oldest first).
        self._undo = []
        # Stack of commands that can be redone (most recent undo last).
        self._redo = []

    # ------------------------------------------------------------------
    # Stack management
    # ------------------------------------------------------------------

    def push(self, command):
        """
        Record a newly completed edit.

        The redo stack is cleared because the new edit happened after
        the undone state — the old redo future no longer applies.
        If the undo stack is full, the oldest entry is dropped.
        """
        self._undo.append(command)
        # New edit invalidates any redo future.
        self._redo.clear()
        # Cap the undo history; drop the oldest first.
        while len(self._undo) > self.max_depth:
            self._undo.pop(0)

    def undo(self):
        """
        Pop the most recent command for undoing.

        Returns the UndoCommand, or None if there is nothing to undo.
        The command is moved to the redo stack so redo() can re-apply
        it later.
        """
        if not self._undo:
            return None
        command = self._undo.pop()
        self._redo.append(command)
        return command

    def redo(self):
        """
        Pop the most recently undone command for re-applying.

        Returns the UndoCommand, or None if there is nothing to redo.
        The command moves back onto the undo stack.
        """
        if not self._redo:
            return None
        command = self._redo.pop()
        self._undo.append(command)
        return command

    def clear(self):
        """Drop all undo and redo history (e.g. after a fresh download)."""
        self._undo.clear()
        self._redo.clear()

    # ------------------------------------------------------------------
    # Introspection (for menu labels / button sensitivity)
    # ------------------------------------------------------------------

    def can_undo(self):
        """True when there is at least one edit to undo."""
        return bool(self._undo)

    def can_redo(self):
        """True when there is at least one undone edit to redo."""
        return bool(self._redo)

    def undo_label(self):
        """
        Label of the next undo target, or None.

        Used for the Edit menu item: "Undo: Join Roads".
        """
        if not self._undo:
            return None
        return self._undo[-1].label

    def redo_label(self):
        """
        Label of the next redo target, or None.

        Used for the Edit menu item: "Redo: Join Roads".
        """
        if not self._redo:
            return None
        return self._redo[-1].label

    def undo_count(self):
        """Number of undoable steps (for tests / debugging)."""
        return len(self._undo)

    def redo_count(self):
        """Number of redoable steps (for tests / debugging)."""
        return len(self._redo)
