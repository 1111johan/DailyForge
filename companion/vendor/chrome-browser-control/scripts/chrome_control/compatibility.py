"""Version and capability handshake for browser-control clients."""

from __future__ import annotations

from typing import Any


STANDALONE_BROWSER_CONTROL_VERSION = "0.2.0"
SKILL_CONTRACT_VERSION = "0.2.0"
BRIDGE_RUNTIME_CONTRACT = "chrome-browser-control-upload-v0.2"
MIN_PROTOCOL_VERSION = 4
MAX_PROTOCOL_VERSION = 4


def evaluate_compatibility(
    status: dict[str, Any],
    *,
    client_id: str = "",
    skill_version: str = SKILL_CONTRACT_VERSION,
) -> dict[str, Any]:
    """Return compatible/degraded/blocked for the bundled secure protocol."""

    server_protocol = int(status.get("protocol_version") or 0)
    metadata = status.get("client_meta") or {}
    selected_meta = metadata.get(client_id) if isinstance(metadata, dict) else None
    selected_meta = selected_meta if isinstance(selected_meta, dict) else {}
    client_protocol = int(selected_meta.get("protocol_version") or 0)
    extension_version = str(selected_meta.get("extension_version") or "")
    reasons: list[str] = []
    state = "compatible"
    server_version = str(status.get("bridge_server_version") or "")
    runtime_contract = str(status.get("runtime_contract") or "")

    if server_version != STANDALONE_BROWSER_CONTROL_VERSION:
        state = "blocked"
        reasons.append("bridge_server_version_incompatible")
    elif runtime_contract != BRIDGE_RUNTIME_CONTRACT:
        state = "blocked"
        reasons.append("bridge_runtime_contract_incompatible")
    elif not (MIN_PROTOCOL_VERSION <= server_protocol <= MAX_PROTOCOL_VERSION):
        state = "blocked"
        reasons.append("bridge_server_protocol_incompatible")
    elif client_protocol and not (MIN_PROTOCOL_VERSION <= client_protocol <= MAX_PROTOCOL_VERSION):
        state = "blocked"
        reasons.append("extension_protocol_incompatible")
    elif extension_version and extension_version != str(skill_version or ""):
        state = "blocked"
        reasons.append("extension_version_incompatible")
    else:
        if server_protocol < MAX_PROTOCOL_VERSION or (
            client_protocol and client_protocol < MAX_PROTOCOL_VERSION
        ):
            state = "degraded"
            reasons.append("legacy_protocol_without_idempotency_guarantee")
        if not client_protocol:
            state = "degraded"
            reasons.append("extension_protocol_unknown")
        if not extension_version:
            state = "degraded"
            reasons.append("extension_version_unknown")

    return {
        "state": state,
        "reasons": reasons,
        "versions": {
            "standalone": STANDALONE_BROWSER_CONTROL_VERSION,
            "skill": str(skill_version or ""),
            "bridge_server": str(status.get("bridge_server_version") or "unknown"),
            "runtime_contract": runtime_contract or "unknown",
            "protocol": server_protocol,
            "extension": extension_version or "unknown",
            "extension_protocol": client_protocol or None,
        },
        "capabilities": list(status.get("capabilities") or []),
        "automatic_retry_allowed": bool(
            state == "compatible"
            and server_protocol == MAX_PROTOCOL_VERSION
            and client_protocol == MAX_PROTOCOL_VERSION
        ),
        "downgrade": (
            "limited_metadata"
            if state == "degraded"
            else ("none" if state == "compatible" else "cli_without_bridge_actions")
        ),
    }
