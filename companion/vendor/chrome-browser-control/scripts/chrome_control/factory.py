"""Construct the standalone Chrome bridge controller.

This module deliberately has no knowledge of the host application.  The
skill is a small, standard-library Python client for the local Chrome
extension bridge.
"""

from __future__ import annotations

from .client import DEFAULT_BRIDGE_PORT, ChromeBridgeClient, ensure_bridge_server
from .controller import BridgeController


def create_controller(
    *,
    port: int = DEFAULT_BRIDGE_PORT,
    client_id: str = "",
    stop_event=None,
    evidence: bool = False,
    persistent_bridge_server: bool = True,
    fallback_to_latest: bool = False,
) -> BridgeController:
    """Return a disconnected controller configured for ordinary Chrome."""

    return BridgeController(
        port=int(port),
        client_id=str(client_id or ""),
        stop_event=stop_event,
        evidence=bool(evidence),
        client_factory=ChromeBridgeClient,
        ensure_bridge=lambda target_port: ensure_bridge_server(
            int(target_port),
            persistent=bool(persistent_bridge_server),
        ),
        persistent_bridge_server=bool(persistent_bridge_server),
        fallback_to_latest=bool(fallback_to_latest),
    )


def connect_controller(
    *,
    port: int = DEFAULT_BRIDGE_PORT,
    client_id: str = "",
    stop_event=None,
    evidence: bool = False,
    persistent_bridge_server: bool = True,
    fallback_to_latest: bool = False,
) -> BridgeController:
    """Create and connect a bridge controller."""

    controller = create_controller(
        port=port,
        client_id=client_id,
        stop_event=stop_event,
        evidence=evidence,
        persistent_bridge_server=persistent_bridge_server,
        fallback_to_latest=fallback_to_latest,
    )
    try:
        controller.connect()
    except Exception:
        controller.disconnect()
        raise
    return controller
