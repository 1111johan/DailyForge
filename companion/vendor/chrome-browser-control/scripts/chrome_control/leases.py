"""Cross-process page leases shared by CLI and future MCP adapters."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .process_lock import process_lock
from .runtime_paths import lease_path


def default_lease_path() -> Path:
    return lease_path()


class PageLeaseConflict(RuntimeError):
    def __init__(self, resource: str, holders: list[str]) -> None:
        self.resource = str(resource)
        self.holders = list(holders)
        super().__init__(f"page lease is held by another automation client: {resource}")


def new_lease_owner() -> str:
    return "lease_" + uuid.uuid4().hex


def _empty_payload() -> dict[str, Any]:
    return {"version": 2, "next_epoch": 1, "leases": {}, "takeovers": []}


def _load(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_payload()
    if not isinstance(payload, dict):
        return _empty_payload()
    payload.setdefault("version", 2)
    payload.setdefault("next_epoch", 1)
    payload.setdefault("leases", {})
    payload.setdefault("takeovers", [])
    return payload


def _save(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        except OSError:
            pass


def _active_holders(row: dict[str, Any], owner_id: str) -> list[str]:
    holders = []
    writer = row.get("writer") or {}
    if writer and writer.get("owner_id") != owner_id:
        holders.append(str(writer.get("owner_id") or "unknown"))
    for reader_id in (row.get("readers") or {}):
        if reader_id != owner_id:
            holders.append(str(reader_id))
    return sorted(set(holders))


def _process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes

            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
            return False
        except (AttributeError, OSError):
            return False
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def _record_expired(record: dict[str, Any], now: float) -> bool:
    if float(record.get("expires_at") or 0) > now:
        return False
    pid = int(record.get("pid") or 0)
    return not (pid and _process_alive(pid))


def _prune(payload: dict[str, Any], now: float) -> None:
    leases = payload.get("leases") or {}
    for resource in list(leases):
        row = leases.get(resource) or {}
        writer = row.get("writer") or {}
        if writer and _record_expired(writer, now):
            row["writer"] = None
        readers = row.get("readers") or {}
        row["readers"] = {
            owner: record
            for owner, record in readers.items()
            if not _record_expired(record or {}, now)
        }
        if not row.get("writer") and not row["readers"]:
            leases.pop(resource, None)


@dataclass(frozen=True)
class PageLease:
    resource: str
    owner_id: str
    mode: str
    ttl_seconds: float
    acquired_at: float
    expires_at: float
    epoch: int
    pid: int


class PageLeaseRegistry:
    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or default_lease_path())

    def acquire(
        self,
        resource: str,
        owner_id: str,
        *,
        mode: str,
        ttl_seconds: float = 30,
        takeover: bool = False,
    ) -> PageLease:
        resource = str(resource or "").strip()
        owner_id = str(owner_id or "").strip()
        mode = str(mode or "").strip().lower()
        if not resource or not owner_id:
            raise ValueError("resource and owner_id are required")
        if mode not in {"read", "write"}:
            raise ValueError("page lease mode must be read or write")
        ttl = max(2.0, float(ttl_seconds))
        with process_lock("browser_control_page_leases", timeout=5):
            payload = _load(self.path)
            now = time.time()
            _prune(payload, now)
            leases = payload["leases"]
            row = leases.setdefault(resource, {"writer": None, "readers": {}})
            holders = _active_holders(row, owner_id)
            conflict = bool(holders) if mode == "write" else bool(
                row.get("writer") and (row.get("writer") or {}).get("owner_id") != owner_id
            )
            if conflict and not takeover:
                raise PageLeaseConflict(resource, holders)
            if conflict and takeover:
                payload["takeovers"].append({
                    "resource": resource,
                    "new_owner_id": owner_id,
                    "previous_holders": holders,
                    "at": now,
                })
                row = {"writer": None, "readers": {}}
                leases[resource] = row
            epoch = int(payload.get("next_epoch") or 1)
            payload["next_epoch"] = epoch + 1
            record = {
                "owner_id": owner_id,
                "epoch": epoch,
                "pid": os.getpid(),
                "acquired_at": now,
                "heartbeat_at": now,
                "expires_at": now + ttl,
            }
            if mode == "write":
                row["readers"].pop(owner_id, None)
                row["writer"] = record
            else:
                row["readers"][owner_id] = record
            _save(self.path, payload)
        return PageLease(resource, owner_id, mode, ttl, now, now + ttl, epoch, os.getpid())

    def heartbeat(self, lease: PageLease) -> PageLease:
        with process_lock("browser_control_page_leases", timeout=5):
            payload = _load(self.path)
            now = time.time()
            _prune(payload, now)
            row = (payload.get("leases") or {}).get(lease.resource) or {}
            record = (
                row.get("writer")
                if lease.mode == "write"
                else (row.get("readers") or {}).get(lease.owner_id)
            ) or {}
            if record.get("owner_id") != lease.owner_id:
                raise PageLeaseConflict(lease.resource, _active_holders(row, lease.owner_id))
            record["heartbeat_at"] = now
            record["expires_at"] = now + lease.ttl_seconds
            _save(self.path, payload)
        return PageLease(
            lease.resource,
            lease.owner_id,
            lease.mode,
            lease.ttl_seconds,
            lease.acquired_at,
            now + lease.ttl_seconds,
            lease.epoch,
            lease.pid,
        )

    def validate(self, lease: PageLease) -> dict[str, Any]:
        with process_lock("browser_control_page_leases", timeout=5):
            payload = _load(self.path)
            _prune(payload, time.time())
            row = (payload.get("leases") or {}).get(lease.resource) or {}
            record = (
                row.get("writer")
                if lease.mode == "write"
                else (row.get("readers") or {}).get(lease.owner_id)
            ) or {}
            if (
                record.get("owner_id") != lease.owner_id
                or int(record.get("epoch") or 0) != lease.epoch
            ):
                raise PageLeaseConflict(
                    lease.resource,
                    _active_holders(row, lease.owner_id),
                )
            return dict(record)

    def validate_metadata(self, resource: str, owner_id: str, epoch: int) -> bool:
        with process_lock("browser_control_page_leases", timeout=5):
            payload = _load(self.path)
            _prune(payload, time.time())
            row = (payload.get("leases") or {}).get(str(resource or "")) or {}
            candidates = [row.get("writer") or {}]
            candidates.extend((row.get("readers") or {}).values())
            return any(
                record.get("owner_id") == owner_id
                and int(record.get("epoch") or 0) == int(epoch or 0)
                for record in candidates
            )

    def release(self, lease: PageLease) -> None:
        with process_lock("browser_control_page_leases", timeout=5):
            payload = _load(self.path)
            _prune(payload, time.time())
            leases = payload.get("leases") or {}
            row = leases.get(lease.resource) or {}
            if lease.mode == "write":
                writer = row.get("writer") or {}
                if writer.get("owner_id") == lease.owner_id:
                    row["writer"] = None
            else:
                (row.get("readers") or {}).pop(lease.owner_id, None)
            if not row.get("writer") and not (row.get("readers") or {}):
                leases.pop(lease.resource, None)
            _save(self.path, payload)

    def inspect(self, *, persist_prune: bool = False) -> dict[str, Any]:
        with process_lock("browser_control_page_leases", timeout=5):
            payload = _load(self.path)
            _prune(payload, time.time())
            if persist_prune:
                _save(self.path, payload)
        return payload


class PageLeaseGuard:
    def __init__(
        self,
        registry: PageLeaseRegistry,
        resource: str,
        owner_id: str,
        *,
        mode: str,
        ttl_seconds: float,
        takeover: bool,
    ) -> None:
        self.registry = registry
        self.resource = resource
        self.owner_id = owner_id
        self.mode = mode
        self.ttl_seconds = max(2.0, float(ttl_seconds))
        self.takeover = bool(takeover)
        self.lease: PageLease | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.heartbeat_error: Exception | None = None
        self.on_acquired = None
        self.on_released = None

    def assert_current(self) -> PageLease:
        if self.heartbeat_error is not None:
            raise self.heartbeat_error
        if self.lease is None:
            raise RuntimeError("page lease has not been acquired")
        self.registry.validate(self.lease)
        return self.lease

    def fencing_metadata(self) -> dict[str, Any]:
        lease = self.assert_current()
        return {
            "resource": lease.resource,
            "owner_id": lease.owner_id,
            "epoch": lease.epoch,
        }

    def __enter__(self) -> PageLease:
        self.lease = self.registry.acquire(
            self.resource,
            self.owner_id,
            mode=self.mode,
            ttl_seconds=self.ttl_seconds,
            takeover=self.takeover,
        )
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()
        if callable(self.on_acquired):
            self.on_acquired(self)
        return self.lease

    def _heartbeat_loop(self) -> None:
        interval = min(1.0, max(0.25, self.ttl_seconds / 3))
        while not self._stop.wait(interval):
            try:
                if self.lease is not None:
                    self.lease = self.registry.heartbeat(self.lease)
            except Exception as exc:
                self.heartbeat_error = exc
                return

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
        if self.lease is not None:
            self.registry.release(self.lease)
        if callable(self.on_released):
            self.on_released(self)
