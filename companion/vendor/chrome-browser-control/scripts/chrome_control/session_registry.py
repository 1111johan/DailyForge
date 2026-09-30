"""Atomic runtime ownership records for browser sessions started by the CLI."""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .runtime_paths import session_path


def default_registry_path() -> Path:
    return session_path()


def new_owner_token() -> str:
    return secrets.token_urlsafe(24)


def _load(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "sessions": {}}
    if not isinstance(payload, dict) or not isinstance(payload.get("sessions"), dict):
        return {"version": 1, "sessions": {}}
    return payload


def _save(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, raw_temp = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def session_key(provider: str, port: int) -> str:
    return f"{str(provider or '').strip().lower()}:{int(port)}"


def get_session(
    provider: str,
    port: int,
    *,
    path: Path | None = None,
) -> dict[str, Any]:
    registry = _load(path or default_registry_path())
    row = registry["sessions"].get(session_key(provider, port)) or {}
    return dict(row) if isinstance(row, dict) else {}


def save_session(
    *,
    provider: str,
    port: int,
    browser_session_id: str,
    owned: bool,
    owner_token: str,
    process_id: int | None = None,
    window_ids=(),
    provider_key: str = "",
    path: Path | None = None,
) -> dict[str, Any]:
    target = path or default_registry_path()
    registry = _load(target)
    row = {
        "provider": str(provider),
        "provider_key": str(provider_key or provider),
        "port": int(port),
        "browser_session_id": str(browser_session_id or ""),
        "owned": bool(owned),
        "owner_token": str(owner_token or ""),
        "process_id": int(process_id) if process_id not in (None, "") else None,
        "window_ids": sorted({str(value) for value in window_ids if str(value or "")}),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    registry["sessions"][session_key(provider, port)] = row
    _save(target, registry)
    return dict(row)


def remove_session(provider: str, port: int, *, path: Path | None = None) -> None:
    target = path or default_registry_path()
    registry = _load(target)
    registry["sessions"].pop(session_key(provider, port), None)
    _save(target, registry)
