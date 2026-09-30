"""Validation and persistence for opt-in local file uploads."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .runtime_paths import ensure_data_dir, upload_policy_path


ALLOWED_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})
MAX_UPLOAD_FILES = 20
MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024


def _resolved_directory(value: str | os.PathLike[str]) -> Path:
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise ValueError("upload root must be an existing directory")
    if os.name == "nt" and str(path).startswith("\\\\"):
        raise ValueError("network upload roots are not supported")
    return path


def load_upload_roots(path: Path | None = None) -> list[Path]:
    policy_path = path or upload_policy_path()
    try:
        payload = json.loads(policy_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("upload policy is unreadable") from exc
    roots = payload.get("roots") if isinstance(payload, dict) else None
    if not isinstance(roots, list):
        raise ValueError("upload policy roots must be a list")
    resolved: list[Path] = []
    for raw in roots:
        try:
            root = _resolved_directory(str(raw or ""))
        except (OSError, ValueError):
            continue
        if root not in resolved:
            resolved.append(root)
    return resolved


def add_upload_root(value: str | os.PathLike[str], path: Path | None = None) -> int:
    root = _resolved_directory(value)
    policy_path = path or upload_policy_path()
    existing = load_upload_roots(policy_path)
    if root not in existing:
        existing.append(root)
    ensure_data_dir()
    payload = {
        "version": 1,
        "roots": [str(item) for item in existing],
    }
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=policy_path.name + ".",
        suffix=".tmp",
        dir=str(policy_path.parent),
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        if os.name != "nt":
            temporary_path.chmod(0o600)
        temporary_path.replace(policy_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return len(existing)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _validate_image_signature(path: Path) -> None:
    try:
        with path.open("rb") as handle:
            header = handle.read(16)
    except OSError as exc:
        raise ValueError("upload file could not be read") from exc
    suffix = path.suffix.lower()
    valid = (
        (suffix == ".png" and header.startswith(b"\x89PNG\r\n\x1a\n"))
        or (suffix in {".jpg", ".jpeg"} and header.startswith(b"\xff\xd8\xff"))
        or (
            suffix == ".webp"
            and len(header) >= 12
            and header.startswith(b"RIFF")
            and header[8:12] == b"WEBP"
        )
    )
    if not valid:
        raise ValueError("upload file content does not match its image extension")


def validate_upload_files(
    values: object,
    *,
    roots: list[Path] | None = None,
) -> tuple[list[Path], int]:
    if not isinstance(values, (list, tuple)):
        raise ValueError("filePaths must be a list")
    if not 1 <= len(values) <= MAX_UPLOAD_FILES:
        raise ValueError(f"upload requires between 1 and {MAX_UPLOAD_FILES} files")
    allowed_roots = list(roots if roots is not None else load_upload_roots())
    if not allowed_roots:
        raise ValueError("file upload is disabled until an upload root is configured")
    resolved: list[Path] = []
    total_bytes = 0
    for raw in values:
        text = str(raw or "")
        if not text or "\x00" in text:
            raise ValueError("upload file path is invalid")
        try:
            path = Path(text).expanduser().resolve(strict=True)
        except OSError as exc:
            raise ValueError("upload file does not exist") from exc
        if os.name == "nt" and str(path).startswith("\\\\"):
            raise ValueError("network upload files are not supported")
        if not path.is_file():
            raise ValueError("upload target must be a regular file")
        if not any(_is_within(path, root) for root in allowed_roots):
            raise ValueError("upload file is outside the configured roots")
        if path.suffix.lower() not in ALLOWED_EXTENSIONS:
            raise ValueError("upload file type is not allowed")
        size = path.stat().st_size
        if size <= 0 or size > MAX_UPLOAD_FILE_BYTES:
            raise ValueError("upload file size is outside the allowed range")
        _validate_image_signature(path)
        if path in resolved:
            raise ValueError("duplicate upload file")
        resolved.append(path)
        total_bytes += size
    return resolved, total_bytes
