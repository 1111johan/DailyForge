"""Read-only diagnostics for the local Chrome browser-control bridge."""

from __future__ import annotations

import json
import socket
from typing import Any

from .client import DEFAULT_BRIDGE_PORT, ChromeBridgeClient, ensure_bridge_server
from .compatibility import evaluate_compatibility
from .runtime_paths import EXTENSION_DIR, data_dir, token_path


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.4):
            return True
    except OSError:
        return False


def _active_document_clients(status: dict) -> dict[str, float]:
    active = status.get("active_clients") or {}
    client_meta = status.get("client_meta") or {}
    return {
        str(active_client_id): seen_at
        for active_client_id, seen_at in active.items()
        if not str(active_client_id).endswith(":global")
        and str(
            (client_meta.get(active_client_id) or {}).get("client_scope")
            or "document"
        ).lower()
        not in {"browser", "global"}
    }


def run_browser_doctor(
    config: Any | None = None,
    *,
    provider: str = "",
    port: int = DEFAULT_BRIDGE_PORT,
    client_id: str = "",
    page_id: str = "",
    recover: bool = False,
    start_server: bool = True,
) -> dict[str, Any]:
    """Return actionable local diagnostics without exposing credentials.

    ``config`` and ``provider`` are accepted for compatibility with older
    host integrations but intentionally ignored: this skill only controls
    ordinary Chrome through its local extension bridge.
    """

    del config, provider, page_id
    resolved_port = int(port or DEFAULT_BRIDGE_PORT)
    report: dict[str, Any] = {
        "status": "blocked",
        "provider": "chrome_extension_bridge",
        "port": resolved_port,
        "server_reachable": False,
        "extension_path": str(EXTENSION_DIR),
        "extension_present": EXTENSION_DIR.is_dir(),
        "token_present": token_path().is_file(),
        "runtime_dir": str(data_dir()),
        "actions": [],
    }

    client = ChromeBridgeClient(resolved_port, timeout=3, client_id=client_id)
    if start_server:
        try:
            ok, details = ensure_bridge_server(
                resolved_port,
                timeout=4,
                persistent=True,
            )
            report["server_start"] = {
                "ok": bool(ok),
                "details": list(details),
            }
        except Exception as exc:
            report["server_start"] = {
                "ok": False,
                "error": type(exc).__name__,
            }
    report["token_present"] = token_path().is_file()
    report["server_reachable"] = _port_open(resolved_port)

    try:
        status = client.status()
    except Exception as exc:
        report["error_code"] = str(getattr(exc, "code", "bridge_unavailable"))
        report["error"] = type(exc).__name__
        report["actions"] = [
            "Run `python scripts/setup.py prepare` to start the local service.",
            "Load the unpacked extension directory shown by `extension-path`.",
        ]
        return report

    report["server_reachable"] = True
    document_active = _active_document_clients(status)
    report["bridge"] = {
        "server_version": str(status.get("bridge_server_version") or "unknown"),
        "protocol_version": int(status.get("protocol_version") or 0),
        "auth_required": bool(status.get("auth_required", True)),
        "active_clients": len(status.get("active_clients") or {}),
        "active_document_clients": len(document_active),
        "capabilities": list(status.get("capabilities") or []),
    }
    compatibility = evaluate_compatibility(status, client_id=client_id)
    report["compatibility"] = compatibility
    if client_id and client_id not in document_active:
        report["client_id"] = client_id
        report["client_active"] = False
    elif client_id:
        report["client_id"] = client_id
        report["client_active"] = True

    if recover:
        try:
            state = client.select_responsive_client(client_id)
            report["responsive_client"] = {
                "client_id": str(state.get("client_id") or ""),
                "tab_id": state.get("tab_id"),
                "window_id": state.get("window_id"),
                "url": client._normalized_url(str(state.get("url") or "")),
                "title": str(state.get("title") or "")[:200],
            }
        except Exception as exc:
            report["responsive_client_error"] = str(
                getattr(exc, "code", type(exc).__name__)
            )

    if not report["extension_present"]:
        report["actions"].append("Restore the packaged extension directory.")
    if not report["token_present"]:
        report["actions"].append("Run `prepare` once to initialize local authentication.")
    if not document_active:
        report["actions"].append(
            "Load the unpacked extension, open an http(s) page, and refresh it."
        )
    if compatibility.get("state") == "blocked":
        report["actions"].append("Update the bridge service and extension together.")
        if any(
            reason in {
                "bridge_server_version_incompatible",
                "bridge_runtime_contract_incompatible",
            }
            for reason in compatibility.get("reasons") or []
        ):
            report["actions"].append(
                "Stop the older local bridge process (or restart the OS session), then run prepare again."
            )

    if (
        compatibility.get("state") == "blocked"
        or not report["server_reachable"]
        or not document_active
    ):
        report["status"] = "blocked"
    elif compatibility.get("state") == "degraded":
        report["status"] = "degraded"
    else:
        report["status"] = "compatible"
    return report


def format_report(report: dict[str, Any]) -> str:
    """Stable human-readable JSON for shell callers."""

    return json.dumps(report, ensure_ascii=False, indent=2, default=str)
