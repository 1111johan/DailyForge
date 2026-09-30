"""Executable wrapper for the Chrome browser-control CLI.

Run this file directly from a checkout or after installing the skill:
``python scripts/browser.py pages``.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from chrome_control.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
