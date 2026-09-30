"""Runtime paths for the standalone Chrome browser-control skill."""

from __future__ import annotations

import os
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[2]
EXTENSION_DIR = SKILL_ROOT / "assets" / "chrome-extension"
PROTOCOL_PATH = EXTENSION_DIR / "bridge_protocol.json"


def data_dir() -> Path:
    """Return the user-writable runtime directory without touching it."""

    configured = os.environ.get("CHROME_BROWSER_CONTROL_HOME", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".chrome-browser-control"


def ensure_data_dir() -> Path:
    path = data_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path


def token_path() -> Path:
    return data_dir() / "bridge-token"


def log_dir() -> Path:
    return data_dir() / "logs"


def evidence_dir() -> Path:
    return data_dir() / "evidence"


def lease_path() -> Path:
    return data_dir() / "page-leases.json"


def session_path() -> Path:
    return data_dir() / "sessions.json"


def upload_policy_path() -> Path:
    return data_dir() / "upload-policy.json"
