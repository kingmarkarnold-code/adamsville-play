# github_roundtrip.py — COMPATIBILITY SHIM (2026-10-18).
#
# This flat module was merged into the suite_core package
# (EXTRACTION-REPORT.md section 4, executed 2026-10-18): the one
# canonical implementation now lives at suite_core/github_sync.py.
# This file remains so existing imports (`import github_roundtrip`) keep
# working — it hands the importer the package module itself, so
# there is exactly ONE implementation object in play, never a
# second copy to drift. New code should import suite_core.github_sync.
# The pre-merge original is preserved in
# ~/workspace/editors/suite-core-backup-2026-10-18-pre-merge/.
import sys as _sys

from suite_core import github_sync as _canonical

_sys.modules[__name__] = _canonical
