r"""Loopback-only bridge server for the Chrome Browser Control skill."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue
from urllib.parse import parse_qs, urlencode, urlparse

from .compatibility import BRIDGE_RUNTIME_CONTRACT
from .runtime_paths import PROTOCOL_PATH, token_path
from .upload_policy import validate_upload_files


HOST = "127.0.0.1"
PORT = 16881
ACTIVE_CLIENT_MAX_AGE = 120
COMMAND_LONG_POLL_SECONDS = 15
BRIDGE_SERVER_VERSION = "0.2.0"
REQUEST_CACHE_TTL_SECONDS = 120
PENDING_REQUEST_MAX_AGE_SECONDS = 24 * 60 * 60
PAIRING_TTL_SECONDS = 120
MAX_REQUEST_BYTES = 20 * 1024 * 1024
TOKEN_PATH = token_path()
GLOBAL_CLIENT_SUFFIX = ":global"
# These commands are executed by the extension service worker.  They are
# browser-level operations; DOM commands must always be delivered to the
# concrete document client that owns the page.
BROWSER_LEVEL_COMMANDS = frozenset({
    "open_url",
    "list_pages",
    "switch_page",
    "close_page",
    "list_windows",
    "switch_window",
    "close_window",
    "navigate",
    "screenshot",
})


def load_or_create_bridge_token(path: Path = TOKEN_PATH) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        value = ""
    if value:
        return value
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(32)
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(value)
    except FileExistsError:
        value = path.read_text(encoding="utf-8").strip()
    if os.name != "nt":
        try:
            path.chmod(0o600)
        except OSError:
            pass
    return value


_TOKEN_LOCK = threading.RLock()


def current_bridge_token() -> str:
    """Read the current token so an explicit rotation takes effect live.

    The server intentionally does not cache this value across requests.  This
    makes the ``setup.py rotate-token`` recovery path safe even when the
    persistent bridge process is already running: the next authenticated
    request uses the replacement token, while the old extension token stops
    working immediately.
    """

    global BRIDGE_TOKEN
    with _TOKEN_LOCK:
        BRIDGE_TOKEN = load_or_create_bridge_token(TOKEN_PATH)
        return BRIDGE_TOKEN


def rotate_bridge_token(path: Path = TOKEN_PATH) -> str:
    """Atomically replace the bridge token and return it to the caller only.

    Callers must not print or persist the returned value outside the runtime
    token file.  Existing extension pairings become invalid and must be
    re-enrolled through the one-time pairing flow.
    """

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(32)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        with _TOKEN_LOCK:
            with temporary.open("x", encoding="utf-8") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
            if os.name != "nt":
                try:
                    temporary.chmod(0o600)
                except OSError:
                    pass
            os.replace(temporary, target)
            if os.name != "nt":
                try:
                    target.chmod(0o600)
                except OSError:
                    pass
            global BRIDGE_TOKEN
            BRIDGE_TOKEN = value if target == TOKEN_PATH else BRIDGE_TOKEN
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
    return value


def load_protocol(path: Path = PROTOCOL_PATH) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    actions = payload.get("actions")
    if not isinstance(actions, dict) or not actions:
        raise RuntimeError(f"Chrome bridge protocol has no actions: {path}")
    return payload


PROTOCOL = load_protocol()
ACTION_PROTOCOL = PROTOCOL["actions"]
MUTATING_ACTIONS = frozenset(PROTOCOL.get("mutating_actions") or [])
BRIDGE_TOKEN = load_or_create_bridge_token()


@dataclass
class BridgeState:
    commands: Queue = field(default_factory=Queue)
    global_commands: Queue = field(default_factory=Queue)
    targeted_commands: dict[str, Queue] = field(default_factory=dict)
    results: dict[str, dict] = field(default_factory=dict)
    command_claims: dict[str, dict] = field(default_factory=dict)
    clients: dict[str, float] = field(default_factory=dict)
    client_meta: dict[str, dict] = field(default_factory=dict)
    request_records: dict[str, dict] = field(default_factory=dict)
    command_request_ids: dict[str, str] = field(default_factory=dict)
    pairing_codes: dict[str, float] = field(default_factory=dict)
    lock: threading.RLock = field(default_factory=threading.RLock)


STATE = BridgeState()


class BridgeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def create_pairing_code(now: float | None = None) -> str:
    """Create a single-use, short-lived code without exposing the bridge token."""

    current = time.time() if now is None else float(now)
    code = secrets.token_urlsafe(24)
    digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
    with STATE.lock:
        STATE.pairing_codes = {
            key: expires_at
            for key, expires_at in STATE.pairing_codes.items()
            if float(expires_at) > current
        }
        STATE.pairing_codes[digest] = current + PAIRING_TTL_SECONDS
    return code


def claim_pairing_code(code: str, now: float | None = None) -> bool:
    current = time.time() if now is None else float(now)
    digest = hashlib.sha256(str(code or "").encode("utf-8")).hexdigest()
    with STATE.lock:
        expires_at = float(STATE.pairing_codes.pop(digest, 0) or 0)
        STATE.pairing_codes = {
            key: expiry
            for key, expiry in STATE.pairing_codes.items()
            if float(expiry) > current
        }
    return bool(expires_at and expires_at > current)


def request_fingerprint(action: str, client_id: str | None, params) -> str:
    encoded = json.dumps(
        {
            "action": str(action or ""),
            "client_id": str(client_id or ""),
            "params": params,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def prune_request_records(now: float | None = None) -> None:
    current = time.time() if now is None else float(now)
    with STATE.lock:
        expired = [
            request_id
            for request_id, record in STATE.request_records.items()
            if (
                record.get("status") == "completed"
                and current - float(
                    record.get("completed_at")
                    or record.get("updated_at")
                    or record.get("created_at")
                    or 0
                ) > REQUEST_CACHE_TTL_SECONDS
            ) or (
                record.get("status") != "completed"
                and current - float(record.get("created_at") or 0)
                > PENDING_REQUEST_MAX_AGE_SECONDS
            )
        ]
        for request_id in expired:
            record = STATE.request_records.pop(request_id, None) or {}
            command_id = str(record.get("command_id") or "")
            if command_id:
                STATE.command_request_ids.pop(command_id, None)
                STATE.results.pop(command_id, None)


def active_clients(max_age: float = ACTIVE_CLIENT_MAX_AGE) -> dict[str, float]:
    now = time.time()
    with STATE.lock:
        return {
            client_id: seen_at
            for client_id, seen_at in STATE.clients.items()
            if now - float(seen_at) <= max_age
        }


def is_global_client(client_id: str | None) -> bool:
    return str(client_id or "").endswith(GLOBAL_CLIENT_SUFFIX)


def queued_command_count() -> int:
    with STATE.lock:
        return STATE.commands.qsize() + STATE.global_commands.qsize()


def new_command(
    action: str,
    params: dict | None = None,
    tab_id: int | None = None,
    client_id: str | None = None,
) -> dict:
    command = {
        "id": "cmd_" + uuid.uuid4().hex[:10],
        "action": action,
        "params": params or {},
    }
    if tab_id is not None:
        command["tabId"] = tab_id
    with STATE.lock:
        if client_id and is_global_client(client_id):
            # A synthetic global client is allowed to receive browser-level work
            # only.  Keep it on its own queue so document pollers cannot steal it.
            if action not in BROWSER_LEVEL_COMMANDS:
                raise ValueError("global client cannot receive DOM commands")
            STATE.global_commands.put(command)
        elif client_id:
            command["client_id"] = client_id
            queue = STATE.targeted_commands.setdefault(client_id, Queue())
            queue.put(command)
        elif action in BROWSER_LEVEL_COMMANDS:
            STATE.global_commands.put(command)
        else:
            raise ValueError("DOM commands require a concrete document client")
    return command


def wait_result(command_id: str, timeout: float = 10, *, pop: bool = True) -> dict | None:
    deadline = time.monotonic() + max(0.0, float(timeout))
    while time.monotonic() < deadline:
        with STATE.lock:
            if command_id in STATE.results:
                return STATE.results.pop(command_id) if pop else STATE.results[command_id]
        time.sleep(0.1)
    return None


def parse_protocol_value(raw: str | None, definition: dict):
    value_type = str(definition.get("type") or "string")
    default = definition.get("default")
    if raw is None or raw == "":
        return default
    if value_type == "int":
        return int(raw)
    if value_type == "bool":
        return str(raw).strip().lower() not in {"0", "false", "no", "off"}
    if value_type in {"json", "object"}:
        value = json.loads(raw)
        if value_type == "object" and not isinstance(value, dict):
            raise ValueError("JSON action parameter must be an object")
        return value
    return str(raw)


def build_protocol_command_from_params(
    action_text: str,
    raw_params: dict | None,
    client_id: str | None = None,
) -> dict:
    definition = ACTION_PROTOCOL.get(action_text)
    if not isinstance(definition, dict):
        raise KeyError(action_text)
    command_name = str(definition.get("command") or "").strip()
    if not command_name:
        raise ValueError(f"Protocol action has no command: {action_text}")
    raw_params = raw_params if isinstance(raw_params, dict) else {}
    params = {}
    for name, param_definition in (definition.get("params") or {}).items():
        raw = raw_params.get(name)
        if raw is None:
            params[name] = param_definition.get("default")
        elif isinstance(raw, str):
            params[name] = parse_protocol_value(raw, param_definition)
        else:
            value_type = str(param_definition.get("type") or "string")
            if value_type == "int":
                params[name] = int(raw)
            elif value_type == "bool":
                params[name] = bool(raw)
            elif value_type == "object":
                if not isinstance(raw, dict):
                    raise ValueError("JSON action parameter must be an object")
                params[name] = raw
            elif value_type == "json":
                params[name] = raw
            else:
                params[name] = str(raw)
    if action_text == "upload_file":
        selector = str(params.get("selector") or "").strip()
        if not selector or len(selector) > 2000:
            raise ValueError("upload selector is required and must be at most 2000 characters")
        resolved, total_bytes = validate_upload_files(params.get("filePaths"))
        params["selector"] = selector
        params["filePaths"] = [str(path) for path in resolved]
        params["multiple"] = len(resolved) > 1
        params["totalBytes"] = total_bytes
    return new_command(command_name, params, client_id=client_id)


def public_client_url(value: str) -> str:
    parsed = urlparse(str(value or ""))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    hostname = parsed.hostname[:253]
    display_host = f"[{hostname}]" if ":" in hostname else hostname
    try:
        parsed_port = parsed.port
    except ValueError:
        parsed_port = None
    port = f":{parsed_port}" if parsed_port else ""
    path = (parsed.path or "/")[:2048]
    query = ""
    if path == "/bridge-bootstrap":
        nonce = str((parse_qs(parsed.query).get("bridge_nonce") or [""])[0])[:128]
        if nonce:
            query = "?" + urlencode({"bridge_nonce": nonce})
    return f"{parsed.scheme}://{display_host}{port}{path}{query}"


def lease_is_current(
    metadata: dict | None,
    *,
    request_client_id: str | None = None,
    action: str = "",
) -> bool:
    if not metadata:
        return True
    if not isinstance(metadata, dict):
        return False
    # A fencing token without a concrete page/document target is unsafe: it
    # could be replayed against whichever tab happens to poll next.
    target_page_id = str(metadata.get("page_id") or "").strip()
    target_client_id = str(metadata.get("client_id") or "").strip()
    try:
        target_tab_id = int(metadata.get("tab_id"))
    except (TypeError, ValueError):
        return False
    if not target_page_id or not target_client_id or target_tab_id < 0:
        return False
    if is_global_client(target_client_id):
        return False
    if request_client_id and is_global_client(request_client_id):
        return False
    if request_client_id and str(request_client_id) != target_client_id:
        return False
    try:
        from .leases import PageLeaseRegistry

        if not PageLeaseRegistry().validate_metadata(
            str(metadata.get("resource") or ""),
            str(metadata.get("owner_id") or ""),
            int(metadata.get("epoch") or 0),
        ):
            return False
        active = active_clients()
        if target_client_id not in active:
            return False
        with STATE.lock:
            client_meta = dict(STATE.client_meta.get(target_client_id) or {})
        if not client_meta:
            return False
        if str(client_meta.get("page_id") or "") != target_page_id:
            return False
        if int(client_meta.get("tab_id") or -1) != target_tab_id:
            return False
        scope = str(client_meta.get("client_scope") or "document").lower()
        if scope in {"browser", "global"}:
            return False
        return True
    except Exception:
        return False


def complete_command(command_id: str, result: dict) -> None:
    with STATE.lock:
        STATE.command_claims.pop(command_id, None)
        STATE.results[command_id] = result
        request_id = STATE.command_request_ids.get(command_id, "")
        record = STATE.request_records.get(request_id)
        if record is not None:
            now = time.time()
            record.update({
                "status": "completed",
                "result": result,
                "updated_at": now,
                "completed_at": now,
            })


class BridgeHandler(BaseHTTPRequestHandler):
    def origin_allowed(self) -> bool:
        origin = str(self.headers.get("Origin") or "").strip().lower()
        if not origin:
            return True
        return origin.startswith("chrome-extension://")

    def authorized(self) -> bool:
        supplied = str(self.headers.get("X-Chrome-Control-Token") or "")
        return bool(supplied) and secrets.compare_digest(supplied, current_bridge_token())

    def require_authorized(self) -> bool:
        if not self.origin_allowed():
            self.write_json(
                {"ok": False, "error_code": "bridge_origin_denied", "error": "origin denied"},
                status=403,
            )
            return False
        if self.authorized():
            return True
        self.write_json(
            {"ok": False, "error_code": "bridge_auth_required", "error": "unauthorized"},
            status=401,
        )
        return False

    def do_OPTIONS(self):
        if not self.origin_allowed():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.write_cors_headers()
        self.end_headers()

    def read_json(self) -> dict | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            content_length = -1
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            self.write_json({"ok": False, "error": "request too large"}, status=413)
            return None
        raw = self.rfile.read(content_length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.write_json({"ok": False, "error": "invalid json"}, status=400)
            return None
        if not isinstance(payload, dict):
            self.write_json({"ok": False, "error": "invalid json"}, status=400)
            return None
        return payload

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/bridge-bootstrap":
            self.write_bootstrap_page()
            return
        if not self.require_authorized():
            return
        if parsed.path == "/api/status":
            active = active_clients()
            with STATE.lock:
                clients = dict(STATE.clients)
                client_meta = {
                    client_id: dict(metadata)
                    for client_id, metadata in STATE.client_meta.items()
                    if isinstance(metadata, dict)
                }
                queued = queued_command_count()
            self.write_json({
                "ok": True,
                "bridge_api_version": 3,
                "bridge_server_version": BRIDGE_SERVER_VERSION,
                "runtime_contract": BRIDGE_RUNTIME_CONTRACT,
                "protocol_version": int(PROTOCOL.get("version") or 0),
                "capabilities": sorted(ACTION_PROTOCOL),
                "mutating_actions": sorted(MUTATING_ACTIONS),
                "auth_required": True,
                "queued": queued,
                "clients": clients,
                "active_clients": active,
                "client_meta": client_meta,
                "active_client_max_age": ACTIVE_CLIENT_MAX_AGE,
            })
            return
        self.write_json({"ok": False, "error": "not found"}, status=404)

    def handle_run_request(
        self,
        action_text,
        client_id,
        timeout,
        command_builder,
        *,
        request_id="",
        fingerprint_params=None,
        lease=None,
    ):
        request_id = str(request_id or "").strip()
        fingerprint = request_fingerprint(action_text, client_id, fingerprint_params)
        if request_id:
            with STATE.lock:
                prune_request_records()
                existing = STATE.request_records.get(request_id)
                if existing and existing.get("fingerprint") != fingerprint:
                    self.write_json({
                        "ok": False,
                        "outcome": "failed",
                        "error_code": "request_id_conflict",
                        "error": "request_id was reused with a different payload",
                        "request_id": request_id,
                    }, status=409)
                    return
                if existing and existing.get("status") == "completed":
                    cached_result = existing.get("result") or {}
                    self.write_json({
                        "ok": True,
                        "outcome": "ok" if cached_result.get("ok") else "failed",
                        "request_id": request_id,
                        "cached": True,
                        "deduped": True,
                        "result": cached_result,
                    })
                    return
        active = active_clients()
        if client_id and client_id not in active:
            self.write_json({
                "ok": False,
                "error_code": "bridge_client_stale",
                "error": "target client is not active; refresh the target page",
                "target_client_id": client_id,
                "active_clients": active,
            }, status=503)
            return
        if not client_id and not active:
            with STATE.lock:
                clients = dict(STATE.clients)
            self.write_json({
                "ok": False,
                "error_code": "no_responsive_client",
                "error": "no active extension client; refresh the target page",
                "clients": clients,
                "active_clients": active,
            }, status=503)
            return
        definition = ACTION_PROTOCOL.get(action_text)
        command_name = str((definition or {}).get("command") or "")
        if not client_id and command_name not in BROWSER_LEVEL_COMMANDS:
            self.write_json({
                "ok": False,
                "outcome": "failed",
                "error_code": "target_client_required",
                "error": "DOM commands require a concrete document client",
                "request_id": request_id,
            }, status=400)
            return
        if client_id and is_global_client(client_id) and command_name not in BROWSER_LEVEL_COMMANDS:
            self.write_json({
                "ok": False,
                "outcome": "failed",
                "error_code": "global_client_dom_forbidden",
                "error": "the global client may receive browser-level commands only",
                "request_id": request_id,
            }, status=400)
            return
        mutating = action_text in MUTATING_ACTIONS
        if lease and not lease_is_current(
            lease,
            request_client_id=client_id,
            action=command_name,
        ):
            self.write_json({
                "ok": False,
                "outcome": "failed",
                "error_code": "stale_page_lease",
                "error": "page lease fencing token is no longer current",
                "request_id": request_id,
            }, status=409)
            return
        command = None
        if request_id:
            with STATE.lock:
                prune_request_records()
                existing = STATE.request_records.get(request_id)
                if existing and existing.get("fingerprint") != fingerprint:
                    self.write_json({
                        "ok": False,
                        "outcome": "failed",
                        "error_code": "request_id_conflict",
                        "error": "request_id was reused with a different payload",
                        "request_id": request_id,
                    }, status=409)
                    return
                if existing and existing.get("status") == "completed":
                    cached_result = existing.get("result") or {}
                    self.write_json({
                        "ok": True,
                        "outcome": "ok" if cached_result.get("ok") else "failed",
                        "request_id": request_id,
                        "cached": True,
                        "deduped": True,
                        "result": cached_result,
                    })
                    return
                if existing:
                    command = {"id": str(existing.get("command_id") or "")}
                else:
                    try:
                        command = command_builder()
                        if lease:
                            command["lease"] = dict(lease)
                    except KeyError:
                        self.write_json({"ok": False, "outcome": "failed", "error": "unsupported action"}, status=400)
                        return
                    except (TypeError, ValueError, json.JSONDecodeError) as exc:
                        self.write_json(
                            {"ok": False, "outcome": "failed", "error": f"invalid action parameters: {exc}"},
                            status=400,
                        )
                        return
                    now = time.time()
                    STATE.request_records[request_id] = {
                        "fingerprint": fingerprint,
                        "command_id": command["id"],
                        "status": "pending",
                        "mutating": mutating,
                        "created_at": now,
                        "updated_at": now,
                    }
                    STATE.command_request_ids[command["id"]] = request_id

        if command is None:
            try:
                command = command_builder()
                if lease:
                    command["lease"] = dict(lease)
            except KeyError:
                self.write_json({"ok": False, "outcome": "failed", "error": "unsupported action"}, status=400)
                return
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                self.write_json(
                    {"ok": False, "outcome": "failed", "error": f"invalid action parameters: {exc}"},
                    status=400,
                )
                return

        result = wait_result(command["id"], timeout=timeout, pop=not bool(request_id))
        if result is None:
            with STATE.lock:
                claim = dict(STATE.command_claims.get(command["id"]) or {})
            claimed_client_id = str((claim or {}).get("client_id") or "")
            if claimed_client_id and not request_id:
                with STATE.lock:
                    STATE.clients.pop(claimed_client_id, None)
            if request_id and mutating:
                with STATE.lock:
                    record = STATE.request_records.get(request_id)
                    if record:
                        record["updated_at"] = time.time()
                self.write_json({
                    "ok": False,
                    "outcome": "unknown_outcome",
                    "error_code": "unknown_outcome",
                    "error": "command result was not received; do not automatically retry high-risk actions",
                    "request_id": request_id,
                    "cached": False,
                    "deduped": False,
                    "command_id": command["id"],
                    "delivery_state": "claimed" if claim else "queued",
                    "target_client_id": client_id or claimed_client_id,
                }, status=504)
                return
            with STATE.lock:
                clients = dict(STATE.clients)
            self.write_json({
                "ok": False,
                "outcome": "failed",
                "error_code": "bridge_client_stale",
                "error": "no result received",
                "command_id": command["id"],
                "delivery_state": "claimed" if claim else "queued",
                "queued": queued_command_count(),
                "target_client_id": client_id or claimed_client_id,
                "clients": clients,
            }, status=504)
            return
        if request_id:
            with STATE.lock:
                record = STATE.request_records.get(request_id)
                if record:
                    record.update({
                        "status": "completed",
                        "result": result,
                        "updated_at": time.time(),
                        "completed_at": time.time(),
                    })
        self.write_json({
            "ok": True,
            "outcome": "ok" if result.get("ok") else "failed",
            "request_id": request_id,
            "cached": False,
            "deduped": False,
            "result": result,
        })

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/pairing/claim":
            if not self.origin_allowed():
                self.write_json(
                    {"ok": False, "error_code": "bridge_origin_denied", "error": "origin denied"},
                    status=403,
                )
                return
            payload = self.read_json()
            if payload is None:
                return
            if not claim_pairing_code(str(payload.get("code") or "")):
                self.write_json(
                    {"ok": False, "error_code": "pairing_code_invalid", "error": "pairing code is invalid or expired"},
                    status=403,
                )
                return
            self.write_json({"ok": True, "bridge_token": current_bridge_token()})
            return
        if not self.require_authorized():
            return
        if parsed.path == "/api/pairing/start":
            self.write_json({
                "ok": True,
                "pairing_code": create_pairing_code(),
                "expires_in_seconds": PAIRING_TTL_SECONDS,
            })
            return
        if parsed.path == "/api/poll":
            payload = self.read_json()
            if payload is None:
                return
            self.handle_commands_payload(payload)
            return
        if parsed.path == "/api/lease/validate":
            payload = self.read_json()
            if payload is None:
                return
            metadata = {
                "resource": str(payload.get("resource") or ""),
                "owner_id": str(payload.get("owner_id") or ""),
                "epoch": int(payload.get("epoch") or 0),
                "page_id": str(payload.get("page_id") or ""),
                "client_id": str(payload.get("client_id") or ""),
                "tab_id": payload.get("tab_id"),
            }
            self.write_json({"ok": True, "current": lease_is_current(metadata)})
            return
        if parsed.path == "/api/run":
            payload = self.read_json()
            if payload is None:
                return
            action_text = str(payload.get("action") or "").lower()
            client_id = str(payload.get("client_id") or "").strip() or None
            request_id = str(payload.get("request_id") or "").strip()
            try:
                timeout = float(payload.get("timeout") or 10)
            except (TypeError, ValueError):
                timeout = float("nan")
            if not math.isfinite(timeout) or not 0.1 <= timeout <= 300:
                self.write_json({
                    "ok": False,
                    "outcome": "failed",
                    "error_code": "invalid_timeout",
                    "error": "timeout must be a finite number between 0.1 and 300 seconds",
                }, status=400)
                return
            params = payload.get("params")
            lease = payload.get("lease") if isinstance(payload.get("lease"), dict) else None
            self.handle_run_request(
                action_text,
                client_id,
                timeout,
                lambda: build_protocol_command_from_params(
                    action_text, params, client_id=client_id
                ),
                request_id=request_id,
                fingerprint_params={"params": params, "lease": lease},
                lease=lease,
            )
            return
        if parsed.path == "/api/results":
            payload = self.read_json()
            if payload is None:
                return
            command_id = str(payload.get("command_id") or "")
            if command_id:
                with STATE.lock:
                    claim = dict(STATE.command_claims.get(command_id) or {})
                claimed_client_id = str((claim or {}).get("client_id") or "")
                result_client_id = str(payload.get("client_id") or "")
                if claimed_client_id and result_client_id != claimed_client_id:
                    self.write_json({
                        "ok": False,
                        "error_code": "result_client_mismatch",
                        "error": "command result came from a different browser client",
                    }, status=409)
                    return
                complete_command(command_id, payload)
            self.write_json({"ok": True})
            return
        self.write_json({"ok": False, "error": "not found"}, status=404)

    def handle_commands_payload(self, payload: dict):
        client_id = str(payload.get("client_id") or "unknown")[:200]
        seen_at = time.time()
        try:
            tab_id = int(payload.get("tab_id") or -1)
        except (TypeError, ValueError):
            tab_id = -1
        try:
            protocol_version = int(payload.get("protocol_version") or 0)
        except (TypeError, ValueError):
            protocol_version = 0
        page_id = str(payload.get("page_id") or "")[:300]
        client_scope = str(
            payload.get("client_scope") or payload.get("scope") or "document"
        ).strip().lower()
        if client_scope not in {"document", "browser"}:
            client_scope = "document"
        client_metadata = {
            "tab_id": tab_id,
            "page_id": page_id,
            "browser_session_id": str(payload.get("browser_session_id") or "")[:200],
            "window_id": int(payload.get("window_id") or -1),
            "client_scope": client_scope,
            "url": public_client_url(str(payload.get("url") or "")),
            "title": str(payload.get("title") or "")[:300],
            "ready_state": str(payload.get("ready_state") or ""),
            "document_id": str(payload.get("document_id") or "")[:200],
            "document_lifecycle": str(payload.get("document_lifecycle") or "").lower(),
            "extension_version": str(payload.get("extension_version") or "")[:40],
            "protocol_version": protocol_version,
            "seen_at": seen_at,
        }
        with STATE.lock:
            STATE.clients[client_id] = seen_at
            STATE.client_meta[client_id] = client_metadata
        commands = []
        deadline = time.monotonic() + COMMAND_LONG_POLL_SECONDS
        while time.monotonic() < deadline:
            with STATE.lock:
                targeted = STATE.targeted_commands.get(client_id)
                global_queue = STATE.global_commands if client_scope == "browser" else None
                has_targeted = targeted is not None and not targeted.empty()
                has_global = global_queue is not None and not global_queue.empty()
            if has_targeted or has_global:
                break
            time.sleep(0.1)
        while len(commands) < 8:
            with STATE.lock:
                targeted = STATE.targeted_commands.get(client_id)
                if targeted is None or targeted.empty():
                    command = None
                else:
                    command = targeted.get()
            if command is None:
                break
            if not lease_is_current(
                command.get("lease"),
                request_client_id=client_id,
                action=str(command.get("action") or ""),
            ):
                complete_command(command["id"], {
                    "command_id": command["id"],
                    "client_id": client_id,
                    "ok": False,
                    "data": None,
                    "error": "stale_page_lease: fencing token is no longer current",
                    "source": "bridge_server",
                })
                continue
            commands.append(command)
            with STATE.lock:
                STATE.command_claims[command["id"]] = {
                    "client_id": client_id,
                    "claimed_at": time.time(),
                }
        while len(commands) < 8:
            with STATE.lock:
                global_queue = STATE.global_commands if client_scope == "browser" else None
                if global_queue is None or global_queue.empty():
                    command = None
                else:
                    command = global_queue.get()
            if command is None:
                break
            if not lease_is_current(command.get("lease"), action=str(command.get("action") or "")):
                complete_command(command["id"], {
                    "command_id": command["id"],
                    "client_id": client_id,
                    "ok": False,
                    "data": None,
                    "error": "stale_page_lease: fencing token is no longer current",
                    "source": "bridge_server",
                })
                continue
            commands.append(command)
            with STATE.lock:
                STATE.command_claims[command["id"]] = {
                    "client_id": client_id,
                    "claimed_at": time.time(),
                }
        self.write_json({"ok": True, "commands": commands})

    def write_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.write_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def write_bootstrap_page(self):
        body = b"""<!doctype html>
<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Chrome Browser Control pairing</title></head>
<body><p>Chrome Browser Control is pairing this browser. You can close this tab after it reports success.</p></body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def write_cors_headers(self):
        origin = str(self.headers.get("Origin") or "")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Chrome-Control-Token")

    def log_message(self, _format, *_args):
        return


def start_server(port: int | None = None) -> BridgeHTTPServer:
    resolved_port = PORT if port is None else int(port)
    server = BridgeHTTPServer((HOST, resolved_port), BridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def demo_loop():
    print(f"Chrome Browser Control server: http://{HOST}:{PORT}")
    print("Commands: state | scan | status | quit")
    while True:
        text = input("> ").strip().lower()
        if text in {"quit", "exit"}:
            return
        if text == "state":
            command = new_command("get_state")
        elif text == "scan":
            command = new_command("scan_elements", {"maxTop": 260, "limit": 30})
        elif text == "status":
            with STATE.lock:
                clients = dict(STATE.clients)
            print(json.dumps({
                "queued": queued_command_count(),
                "clients": clients,
            }, ensure_ascii=False, indent=2))
            continue
        else:
            print("unknown command")
            continue
        result = wait_result(command["id"], timeout=10)
        if result is None:
            print("No result received. 请确认：插件已启用、目标页面已刷新、当前打开的是普通网页。")
            continue
        print(json.dumps(result, ensure_ascii=False, indent=2))


def serve_forever(port: int | None = None):
    server = start_server(port)
    resolved_port = PORT if port is None else int(port)
    print(f"Chrome Browser Control server: http://{HOST}:{resolved_port}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--serve", action="store_true", help="Run without interactive stdin.")
    parser.add_argument("--port", type=int, default=PORT, help="Local bridge HTTP port.")
    args = parser.parse_args()
    if args.serve:
        serve_forever(args.port)
    else:
        start_server(args.port)
        demo_loop()
