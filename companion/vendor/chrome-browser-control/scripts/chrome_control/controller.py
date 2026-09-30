"""Chrome extension bridge implementation of BrowserController."""

from __future__ import annotations

import base64
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .base import (
    ArtifactExists,
    BrowserController,
    BrowserControlError,
    CapabilityNotSupported,
    ConnectFailed,
    SnapshotResult,
    StaleElementRef,
    WaitTimeout,
)


def _normalized_page_url(value: str) -> str:
    parsed = urlsplit(str(value or ""))
    if not parsed.scheme or not parsed.netloc:
        return ""
    return urlunsplit(
        (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or "/", "", "")
    )


def _latest_bridge_client_id_from_status(status: dict) -> str:
    active = status.get("active_clients") or {}
    metadata = status.get("client_meta") or {}
    if not isinstance(active, dict) or not active:
        raise ConnectFailed(
            "chrome bridge has no active extension client; refresh target page",
            code="no_responsive_client",
        )
    if isinstance(metadata, dict):
        candidates = [
            (client_id, meta)
            for client_id, meta in metadata.items()
            if client_id in active and isinstance(meta, dict)
        ]
        if candidates:
            candidates.sort(key=lambda item: float(active.get(item[0]) or 0), reverse=True)
            return str(candidates[0][0])
    return str(max(active.items(), key=lambda item: float(item[1] or 0))[0])


def _latest_bridge_client_id(client) -> str:
    return _latest_bridge_client_id_from_status(client.status())


class BridgeController(BrowserController):
    def __init__(
        self,
        *,
        port: int = 16881,
        client_id: str = "",
        stop_event=None,
        evidence: bool = False,
        client_factory=None,
        ensure_bridge=None,
        persistent_bridge_server: bool = False,
        fallback_to_latest: bool = False,
        browser_session_id: str = "",
        owned: bool = False,
        owner_token: str = "",
        owned_window_ids=(),
        owned_process_id: int | None = None,
    ) -> None:
        super().__init__(
            provider="bridge",
            port=port,
            stop_event=stop_event,
            evidence=evidence,
            browser_session_id=browser_session_id,
            owned=owned,
            owner_token=owner_token,
            owned_window_ids=tuple(owned_window_ids or ()),
            owned_process_id=owned_process_id,
        )
        from .client import (
            BridgeCommandError,
            ChromeBridgeClient,
            ensure_bridge_server,
        )

        self.client_id = str(client_id or "")
        self._client_factory = client_factory or ChromeBridgeClient
        self._bridge_error_type = BridgeCommandError
        self._ensure_bridge = ensure_bridge or (
            lambda target_port: ensure_bridge_server(
                target_port,
                persistent=bool(persistent_bridge_server),
            )
        )
        self.fallback_to_latest = bool(fallback_to_latest)
        self.fallback_from_client_id = ""
        self.client = None
        self.current_tab_id = -1
        self.current_window_id = -1
        self.current_document_id = ""
        self.bridge_server_started = False
        self.bridge_server_reused = False
        self.compatibility = {}

    def _connection_details(self) -> dict:
        return {
            "bridge_port": self.port,
            "bridge_server_started": self.bridge_server_started,
            "bridge_server_reused": self.bridge_server_reused,
        }

    def capabilities(self) -> dict:
        operations = {
            name: True
            for name in (
                "state", "list_pages", "list_windows", "open_page", "open_window",
                "switch_page", "switch_window", "close_page", "close_window",
                "reload", "back", "forward", "snapshot", "find", "extract", "highlight",
                "screenshot", "click", "fill", "hover", "wait",
                "scroll", "press_key", "select", "double_click", "context_menu",
                "type_text", "clear", "focus", "check", "drag_and_drop", "upload",
            )
        }
        operations.update({
            "arbitrary_js": False,
            "full_page_screenshot": False,
            "close_browser": False,
            "dialogs": False,
            "download": False,
            "get_value": False,
            "trusted_click": False,
        })
        return {
            "provider": self.provider,
            "browser_session_id": self.browser_session_id,
            "operations": operations,
            "limitations": [
                "arbitrary JavaScript is disabled",
                "hover and non-trusted keyboard events may be synthetic",
                "full-page screenshots are not supported",
                "uploads require a configured local root and Chrome debugger permission",
                "downloads, dialogs, arbitrary JavaScript, and value reads are disabled",
                "closing user-owned windows requires explicit confirmation",
            ],
            "compatibility": dict(self.compatibility),
        }

    def connect(self) -> None:
        self.check_stopped()
        ok, details = self._ensure_bridge(self.port)
        self.bridge_server_started = "bridge_server_started=true" in details
        self.bridge_server_reused = "bridge_server_reused=true" in details
        if not ok:
            raise ConnectFailed(
                f"chrome bridge unavailable: {details}",
                code="bridge_server_unavailable",
                details=self._connection_details(),
            )
        bootstrap = self._client_factory(
            port=self.port,
            timeout=10,
            client_id=self.client_id,
        )
        self.fallback_from_client_id = ""
        saved_client_id = self.client_id
        try:
            if saved_client_id.endswith(":global"):
                raise self._bridge_error_type(
                    "global_client_dom_forbidden",
                    "the global browser client cannot be used for DOM operations",
                )
            if saved_client_id and not self.fallback_to_latest:
                candidate = self._client_factory(
                    port=self.port,
                    timeout=3,
                    client_id=saved_client_id,
                )
                candidate.state()
                selected_client_id = saved_client_id
            else:
                selector = getattr(bootstrap, "select_responsive_client", None)
                if callable(selector):
                    state = selector(saved_client_id)
                    selected_client_id = str(state.get("client_id") or "")
                else:
                    status = bootstrap.status()
                    active = status.get("active_clients") or {}
                    candidates = sorted(
                        (
                            (str(client_id), float(seen_at or 0))
                            for client_id, seen_at in active.items()
                        ),
                        key=lambda item: item[1],
                        reverse=True,
                    )
                    candidate_ids = [client_id for client_id, _ in candidates]
                    if saved_client_id in candidate_ids:
                        candidate_ids.remove(saved_client_id)
                        candidate_ids.insert(0, saved_client_id)
                    selected_client_id = ""
                    for candidate_id in candidate_ids:
                        try:
                            self._client_factory(
                                port=self.port,
                                timeout=3,
                                client_id=candidate_id,
                            ).state()
                        except Exception:
                            continue
                        selected_client_id = candidate_id
                        break
        except Exception as exc:
            error_code = "stale_client" if saved_client_id else "no_responsive_client"
            raise ConnectFailed(
                "chrome bridge has no responsive extension client; refresh target page",
                code=error_code,
                details=self._connection_details(),
            ) from exc
        if not selected_client_id:
            error_code = "stale_client" if saved_client_id else "no_responsive_client"
            raise ConnectFailed(
                "chrome bridge has no responsive extension client; refresh target page",
                code=error_code,
                details=self._connection_details(),
            )
        if saved_client_id and selected_client_id != saved_client_id:
            self.fallback_from_client_id = saved_client_id
        self.client_id = selected_client_id
        self.client = self._client_factory(
            port=self.port,
            timeout=10,
            client_id=self.client_id,
        )
        self.client.lease_provider = self.page_lease_metadata
        compatibility = getattr(self.client, "compatibility", None)
        if callable(compatibility):
            self.compatibility = compatibility(self.client_id)
            if self.compatibility.get("state") != "compatible":
                raise ConnectFailed(
                    "chrome bridge protocol metadata is missing or incompatible",
                    code="bridge_protocol_incompatible",
                    details={
                        **self._connection_details(),
                        "compatibility": self.compatibility,
                    },
                )
        try:
            connected_state = self.client.state()
        except Exception:
            connected_state = {}
        self._apply_state_identity(connected_state)

    def disconnect(self) -> None:
        self.client = None

    def use_client(self, client_id: str) -> None:
        self.client_id = str(client_id or "")
        self.client = self._client_factory(port=self.port, timeout=10, client_id=self.client_id)
        self.client.lease_provider = self.page_lease_metadata

    def page_lease_metadata(self) -> dict:
        """Return a fencing token bound to the current page and document client."""

        metadata = super().page_lease_metadata()
        if not metadata:
            return {}
        # The lease resource may name the page that a switch command is about
        # to activate, while delivery still originates from the currently
        # bound document.  Bind the transport identity to that current
        # document; the resource/owner/epoch fields independently fence the
        # intended automation target.
        target_page_id = str(self.current_page_id or "")
        client_id = str(self.client_id or "")
        tab_id = int(self.current_tab_id)
        if not target_page_id or not client_id or client_id.endswith(":global") or tab_id < 0:
            raise BrowserControlError(
                "page lease target identity is unavailable; bind a concrete Chrome page first"
            )
        metadata.update({
            "page_id": target_page_id,
            "client_id": client_id,
            "tab_id": tab_id,
        })
        if self.browser_session_id:
            metadata["browser_session_id"] = self.browser_session_id
        if self.current_document_id:
            metadata["document_id"] = self.current_document_id
        return metadata

    def _apply_state_identity(self, data: dict) -> None:
        page_id = str(data.get("page_id") or "")
        if page_id:
            self.current_page_id = page_id
        try:
            self.current_tab_id = int(data.get("tab_id", self.current_tab_id))
        except (TypeError, ValueError):
            pass
        try:
            self.current_window_id = int(data.get("window_id", self.current_window_id))
        except (TypeError, ValueError):
            pass
        session_id = str(data.get("browser_session_id") or "")
        if session_id:
            self.browser_session_id = session_id
        self.current_document_id = str(data.get("document_id") or "")

    def _bind_registered_page(self, page: dict) -> dict:
        client_id = str(page.get("client_id") or "")
        if not client_id or client_id.endswith(":global"):
            raise ConnectFailed(
                "target page has no document client",
                code="no_responsive_client",
            )
        self.use_client(client_id)
        self.current_page_id = str(page.get("page_id") or self.current_page_id or "")
        self.current_tab_id = int(page.get("tab_id") or -1)
        self.current_window_id = int(page.get("window_id") or -1)
        session_id = str(page.get("browser_session_id") or self.browser_session_id or "")
        if session_id:
            self.browser_session_id = session_id
        self.current_document_id = str(page.get("document_id") or "")
        return page

    def _client(self):
        if self.client is None:
            self.connect()
        return self.client

    def _rebind_current_document(self, *, timeout: float = 5) -> dict:
        """Rebind only the same tab/page after its document client went stale."""

        if self.current_tab_id < 0 or not self.current_page_id:
            raise ConnectFailed(
                "chrome bridge client is stale and no page identity is available",
                code="stale_client",
                details={"bridge_port": self.port},
            )
        probe = self._client_factory(port=self.port, timeout=3, client_id="")
        page = probe.wait_for_tab_client(
            self.current_tab_id,
            page_id=self.current_page_id,
            exclude_client_id=self.client_id,
            timeout=max(0.5, float(timeout)),
        )
        return self._bind_registered_page(page)

    def _page_command(self, callback):
        client = self._client()
        try:
            return callback(client)
        except self._bridge_error_type as exc:
            if exc.code != "bridge_client_stale":
                raise
            # A stale client may only be replaced by another document client
            # for the same stable page identity.  Never pick the latest active
            # tab: that can silently operate on a different user's page.
            self._rebind_current_document(timeout=5)
            return callback(self._client())

    @staticmethod
    def _frame_id(loc: dict) -> int:
        return int(loc.get("frame_id", loc.get("frameId", 0)) or 0)

    @staticmethod
    def _shadow_path(loc: dict):
        return loc.get("shadow_path", loc.get("shadowPath", None))

    def state(self) -> dict:
        self.check_stopped()
        data = self._client().state()
        self._apply_state_identity(data)
        return {
            "url": data.get("url", ""),
            "title": data.get("title", ""),
            "ready_state": data.get("readyState", ""),
            "provider": self.provider,
            "port": self.port,
            "client_id": data.get("client_id") or self.client_id,
            "browser_session_id": str(
                data.get("browser_session_id") or self.browser_session_id or ""
            ),
            "page_id": str(data.get("page_id") or self.current_page_id or ""),
            "tab_id": data.get("tab_id", self.current_tab_id),
            "window_id": data.get("window_id", self.current_window_id),
            "active": bool(data.get("active", True)),
            "controllable": bool(data.get("controllable", True)),
        }

    def list_pages(self) -> list[dict]:
        self.check_stopped()
        pages = self._page_command(lambda client: client.list_pages())
        for page in pages:
            session_id = str(page.get("browser_session_id") or self.browser_session_id or "")
            if session_id:
                self.browser_session_id = session_id
            page["browser_session_id"] = session_id
            page["owned"] = str(page.get("window_id") or "") in self.owned_window_ids
        return pages

    def list_windows(self) -> list[dict]:
        self.check_stopped()
        rows = self._page_command(lambda client: client.list_windows())
        for row in rows:
            session_id = str(row.get("browser_session_id") or self.browser_session_id or "")
            if session_id:
                self.browser_session_id = session_id
            row["browser_session_id"] = session_id
            row["owned"] = str(row.get("window_id") or "") in self.owned_window_ids
        return rows

    def get_page(self, page_id: str) -> dict:
        self.check_stopped()
        for page in self.list_pages():
            if str(page.get("page_id") or "") == str(page_id or ""):
                return page
        raise BrowserControlError(f"page_not_found: {page_id}")

    def open_page(
        self,
        url: str,
        *,
        open_mode: str = "new_tab",
        timeout: float = 20,
    ) -> dict:
        self.check_stopped()
        operation_id = "open_" + uuid.uuid4().hex

        def execute(client):
            return client.open_url(
                url,
                open_mode=open_mode,
                timeout_seconds=timeout,
                operation_id=operation_id,
            )

        navigation_started_at = time.time()
        result = self._page_command(execute)
        source_client = self._client()
        source_client_id = str(self.client_id or "")
        response = ((result.get("data") or {}).get("response") or {})
        try:
            tab_id = int(response["targetTabId"])
        except (KeyError, TypeError, ValueError) as exc:
            raise BrowserControlError("page_create_failed") from exc
        page_id = str(response.get("pageId") or "")
        page = source_client.wait_for_tab_client(
            tab_id,
            page_id=page_id,
            # The destination may legitimately redirect (for example to a
            # login or canonical URL).  Excluding the source document keeps a
            # current-tab navigation from accepting its pre-navigation client
            # without requiring the final public URL to equal the input URL.
            exclude_client_id=(source_client_id if open_mode == "current_tab" else ""),
            min_seen_at=navigation_started_at,
            timeout=timeout,
        )
        self._bind_registered_page(page)
        target_window_id = response.get("targetWindowId")
        if open_mode == "new_window" and target_window_id not in (None, ""):
            self.owned_window_ids.add(str(target_window_id))
        session_id = str(
            response.get("browserSessionId")
            or page.get("browser_session_id")
            or self.browser_session_id
            or ""
        )
        if session_id:
            self.browser_session_id = session_id
        if open_mode == "new_window":
            self.persist_ownership()
        return {
            **page,
            "page_id": str(page.get("page_id") or page_id),
            "tab_id": tab_id,
            "window_id": target_window_id,
            "browser_session_id": session_id,
            "owned": str(target_window_id or "") in self.owned_window_ids,
        }

    def switch_page(self, page_id: str, *, timeout: float = 10) -> dict:
        self.check_stopped()
        source_client = self._client()
        page = self._page_command(
            lambda client: client.switch_page(page_id, timeout=timeout)
        )
        if not page.get("controllable", True):
            raise BrowserControlError("target_page_not_controllable")
        source_client = self._client()
        registered = source_client.wait_for_tab_client(
            int(page.get("tab_id")),
            page_id=str(page.get("page_id") or page_id),
            expected_url=str(page.get("url") or ""),
            timeout=timeout,
        )
        self._bind_registered_page(registered)
        target_state = self.state()
        expected_url = _normalized_page_url(str(page.get("url") or ""))
        actual_url = _normalized_page_url(str(target_state.get("url") or ""))
        if (
            str(target_state.get("page_id") or "") != str(page_id)
            or int(target_state.get("tab_id") or -1) != int(page.get("tab_id") or -1)
            or (expected_url and actual_url != expected_url)
        ):
            raise BrowserControlError("target_page_context_mismatch")
        page.update(registered)
        page.update(target_state)
        page["client_id"] = self.client_id
        return page

    def close_page(self, page_id: str) -> dict:
        self.check_stopped()
        result = self._page_command(lambda client: client.close_page(page_id))
        try:
            state = self._client_factory(
                port=self.port,
                timeout=3,
                client_id="",
            ).select_responsive_client("")
        except Exception:
            self.client = None
            self.client_id = ""
        else:
            self.use_client(str(state.get("client_id") or ""))
        return result

    def switch_window(self, window_id: str, *, timeout: float = 10) -> dict:
        self.check_stopped()
        source_client = self._client()
        result = self._page_command(
            lambda client: client.switch_window(int(window_id), timeout=timeout)
        )
        source_client = self._client()
        active_page = result.get("active_page") or {}
        if not isinstance(active_page, dict) or not active_page.get("page_id"):
            raise BrowserControlError("target_window_has_no_active_page")
        if not active_page.get("controllable", True):
            raise BrowserControlError("target_page_not_controllable")
        registered = source_client.wait_for_tab_client(
            int(active_page.get("tab_id") or -1),
            page_id=str(active_page.get("page_id") or ""),
            expected_url=str(active_page.get("url") or ""),
            timeout=timeout,
        )
        self._bind_registered_page(registered)
        target_state = self.state()
        if (
            int(target_state.get("window_id") or -1) != int(window_id)
            or str(target_state.get("page_id") or "")
            != str(active_page.get("page_id") or "")
            or int(target_state.get("tab_id") or -1)
            != int(active_page.get("tab_id") or -1)
        ):
            raise BrowserControlError("target_window_context_mismatch")
        result["active_page"] = {**active_page, **registered, **target_state}
        result["window_id"] = int(window_id)
        result["client_id"] = self.client_id
        return result

    def close_window(
        self,
        window_id: str,
        *,
        confirmation: str = "",
        allow_user_window: bool = False,
    ) -> dict:
        self.check_stopped()
        owned = str(window_id or "") in self.owned_window_ids
        if not owned and (
            not allow_user_window or not str(confirmation or "").strip()
        ):
            raise BrowserControlError("user_window_close_requires_confirmation")
        result = self._page_command(
            lambda client: client.close_window(int(window_id))
        )
        self.owned_window_ids.discard(str(window_id))
        self.persist_ownership()
        return result

    def close_browser(
        self,
        *,
        confirmation: str = "",
        allow_user_browser: bool = False,
    ) -> dict:
        self.check_stopped()
        if allow_user_browser and not str(confirmation or "").strip():
            raise BrowserControlError("user_browser_close_requires_confirmation")
        windows = self.list_windows()
        targets = [
            str(row.get("window_id") or "")
            for row in windows
            if allow_user_browser
            or str(row.get("window_id") or "") in self.owned_window_ids
        ]
        if not targets:
            raise BrowserControlError("browser_not_owned: no safe bridge window to close")
        closed = []
        for window_id in targets:
            closed.append(
                self.close_window(
                    window_id,
                    confirmation=confirmation,
                    allow_user_window=allow_user_browser,
                )
            )
        response = {
            "closed": True,
            "browser_session_id": self.browser_session_id,
            "closed_window_ids": targets,
            "closed_user_browser": bool(allow_user_browser),
            "results": closed,
        }
        if not self.owned_window_ids:
            self.remove_ownership()
        return response

    def goto(self, url: str, *, wait_until: str = "load", timeout: float = 30) -> None:
        self.check_stopped()
        self.open_page(url, open_mode="current_tab", timeout=timeout)

    def _navigate(self, action: str, *, timeout: float = 30) -> dict:
        self.check_stopped()
        source_client = self._client()
        old_client_id = self.client_id
        old_page_id = self.current_page_id
        old_tab_id = self.current_tab_id
        navigation_started_at = time.time()
        result = self._page_command(
            lambda client: client.navigate(action, timeout=timeout)
        )
        source_client = self._client()
        page_id = str(result.get("page_id") or old_page_id)
        tab_id = int(result.get("tab_id") or old_tab_id)
        if not page_id or tab_id < 0:
            raise BrowserControlError("navigation_identity_missing")
        registered = source_client.wait_for_tab_client(
            tab_id,
            page_id=page_id,
            exclude_client_id=old_client_id,
            min_seen_at=navigation_started_at,
            timeout=timeout,
        )
        self._bind_registered_page(registered)
        state = self.state()
        if (
            str(state.get("page_id") or "") != page_id
            or int(state.get("tab_id") or -1) != tab_id
        ):
            raise BrowserControlError("navigation_context_mismatch")
        return {**result, **registered, **state, "client_id": self.client_id}

    def reload(self, *, timeout: float = 30) -> dict:
        return self._navigate("reload", timeout=timeout)

    def go_back(self, *, timeout: float = 30) -> dict:
        return self._navigate("back", timeout=timeout)

    def go_forward(self, *, timeout: float = 30) -> dict:
        return self._navigate("forward", timeout=timeout)

    def wait_for(self, selector: str, *, state: str = "visible", timeout: float = 10, **loc) -> None:
        self.check_stopped()
        try:
            self._client().wait_selector(
                selector,
                state=state,
                timeout_ms=int(float(timeout) * 1000),
                frame_id=self._frame_id(loc),
                shadow_path=self._shadow_path(loc),
            )
        except Exception as exc:
            if "timeout" in str(exc).lower():
                raise WaitTimeout(str(exc)) from exc
            raise

    def click(self, selector: str, *, timeout: float = 10, **loc) -> None:
        self.check_stopped()
        self._client().click_selector(
            selector,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def click_text(
        self,
        text: str,
        *,
        selector: str = "",
        exact: bool = True,
        timeout: float = 10,
    ) -> dict:
        self.check_stopped()
        return self._client().click_text(
            text,
            selector=selector,
            exact=exact,
            timeout=timeout,
        )

    def fill(self, selector: str, text: str, *, timeout: float = 10, **loc) -> None:
        self.check_stopped()
        self._client().input_selector(
            selector,
            text,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def type_text(self, selector: str, text: str, *, delay_ms: int = 40, **loc) -> dict:
        self.check_stopped()
        return self._client().type_text(
            selector,
            text,
            delay_ms=delay_ms,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def clear(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        self.check_stopped()
        return self._client().clear_selector(
            selector,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def focus(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        self.check_stopped()
        return self._client().focus_selector(
            selector,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def check(self, selector: str, *, checked: bool = True, **loc) -> dict:
        self.check_stopped()
        return self._client().check_selector(
            selector,
            checked=checked,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def get_value(self, selector: str, **loc) -> str:
        raise CapabilityNotSupported(
            "bridge backend does not expose input values; use a page-specific confirmation"
        )

    def drag_and_drop(self, source: str, target: str, **loc) -> dict:
        self.check_stopped()
        return self._client().drag_and_drop(
            source,
            target,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
            source_shadow_path=loc.get("source_shadow_path"),
            target_shadow_path=loc.get("target_shadow_path"),
        )

    def dialog_state(self) -> dict:
        raise CapabilityNotSupported("bridge backend does not expose dialogs")

    def handle_dialog(
        self,
        *,
        accept: bool,
        prompt_text: str = "",
        confirmation: str = "",
    ) -> dict:
        raise CapabilityNotSupported("bridge backend does not expose dialogs")

    def find_elements(
        self,
        *,
        text: str = "",
        exact: bool = False,
        role: str = "",
        tag: str = "",
        attrs: dict[str, str] | None = None,
        limit: int = 10,
        all_frames: bool = False,
        include_shadow: bool = True,
    ) -> list[dict]:
        self.check_stopped()
        return self._client().find_elements(
            text=text,
            exact=exact,
            role=role,
            tag=tag,
            attrs=attrs,
            limit=limit,
            all_frames=all_frames,
            include_shadow=include_shadow,
        )

    def extract_elements(
        self,
        selector: str,
        *,
        fields: list[str] | tuple[str, ...] | None = None,
        limit: int = 100,
        include_hidden: bool = False,
        all_frames: bool = False,
        include_shadow: bool = True,
    ) -> dict:
        self.check_stopped()
        return self._client().extract_elements(
            selector,
            fields=fields,
            limit=limit,
            include_hidden=include_hidden,
            all_frames=all_frames,
            include_shadow=include_shadow,
        )

    def inspect_point(self, x: int, y: int) -> dict:
        self.check_stopped()
        return self._client().inspect_point(x, y)

    def scan_top_elements(self, max_top: int = 900, limit: int = 80) -> list[dict]:
        self.check_stopped()
        return self._client().scan_top_elements(max_top=max_top, limit=limit)

    def hover(self, selector: str, *, timeout: float = 10, **loc) -> None:
        self.check_stopped()
        self._client().hover_selector(
            selector,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def press_key(
        self,
        key: str,
        *,
        selector: str = "",
        ctrl: bool = False,
        alt: bool = False,
        shift: bool = False,
        meta: bool = False,
        **loc,
    ) -> dict:
        self.check_stopped()
        return self._client().press_key(
            key,
            selector=selector,
            ctrl=ctrl,
            alt=alt,
            shift=shift,
            meta=meta,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def select_option(
        self,
        selector: str,
        *,
        value: str = "",
        label: str = "",
        index: int = -1,
        **loc,
    ) -> dict:
        self.check_stopped()
        return self._client().select_option(
            selector,
            value=value,
            label=label,
            index=index,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def scroll(
        self,
        *,
        selector: str = "",
        x: int = 0,
        y: int = 0,
        behavior: str = "auto",
        block: str = "center",
        **loc,
    ) -> dict:
        self.check_stopped()
        return self._client().scroll(
            selector=selector,
            x=x,
            y=y,
            behavior=behavior,
            block=block,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def double_click(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        self.check_stopped()
        return self._client().double_click_selector(
            selector,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def context_menu(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        self.check_stopped()
        return self._client().context_menu_selector(
            selector,
            timeout=timeout,
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def trusted_click(self, selector: str, *, timeout_ms: int = 5000, expected_url_prefix: str = "", **loc) -> dict:
        raise CapabilityNotSupported("bridge backend does not expose trusted click")

    def trusted_click_and_wait_download(
        self,
        selector: str,
        *,
        timeout: float = 60,
        poll_interval: float = 0.25,
        progress_callback=None,
        **loc,
    ) -> dict:
        raise CapabilityNotSupported("bridge backend does not expose downloads")

    def upload_file(
        self,
        selector: str,
        file_paths,
        *,
        multiple: bool = False,
        timeout_ms: int = 10000,
        **loc,
    ) -> dict:
        self.check_stopped()
        return self._client().upload_file(
            selector,
            file_paths,
            multiple=multiple,
            timeout=max(1, int(timeout_ms)) / 1000,
        )

    def highlight(self, selector: str, *, duration_ms: int = 1600, **loc) -> None:
        self.check_stopped()
        self._client().highlight_selector(
            selector,
            duration=int(duration_ms),
            frame_id=self._frame_id(loc),
            shadow_path=self._shadow_path(loc),
        )

    def screenshot(self, path: str = "", *, full_page: bool = False) -> str:
        self.check_stopped()
        if full_page:
            raise CapabilityNotSupported("bridge screenshot only supports visible viewport")
        response = self._client().screenshot()
        data_url = str(response.get("dataUrl") or "")
        if not data_url.startswith("data:image/png;base64,"):
            raise RuntimeError("chrome bridge screenshot returned invalid data")
        try:
            image_bytes = base64.b64decode(data_url.split(",", 1)[1], validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise RuntimeError("chrome bridge screenshot returned invalid PNG data") from exc
        if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError("chrome bridge screenshot returned invalid PNG data")
        out = Path(path).expanduser().resolve() if path else self.evidence_path("screenshot")
        if out.suffix.lower() != ".png":
            raise BrowserControlError("screenshot output must use a .png file name")
        out.parent.mkdir(parents=True, exist_ok=True)
        # Never overwrite an existing local file.  Browser content is
        # untrusted and must not be able to turn a screenshot request into a
        # destructive filesystem write.
        try:
            with out.open("xb") as handle:
                handle.write(image_bytes)
        except FileExistsError as exc:
            raise ArtifactExists(f"screenshot output already exists: {out}") from exc
        return str(out)

    def snapshot(self, *, scope: str = "viewport", within: str = "", limit: int = 120) -> SnapshotResult:
        self.check_stopped()
        return self._client().snapshot(scope=scope, within=within, limit=limit)

    def click_ref(self, ref: str, snapshot_id: str, *, timeout: float = 10) -> None:
        self.check_stopped()
        try:
            self._client().click_ref(ref, snapshot_id, timeout=timeout)
        except Exception as exc:
            if "StaleElementRef" in str(exc):
                raise StaleElementRef(str(exc)) from exc
            raise

    def highlight_ref(self, ref: str, snapshot_id: str, *, duration_ms: int = 1600) -> None:
        self.check_stopped()
        try:
            self._client().highlight_ref(ref, snapshot_id, duration=int(duration_ms))
        except Exception as exc:
            if "StaleElementRef" in str(exc):
                raise StaleElementRef(str(exc)) from exc
            raise

    def run_js(self, script: str, *args):
        raise CapabilityNotSupported("bridge backend does not support arbitrary js")
