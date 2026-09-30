"""Chrome extension bridge HTTP client."""

from __future__ import annotations

import json
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .base import UnsupportedCapability
from .compatibility import (
    BRIDGE_RUNTIME_CONTRACT,
    MAX_PROTOCOL_VERSION,
    MIN_PROTOCOL_VERSION,
    STANDALONE_BROWSER_CONTROL_VERSION,
)
from .process_lock import process_lock
from .runtime_paths import log_dir, token_path


DEFAULT_BRIDGE_PORT = 16881
GLOBAL_CLIENT_SUFFIX = ":global"
_IN_PROCESS_SERVER = None
BRIDGE_TOKEN_PATH = token_path()


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not let authenticated bridge requests follow a redirect.

    A redirect would otherwise give ``urllib`` an opportunity to replay the
    request headers (including the bridge token) to another origin.  Bridge
    endpoints are local and never need redirects, so a 3xx is always a hard
    failure.
    """

    def redirect_request(self, *_args, **_kwargs):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler)


def bridge_token(path: Path | None = None) -> str:
    """Read the local bridge token without ever placing it in a URL."""

    target = Path(path) if path is not None else token_path()
    try:
        value = target.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ConnectionError("Chrome bridge authentication token is unavailable") from exc
    if not value:
        raise ConnectionError("Chrome bridge authentication token is empty")
    return value


class BridgeCommandError(RuntimeError):
    """Structured bridge command failure."""

    def __init__(
        self,
        code: str,
        message: str = "",
        *,
        http_status: int | None = None,
        payload: dict | None = None,
        outcome: str = "failed",
    ) -> None:
        self.code = str(code or "bridge_command_failed")
        self.message = str(message or self.code)
        self.http_status = http_status
        self.payload = dict(payload or {})
        self.outcome = str(outcome or "failed")
        super().__init__(f"{self.code}: {self.message}")


class ChromeBridgeClient:
    """Client for the local Chrome Browser Control extension server."""

    def __init__(self, port: int = DEFAULT_BRIDGE_PORT, timeout: float = 10, client_id: str = ""):
        self.port = int(port)
        self.timeout = float(timeout)
        self.client_id = str(client_id or "")
        self.lease_provider = None

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def status(self) -> dict:
        payload = self._get_json("/api/status")
        if int(payload.get("bridge_api_version") or 0) < 3:
            raise BridgeCommandError(
                "bridge_server_upgrade_required",
                "Chrome bridge server is outdated; restart the local bridge service",
                payload={"bridge_api_version": payload.get("bridge_api_version")},
            )
        return payload

    def status_summary(self) -> list[str]:
        status = self.status()
        now = time.time()
        clients = status.get("clients") or {}
        active = status.get("active_clients") or {}
        rows = [
            f"status_clients={len(clients) if isinstance(clients, dict) else 0}",
            f"status_active_clients={len(active) if isinstance(active, dict) else 0}",
        ]
        if isinstance(clients, dict) and clients:
            latest_id, latest_seen = max(
                clients.items(),
                key=lambda item: float(item[1] or 0),
            )
            rows.append(f"status_latest_client={latest_id}")
            rows.append(f"status_latest_client_age={max(0, now - float(latest_seen or 0)):.1f}s")
        if status.get("active_client_max_age"):
            rows.append(f"status_active_client_max_age={status.get('active_client_max_age')}s")
        return rows

    def compatibility(self, client_id: str = "") -> dict:
        from .compatibility import evaluate_compatibility

        return evaluate_compatibility(
            self.status(),
            client_id=str(client_id or self.client_id or ""),
        )

    def select_responsive_client(
        self,
        preferred_client_id: str = "",
        *,
        exclude: set[str] | None = None,
        probe_timeout: float = 2,
        max_candidates: int = 8,
    ) -> dict:
        """Return the first active client that actually answers ``state``."""
        status = self.status()
        active = status.get("active_clients") or {}
        if not isinstance(active, dict):
            active = {}
        metadata = status.get("client_meta") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        excluded = {str(item) for item in (exclude or set()) if str(item)}
        preferred = str(preferred_client_id or "").strip()
        ordered = sorted(
            (
                (str(client_id), float(seen_at or 0))
                for client_id, seen_at in active.items()
                if str(client_id) not in excluded
                and not str(client_id).endswith(GLOBAL_CLIENT_SUFFIX)
                and self._is_document_client(metadata.get(str(client_id)) if isinstance(metadata, dict) else None)
            ),
            key=lambda item: item[1],
            reverse=True,
        )
        candidate_ids = [client_id for client_id, _seen_at in ordered]
        if preferred in candidate_ids:
            candidate_ids.remove(preferred)
            candidate_ids.insert(0, preferred)

        attempted: list[str] = []
        for client_id in candidate_ids[: max(1, int(max_candidates))]:
            attempted.append(client_id)
            candidate = type(self)(
                port=self.port,
                timeout=max(0.5, float(probe_timeout)),
                client_id=client_id,
            )
            try:
                state = candidate.state()
            except (ConnectionError, RuntimeError):
                continue
            if str(state.get("client_id") or client_id) != client_id:
                continue
            state["client_id"] = client_id
            return state
        raise BridgeCommandError(
            "no_responsive_client",
            "Chrome 插件桥没有可响应的页面客户端。",
            payload={
                "active_clients": list(active),
                "attempted_clients": attempted,
            },
        )

    def state(self) -> dict:
        result = self.run("state")
        data = result.get("data") or {}
        response = data.get("response") or {}
        identity = response.get("identity") or {}
        return {
            "bridge_port": self.port,
            "client_id": result.get("client_id") or self.client_id,
            "source": result.get("source") or "",
            "url": response.get("url") or data.get("tabUrl") or "",
            "title": response.get("title") or data.get("tabTitle") or "",
            "readyState": response.get("readyState") or "",
            "browser_session_id": str(identity.get("browserSessionId") or ""),
            "page_id": str(identity.get("pageId") or ""),
            "tab_id": self._safe_int(identity.get("tabId"), -1),
            "window_id": self._safe_int(identity.get("windowId"), -1),
            "active": bool(identity.get("active")),
            "controllable": bool(identity.get("controllable", True)),
            "client_scope": str(
                response.get("clientScope")
                or identity.get("clientScope")
                or "document"
            ),
            "document_id": str(
                response.get("documentId") or identity.get("documentId") or ""
            ),
            "document_lifecycle": str(
                response.get("documentLifecycle")
                or identity.get("documentLifecycle")
                or ""
            ),
        }

    @staticmethod
    def _is_document_client(metadata: dict | None) -> bool:
        if not isinstance(metadata, dict):
            return True
        scope = str(
            metadata.get("client_scope")
            or metadata.get("scope")
            or "document"
        ).strip().lower()
        return scope not in {"browser", "global"}

    def open_url(
        self,
        url: str,
        *,
        open_mode: str = "new_tab",
        timeout_seconds: float = 20,
        operation_id: str = "",
    ) -> dict:
        timeout_ms = max(1000, int(float(timeout_seconds) * 1000))
        params = {
            "url": str(url or ""),
            "openMode": str(open_mode or "new_tab"),
            "timeoutMs": str(timeout_ms),
        }
        if operation_id:
            params["operationId"] = str(operation_id)
        return self._run_with_params(
            "open_url",
            params,
            timeout=max(self.timeout, float(timeout_seconds) + 5),
        )

    def list_pages(self) -> list[dict]:
        result = self._run_with_params("list_pages", {})
        response = ((result.get("data") or {}).get("response") or {})
        pages = response.get("pages") or []
        browser_session_id = str(response.get("browserSessionId") or "")
        if not isinstance(pages, list):
            raise BridgeCommandError(
                "page_list_invalid",
                "Chrome 插件桥返回的页面列表格式无效。",
            )
        status = self.status()
        active = status.get("active_clients") or {}
        metadata = status.get("client_meta") or {}
        clients_by_tab: dict[int, list[tuple[str, float]]] = {}
        if isinstance(metadata, dict) and isinstance(active, dict):
            for client_id, meta in metadata.items():
                if client_id not in active or not isinstance(meta, dict):
                    continue
                if not self._is_document_client(meta) or str(client_id).endswith(GLOBAL_CLIENT_SUFFIX):
                    continue
                try:
                    tab_id = int(meta.get("tab_id"))
                except (TypeError, ValueError):
                    continue
                clients_by_tab.setdefault(tab_id, []).append(
                    (str(client_id), float(active.get(client_id) or 0))
                )
        normalized: list[dict] = []
        for raw_page in pages:
            if not isinstance(raw_page, dict):
                continue
            page = dict(raw_page)
            tab_id = self._safe_int(page.get("tabId"), -1)
            candidates = sorted(
                clients_by_tab.get(tab_id, []),
                key=lambda item: item[1],
                reverse=True,
            )
            page_url = self._normalized_url(str(page.get("url") or ""))
            page_id = str(page.get("pageId") or "")
            if page_url:
                candidates = [
                    candidate
                    for candidate in candidates
                    if (
                        self._normalized_url(
                            str((metadata.get(candidate[0]) or {}).get("url") or "")
                        ) == page_url
                        and self._is_active_document(metadata.get(candidate[0]) or {})
                        and (
                            not (metadata.get(candidate[0]) or {}).get("page_id")
                            or str((metadata.get(candidate[0]) or {}).get("page_id")) == page_id
                        )
                    )
                ]
            page["page_id"] = page_id
            page["browser_session_id"] = str(
                page.pop("browserSessionId", "") or browser_session_id
            )
            page["tab_id"] = tab_id
            page["window_id"] = self._safe_int(page.pop("windowId", -1), -1)
            page["client_id"] = candidates[0][0] if candidates else ""
            page["ready_state"] = ""
            if candidates:
                meta = metadata.get(candidates[0][0]) or {}
                page["ready_state"] = str(meta.get("ready_state") or "")
            normalized.append(page)
        return normalized

    def list_windows(self) -> list[dict]:
        result = self._run_with_params("list_windows", {})
        response = ((result.get("data") or {}).get("response") or {})
        rows = response.get("windows") or []
        if not isinstance(rows, list):
            raise BridgeCommandError(
                "window_list_invalid",
                "Chrome 插件桥返回的窗口列表格式无效。",
            )
        browser_session_id = str(response.get("browserSessionId") or "")
        normalized: list[dict] = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            row = dict(raw)
            row["browser_session_id"] = str(
                row.pop("browserSessionId", "") or browser_session_id
            )
            row["window_id"] = self._safe_int(row.pop("windowId", -1), -1)
            pages = []
            for raw_page in row.get("pages") or []:
                if not isinstance(raw_page, dict):
                    continue
                page = dict(raw_page)
                page["browser_session_id"] = str(
                    page.pop("browserSessionId", "") or browser_session_id
                )
                page["page_id"] = str(page.pop("pageId", "") or "")
                page["tab_id"] = self._safe_int(page.pop("tabId", -1), -1)
                page["window_id"] = self._safe_int(page.pop("windowId", -1), -1)
                pages.append(page)
            row["pages"] = pages
            normalized.append(row)
        return normalized

    def switch_window(self, window_id: int, *, timeout: float | None = None) -> dict:
        result = self._run_with_params(
            "switch_window",
            {"windowId": str(int(window_id))},
            timeout=timeout,
        )
        response = ((result.get("data") or {}).get("response") or {})
        if not isinstance(response, dict):
            raise BridgeCommandError("window_switch_failed")
        return self._normalize_window_response(response, result=result)

    def close_window(self, window_id: int) -> dict:
        result = self._run_with_params(
            "close_window",
            {"windowId": str(int(window_id))},
        )
        response = ((result.get("data") or {}).get("response") or {})
        if not isinstance(response, dict):
            raise BridgeCommandError("window_close_failed")
        return self._normalize_window_response(response, result=result)

    def navigate(self, action: str, *, timeout: float | None = None) -> dict:
        return self._navigate(action, timeout=timeout)

    def _navigate(self, action: str, *, timeout: float | None = None) -> dict:
        action = str(action or "").strip().lower()
        if action not in {"reload", "back", "forward"}:
            raise ValueError(f"unsupported navigation: {action}")
        result = self._run_with_params(
            "navigate",
            {"navigationAction": action},
            timeout=timeout,
        )
        response = ((result.get("data") or {}).get("response") or {})
        if not isinstance(response, dict):
            raise BridgeCommandError("navigation_failed")
        return self._normalize_page_payload(
            response,
            client_id=str(result.get("client_id") or self.client_id or ""),
        )

    def switch_page(self, page_id: str, *, timeout: float | None = None) -> dict:
        tab_id = self._tab_id_from_page_id(page_id)
        result = self._run_with_params(
            "switch_page",
            {"pageId": str(page_id), "tabId": str(tab_id)},
            timeout=timeout,
        )
        return self._page_response(result)

    def close_page(self, page_id: str) -> dict:
        tab_id = self._tab_id_from_page_id(page_id)
        result = self._run_with_params(
            "close_page",
            {"pageId": str(page_id), "tabId": str(tab_id)},
        )
        response = ((result.get("data") or {}).get("response") or {})
        if not isinstance(response, dict):
            raise BridgeCommandError(
                "page_close_failed",
                "Chrome 插件桥返回的关闭页面结果无效。",
            )
        return response

    @staticmethod
    def _tab_id_from_page_id(page_id: str) -> int:
        parts = str(page_id or "").rsplit(":", 1)
        if len(parts) != 2 or not parts[0].startswith("bridge:"):
            raise BridgeCommandError("page_not_found", "页面 ID 无效。")
        try:
            tab_id = int(parts[1])
        except (TypeError, ValueError) as exc:
            raise BridgeCommandError("page_not_found", "页面 ID 无效。") from exc
        if tab_id < 0:
            raise BridgeCommandError("page_not_found", "页面 ID 无效。")
        return tab_id

    @staticmethod
    def _page_response(result: dict) -> dict:
        response = ((result.get("data") or {}).get("response") or {})
        if not isinstance(response, dict):
            raise BridgeCommandError(
                "page_operation_failed",
                "Chrome 插件桥返回的页面结果无效。",
            )
        return ChromeBridgeClient._normalize_page_payload(
            response,
            client_id=str(result.get("client_id") or ""),
        )

    @staticmethod
    def _normalize_page_payload(payload: dict, *, client_id: str = "") -> dict:
        """Normalize extension page responses to the Python snake_case contract."""

        page = dict(payload or {})
        page_id = str(page.pop("pageId", page.get("page_id", "")) or "")
        tab_id = ChromeBridgeClient._safe_int(
            page.pop("tabId", page.get("tab_id", -1)),
            -1,
        )
        window_id = ChromeBridgeClient._safe_int(
            page.pop("windowId", page.get("window_id", -1)),
            -1,
        )
        session_id = str(
            page.pop("browserSessionId", page.get("browser_session_id", "")) or ""
        )
        page["page_id"] = page_id
        page["tab_id"] = tab_id
        page["window_id"] = window_id
        page["browser_session_id"] = session_id
        if client_id:
            page["client_id"] = client_id
        return page

    @staticmethod
    def _normalize_window_response(response: dict, *, result: dict | None = None) -> dict:
        result = result or {}
        output = dict(response)
        output["browser_session_id"] = str(
            output.pop("browserSessionId", output.get("browser_session_id", "")) or ""
        )
        output["window_id"] = ChromeBridgeClient._safe_int(
            output.pop("windowId", output.get("window_id", -1)),
            -1,
        )
        active_page = output.pop("activePage", output.get("active_page"))
        output["active_page"] = (
            ChromeBridgeClient._normalize_page_payload(
                active_page,
                client_id=str(result.get("client_id") or ""),
            )
            if isinstance(active_page, dict)
            else None
        )
        return output

    @staticmethod
    def _safe_int(value, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return int(default)

    def start_pairing(self) -> dict:
        """Create a short-lived, one-use extension pairing code.

        The long-lived bridge token is used only in this authenticated local
        POST and is never returned or placed in a browser URL.
        """

        payload = self._post_json("/api/pairing/start", {}, timeout=self.timeout)
        code = str(payload.get("pairing_code") or "").strip()
        if not code:
            raise RuntimeError("Chrome bridge pairing response did not contain a code")
        return {
            "pairing_code": code,
            "expires_in_seconds": int(payload.get("expires_in_seconds") or 0),
        }

    def bootstrap_url(self, nonce: str | None = None) -> tuple[str, str]:
        """Return a bootstrap URL containing only a one-use pairing code."""

        value = str(nonce or uuid.uuid4().hex)
        pairing = self.start_pairing()
        query = urllib.parse.urlencode({
            "bridge_nonce": value,
            "bridge_port": self.port,
            "pairing_code": pairing["pairing_code"],
        })
        return f"{self.base_url}/bridge-bootstrap?{query}", value

    def wait_for_bootstrap_client(
        self,
        nonce: str,
        *,
        timeout: float = 20,
        poll_interval: float = 0.2,
    ) -> dict:
        expected_nonce = str(nonce or "")
        deadline = time.monotonic() + max(0.1, float(timeout))
        while time.monotonic() < deadline:
            status = self.status()
            active = status.get("active_clients") or {}
            metadata = status.get("client_meta") or {}
            if isinstance(metadata, dict):
                candidates = sorted(
                    metadata.items(),
                    key=lambda item: float(active.get(item[0]) or 0),
                    reverse=True,
                )
                for client_id, meta in candidates:
                    if not isinstance(meta, dict) or client_id not in active:
                        continue
                    if str(client_id).endswith(GLOBAL_CLIENT_SUFFIX) or not self._is_document_client(meta):
                        continue
                    if str(meta.get("ready_state") or "") != "complete":
                        continue
                    if not self._is_bootstrap_url(str(meta.get("url") or ""), expected_nonce):
                        continue
                    tab_id = meta.get("tab_id")
                    if not isinstance(tab_id, int) or tab_id < 0:
                        continue
                    return {
                        "client_id": str(client_id),
                        "tab_id": tab_id,
                        "url": str(meta.get("url") or ""),
                        "title": str(meta.get("title") or ""),
                    }
            time.sleep(max(0.05, float(poll_interval)))
        raise TimeoutError("Chrome bridge bootstrap client registration timed out")

    def wait_for_tab_client(
        self,
        tab_id: int,
        *,
        page_id: str = "",
        expected_url: str = "",
        exclude_client_id: str = "",
        min_seen_at: float = 0,
        timeout: float = 20,
        poll_interval: float = 0.2,
    ) -> dict:
        expected = self._normalized_url(expected_url)
        deadline = time.monotonic() + max(0.1, float(timeout))
        latest_meta: dict = {}
        while time.monotonic() < deadline:
            status = self.status()
            active = status.get("active_clients") or {}
            metadata = status.get("client_meta") or {}
            if isinstance(metadata, dict):
                candidates = sorted(
                    metadata.items(),
                    key=lambda item: float(active.get(item[0]) or 0),
                    reverse=True,
                )
                for client_id, meta in candidates:
                    if not isinstance(meta, dict):
                        continue
                    if str(client_id) == str(exclude_client_id or ""):
                        continue
                    if not self._is_document_client(meta):
                        continue
                    if int(meta.get("tab_id") or -1) != int(tab_id):
                        continue
                    if float(active.get(client_id) or 0) < float(min_seen_at or 0):
                        continue
                    latest_meta = meta
                    actual = self._normalized_url(str(meta.get("url") or ""))
                    if (
                        client_id in active
                        and str(meta.get("ready_state") or "") == "complete"
                        and self._is_active_document(meta)
                        and (
                            not page_id
                            or str(meta.get("page_id") or "") == str(page_id)
                        )
                        and (not expected or actual == expected)
                    ):
                        page = {
                            "client_id": str(client_id),
                            "tab_id": int(tab_id),
                            "url": str(meta.get("url") or ""),
                            "title": str(meta.get("title") or ""),
                            "window_id": self._safe_int(meta.get("window_id"), -1),
                            "browser_session_id": str(meta.get("browser_session_id") or ""),
                            "document_id": str(meta.get("document_id") or ""),
                            "document_lifecycle": str(meta.get("document_lifecycle") or ""),
                        }
                        if page_id:
                            page["page_id"] = str(page_id)
                        return page
            time.sleep(max(0.05, float(poll_interval)))
        details = f"tabId={int(tab_id)}"
        if expected:
            details += f", expected_url={expected}"
        if latest_meta:
            details += f", latest_url={self._normalized_url(str(latest_meta.get('url') or ''))}"
        if latest_meta and str(latest_meta.get("ready_state") or "") != "complete":
            raise BridgeCommandError(
                "page_load_timeout",
                f"目标页面未在规定时间内加载完成: {details}",
                payload={"tab_id": int(tab_id), "latest_meta": latest_meta},
            )
        raise BridgeCommandError(
            "client_id_registration_timeout",
            f"Chrome 扩展客户端未在规定时间内登记: {details}",
            payload={"tab_id": int(tab_id), "latest_meta": latest_meta},
        )

    def scan_elements(
        self,
        *,
        max_top: int = 900,
        offset_top: int = 0,
        segment_height: int = 0,
        limit: int = 80,
        all_frames: bool = False,
        include_shadow: bool = True,
    ) -> dict:
        result = self._run_with_params(
            "scan",
            {
                "maxTop": str(int(max_top)),
                "offsetTop": str(max(0, int(offset_top))),
                "segmentHeight": str(max(0, int(segment_height))),
                "limit": str(max(1, min(1000, int(limit)))),
                "allFrames": self._bool_text(all_frames),
                "includeShadow": self._bool_text(include_shadow),
            },
        )
        data = result.get("data") or {}
        response = data.get("response") or {}
        return response if isinstance(response, dict) else {}

    def scan_top_elements(self, max_top: int = 900, limit: int = 80) -> list[dict]:
        response = self.scan_elements(max_top=max_top, limit=limit)
        elements = response.get("elements") or []
        return elements if isinstance(elements, list) else []

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
        result = self._run_with_params(
            "find",
            {
                "text": str(text or ""),
                "exact": self._bool_text(exact),
                "role": str(role or ""),
                "tag": str(tag or ""),
                "attr": json.dumps(attrs or {}, ensure_ascii=False),
                "limit": str(max(1, min(1000, int(limit)))),
                "allFrames": self._bool_text(all_frames),
                "includeShadow": self._bool_text(include_shadow),
            },
        )
        data = result.get("data") or {}
        response = data.get("response") or {}
        elements = response.get("elements") or []
        return elements if isinstance(elements, list) else []

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
        selected_fields = list(fields or ("visibleText", "href", "title", "ariaLabel"))
        result = self._run_with_params(
            "extract",
            {
                "css": str(selector or ""),
                "fields": json.dumps(selected_fields, ensure_ascii=False),
                "limit": str(max(1, min(1000, int(limit)))),
                "includeHidden": self._bool_text(include_hidden),
                "allFrames": self._bool_text(all_frames),
                "includeShadow": self._bool_text(include_shadow),
            },
        )
        data = result.get("data") or {}
        response = data.get("response") or {}
        return response if isinstance(response, dict) else {}

    def snapshot(
        self,
        *,
        scope: str = "viewport",
        within: str = "",
        limit: int = 120,
    ) -> dict:
        result = self._run_with_params(
            "snapshot",
            {
                "scope": str(scope or "viewport"),
                "within": str(within or ""),
                "limit": str(max(1, min(1000, int(limit)))),
            },
        )
        data = result.get("data") or {}
        response = data.get("response") or {}
        return response if isinstance(response, dict) else {}

    def inspect_point(self, x: int, y: int) -> dict:
        result = self._run_with_params(
            "inspect_point",
            {"x": str(int(x)), "y": str(int(y))},
        )
        data = result.get("data") or {}
        response = data.get("response") or {}
        return response if isinstance(response, dict) else {}

    def run(self, action: str, *, request_id: str = "") -> dict:
        request_id = str(request_id or self._new_request_id())
        payload: dict[str, object] = {
            "action": str(action or ""),
            "timeout": max(1, int(self.timeout + 0.999)),
            "params": {},
            "request_id": request_id,
        }
        if self.client_id:
            payload["client_id"] = self.client_id
        lease = self._lease_metadata()
        if lease:
            payload["lease"] = lease
        try:
            response = self._post_json("/api/run", payload, timeout=self.timeout + 2)
        except BridgeCommandError:
            raise
        except (ConnectionError, RuntimeError) as exc:
            self._raise_transport_outcome(action, request_id, exc)
        return self._require_result(response)

    @staticmethod
    def _bool_text(value: bool) -> str:
        return "true" if value else "false"

    @staticmethod
    def _locator_params(
        selector: str,
        *,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict[str, str]:
        return {
            "selector": str(selector or ""),
            "frameId": str(max(0, int(frame_id))),
            "shadowPath": json.dumps(shadow_path or [], ensure_ascii=False),
        }

    def input_selector(
        self,
        selector: str,
        text: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params["text"] = text
        return self._post_run_with_params("input", params, timeout=timeout)

    def upload_file(
        self,
        selector: str,
        file_paths,
        *,
        multiple: bool = False,
        timeout: float | None = None,
    ) -> dict:
        if isinstance(file_paths, (str, Path)):
            paths = [str(file_paths)]
        else:
            paths = [str(path) for path in file_paths]
        return self._post_run_with_params(
            "upload_file",
            {
                "selector": str(selector or ""),
                "filePaths": paths,
                "multiple": bool(multiple or len(paths) > 1),
            },
            timeout=timeout,
        )

    def type_text(
        self,
        selector: str,
        text: str,
        *,
        delay_ms: int = 40,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params.update({"text": str(text), "delayMs": max(0, int(delay_ms))})
        command_timeout = max(self.timeout, (len(str(text)) * max(0, delay_ms) / 1000) + 3)
        return self._post_run_with_params("type_text", params, timeout=command_timeout)

    def clear_selector(
        self,
        selector: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "clear",
            self._locator_params(selector, frame_id=frame_id, shadow_path=shadow_path),
            timeout=timeout,
        )

    def focus_selector(
        self,
        selector: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "focus",
            self._locator_params(selector, frame_id=frame_id, shadow_path=shadow_path),
            timeout=timeout,
        )

    def check_selector(
        self,
        selector: str,
        *,
        checked: bool = True,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(selector, frame_id=frame_id, shadow_path=shadow_path)
        params["checked"] = self._bool_text(checked)
        return self._run_with_params("check", params)

    def drag_and_drop(
        self,
        source_selector: str,
        target_selector: str,
        *,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
        source_shadow_path: list[str] | None = None,
        target_shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "drag_and_drop",
            {
                "sourceSelector": str(source_selector or ""),
                "targetSelector": str(target_selector or ""),
                "frameId": str(max(0, int(frame_id))),
                "shadowPath": json.dumps(shadow_path or [], ensure_ascii=False),
                "sourceShadowPath": json.dumps(source_shadow_path or [], ensure_ascii=False),
                "targetShadowPath": json.dumps(target_shadow_path or [], ensure_ascii=False),
            },
        )

    def click_selector(
        self,
        selector: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "click",
            self._locator_params(
                selector,
                frame_id=frame_id,
                shadow_path=shadow_path,
            ),
            timeout=timeout,
        )

    def click_ref(
        self,
        ref: str,
        snapshot_id: str,
        *,
        timeout: float | None = None,
    ) -> dict:
        return self._run_with_params(
            "click_ref",
            {
                "ref": str(ref or ""),
                "snapshot_id": str(snapshot_id or ""),
            },
            timeout=timeout,
        )

    def hover_selector(
        self,
        selector: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "hover",
            self._locator_params(
                selector,
                frame_id=frame_id,
                shadow_path=shadow_path,
            ),
            timeout=timeout,
        )

    def hover_text(
        self,
        text: str,
        selector: str = "",
        exact: bool = True,
        *,
        timeout: float | None = None,
    ) -> dict:
        return self._run_with_params(
            "hover_text",
            {"text": text, "selector": selector, "exact": self._bool_text(exact)},
            timeout=timeout,
        )

    def click_text(
        self,
        text: str,
        selector: str = "",
        exact: bool = True,
        *,
        timeout: float | None = None,
    ) -> dict:
        return self._run_with_params(
            "click_text",
            {"text": text, "selector": selector, "exact": self._bool_text(exact)},
            timeout=timeout,
        )

    def highlight_selector(
        self,
        selector: str,
        duration: int = 1600,
        *,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params["duration"] = str(max(0, int(duration)))
        return self._run_with_params("highlight", params)

    def highlight_ref(self, ref: str, snapshot_id: str, duration: int = 1600) -> dict:
        return self._run_with_params(
            "highlight_ref",
            {
                "ref": str(ref or ""),
                "snapshot_id": str(snapshot_id or ""),
                "duration": str(max(0, int(duration))),
            },
        )

    def screenshot(self) -> dict:
        result = self._run_with_params("screenshot", {})
        data = result.get("data") or {}
        response = data.get("response") or {}
        return response if isinstance(response, dict) else {}

    def wait_selector(
        self,
        selector: str,
        *,
        state: str = "visible",
        timeout_ms: int = 10000,
        poll_ms: int = 100,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params.update(
            {
                "state": str(state or "visible"),
                "timeoutMs": str(max(0, int(timeout_ms))),
                "pollMs": str(max(20, int(poll_ms))),
            }
        )
        command_timeout = max(self.timeout, (max(0, int(timeout_ms)) / 1000) + 1)
        return self._run_with_params(
            "wait_selector",
            params,
            timeout=command_timeout,
        )

    def scroll(
        self,
        *,
        selector: str = "",
        x: int = 0,
        y: int = 0,
        behavior: str = "auto",
        block: str = "center",
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params.update(
            {
                "x": str(int(x)),
                "y": str(int(y)),
                "behavior": str(behavior or "auto"),
                "block": str(block or "center"),
            }
        )
        return self._run_with_params("scroll", params)

    def press_key(
        self,
        key: str,
        *,
        selector: str = "",
        code: str = "",
        ctrl: bool = False,
        alt: bool = False,
        shift: bool = False,
        meta: bool = False,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params.update(
            {
                "key": str(key or ""),
                "code": str(code or ""),
                "ctrl": self._bool_text(ctrl),
                "alt": self._bool_text(alt),
                "shift": self._bool_text(shift),
                "meta": self._bool_text(meta),
            }
        )
        return self._run_with_params("press_key", params)

    def select_option(
        self,
        selector: str,
        *,
        value: str = "",
        label: str = "",
        index: int = -1,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        params = self._locator_params(
            selector,
            frame_id=frame_id,
            shadow_path=shadow_path,
        )
        params.update(
            {
                "value": str(value or ""),
                "label": str(label or ""),
                "index": str(int(index)),
            }
        )
        return self._run_with_params("select", params)

    def double_click_selector(
        self,
        selector: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "dblclick",
            self._locator_params(
                selector,
                frame_id=frame_id,
                shadow_path=shadow_path,
            ),
            timeout=timeout,
        )

    def context_menu_selector(
        self,
        selector: str,
        *,
        timeout: float | None = None,
        frame_id: int = 0,
        shadow_path: list[str] | None = None,
    ) -> dict:
        return self._run_with_params(
            "contextmenu",
            self._locator_params(
                selector,
                frame_id=frame_id,
                shadow_path=shadow_path,
            ),
            timeout=timeout,
        )

    def _run_with_params(
        self,
        action: str,
        params: dict[str, str],
        *,
        timeout: float | None = None,
        request_id: str = "",
    ) -> dict:
        command_timeout = float(timeout if timeout is not None else self.timeout)
        request_id = str(request_id or self._new_request_id())
        payload: dict[str, object] = {
            "action": str(action or ""),
            "timeout": max(1, int(command_timeout + 0.999)),
            "params": dict(params),
            "request_id": request_id,
        }
        lease = self._lease_metadata()
        if lease:
            payload["lease"] = lease
        if self.client_id:
            payload["client_id"] = self.client_id
        try:
            response = self._post_json("/api/run", payload, timeout=command_timeout + 2)
        except BridgeCommandError:
            raise
        except (ConnectionError, RuntimeError) as exc:
            self._raise_transport_outcome(action, request_id, exc)
        return self._require_result(response)

    def _post_run_with_params(
        self,
        action: str,
        params: dict[str, object],
        *,
        timeout: float | None = None,
        request_id: str = "",
    ) -> dict:
        command_timeout = float(timeout if timeout is not None else self.timeout)
        payload = {
            "action": str(action),
            "timeout": max(1, int(command_timeout + 0.999)),
            "params": params,
            "request_id": str(request_id or self._new_request_id()),
        }
        lease = self._lease_metadata()
        if lease:
            payload["lease"] = lease
        if self.client_id:
            payload["client_id"] = self.client_id
        try:
            response = self._post_json("/api/run", payload, timeout=command_timeout + 2)
        except BridgeCommandError:
            raise
        except (ConnectionError, RuntimeError) as exc:
            self._raise_transport_outcome(action, str(payload["request_id"]), exc)
        return self._require_result(response)

    @staticmethod
    def _require_result(payload: dict) -> dict:
        result = payload.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"Chrome 插件桥返回结果格式异常: {payload}")
        if not result.get("ok"):
            error = str(result.get("error") or "Chrome 插件桥命令执行失败")
            code = error.split(":", 1)[0].strip()
            if not code or " " in code:
                code = "bridge_command_failed"
            raise BridgeCommandError(
                code,
                error,
                payload=result,
                outcome=str(payload.get("outcome") or "failed"),
            )
        result.setdefault("outcome", str(payload.get("outcome") or "ok"))
        result.setdefault("request_id", str(payload.get("request_id") or ""))
        result.setdefault("cached", bool(payload.get("cached", False)))
        result.setdefault("deduped", bool(payload.get("deduped", False)))
        return result

    @staticmethod
    def _is_mutating_action(action: str) -> bool:
        from .runtime_paths import PROTOCOL_PATH

        protocol_path = PROTOCOL_PATH
        try:
            payload = json.loads(protocol_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return str(action or "") in set(payload.get("mutating_actions") or [])

    def _lease_metadata(self) -> dict:
        provider = self.lease_provider
        if not callable(provider):
            return {}
        metadata = provider() or {}
        if not isinstance(metadata, dict) or not metadata:
            return {}
        try:
            epoch = int(metadata.get("epoch") or 0)
            tab_id = int(metadata.get("tab_id"))
        except (TypeError, ValueError):
            return {}
        normalized = {
            "resource": str(metadata.get("resource") or ""),
            "owner_id": str(metadata.get("owner_id") or ""),
            "epoch": epoch,
            "page_id": str(metadata.get("page_id") or ""),
            "client_id": str(metadata.get("client_id") or ""),
            "tab_id": tab_id,
        }
        if not all((normalized["resource"], normalized["owner_id"], epoch)):
            return {}
        if not normalized["page_id"] or not normalized["client_id"] or tab_id < 0:
            return {}
        for key in ("browser_session_id", "document_id"):
            value = str(metadata.get(key) or "")
            if value:
                normalized[key] = value
        return normalized

    def _lease_query_params(self) -> dict[str, str]:
        metadata = self._lease_metadata()
        if not metadata:
            return {}
        return {
            "lease_resource": metadata["resource"],
            "lease_owner_id": metadata["owner_id"],
            "lease_epoch": str(metadata["epoch"]),
        }

    @classmethod
    def _raise_transport_outcome(cls, action: str, request_id: str, exc: Exception) -> None:
        if cls._is_mutating_action(action):
            raise BridgeCommandError(
                "unknown_outcome",
                "bridge transport ended before the command result was received; inspect page state before retrying",
                payload={"request_id": str(request_id or "")},
                outcome="unknown_outcome",
            ) from exc
        raise exc

    @staticmethod
    def _error_from_payload(
        payload: dict,
        *,
        http_status: int | None = None,
    ) -> BridgeCommandError:
        message = str(payload.get("error") or "Chrome 插件桥请求失败")
        code = str(payload.get("error_code") or "").strip()
        if not code:
            normalized = message.lower()
            if "no result received" in normalized or "target client is not active" in normalized:
                code = "bridge_client_stale"
            elif "no active extension client" in normalized:
                code = "no_responsive_client"
            else:
                code = "bridge_request_failed"
        return BridgeCommandError(
            code,
            message,
            http_status=http_status,
            payload=payload,
            outcome=str(payload.get("outcome") or "failed"),
        )

    @staticmethod
    def _new_request_id() -> str:
        return "req_" + uuid.uuid4().hex

    def _post_json(self, path: str, payload: dict, timeout: float | None = None) -> dict:
        return self._post_json_impl(path, payload, timeout=timeout, authenticated=True)

    def _post_json_impl(
        self,
        path: str,
        payload: dict,
        *,
        timeout: float | None = None,
        authenticated: bool = True,
    ) -> dict:
        url = self._bridge_url(path)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if authenticated:
            headers["X-Chrome-Control-Token"] = bridge_token()
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers=headers,
        )
        try:
            with _NO_REDIRECT_OPENER.open(request, timeout=timeout or 3) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if 300 <= int(exc.code) < 400:
                raise BridgeCommandError(
                    "bridge_redirect_denied",
                    "Chrome bridge refused an unexpected redirect",
                    http_status=exc.code,
                ) from exc
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                error_payload = json.loads(raw)
            except json.JSONDecodeError:
                error_payload = {"error": raw}
            raise self._error_from_payload(
                error_payload if isinstance(error_payload, dict) else {"error": raw},
                http_status=exc.code,
            ) from exc
        except OSError as exc:
            raise ConnectionError(f"Chrome 插件桥服务未响应: {url}") from exc
        try:
            response_payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Chrome 插件桥返回内容不是 JSON") from exc
        if not isinstance(response_payload, dict):
            raise RuntimeError("Chrome 插件桥返回内容不是 JSON 对象")
        if response_payload.get("ok") is False:
            raise self._error_from_payload(response_payload)
        return response_payload

    def _get_json(self, path: str, timeout: float | None = None) -> dict:
        url = self._bridge_url(path)
        try:
            request = urllib.request.Request(
                url,
                headers={"X-Chrome-Control-Token": bridge_token()},
            )
            with _NO_REDIRECT_OPENER.open(request, timeout=timeout or 3) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if 300 <= int(exc.code) < 400:
                raise BridgeCommandError(
                    "bridge_redirect_denied",
                    "Chrome bridge refused an unexpected redirect",
                    http_status=exc.code,
                ) from exc
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                error_payload = json.loads(raw)
            except json.JSONDecodeError:
                error_payload = {"error": raw}
            raise self._error_from_payload(
                error_payload if isinstance(error_payload, dict) else {"error": raw},
                http_status=exc.code,
            ) from exc
        except OSError as exc:
            raise ConnectionError(f"Chrome 插件桥服务未响应: {url}") from exc
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Chrome 插件桥返回内容不是 JSON: {raw[:200]}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("Chrome 插件桥返回内容不是 JSON 对象")
        if payload.get("ok") is False:
            raise self._error_from_payload(payload)
        return payload

    def _bridge_url(self, path: str) -> str:
        """Build and validate a local API URL before attaching the token."""

        value = str(path or "")
        parsed = urllib.parse.urlsplit(value)
        if (
            not value.startswith("/")
            or value.startswith("//")
            or parsed.scheme
            or parsed.netloc
            or parsed.query
            or parsed.fragment
            or "\\" in value
        ):
            raise ValueError("Chrome bridge request path must be a local API path")
        url = self.base_url + value
        resolved = urllib.parse.urlsplit(url)
        if (
            resolved.scheme != "http"
            or resolved.hostname != "127.0.0.1"
            or resolved.port != self.port
        ):
            raise ValueError("Chrome bridge request origin is not local")
        return url

    @staticmethod
    def _normalized_url(value: str) -> str:
        parsed = urllib.parse.urlsplit(str(value or ""))
        if not parsed.scheme or not parsed.netloc:
            return ""
        return urllib.parse.urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or "/", "", ""))

    @staticmethod
    def _is_active_document(metadata: dict) -> bool:
        lifecycle = str(metadata.get("document_lifecycle") or "").strip().lower()
        return lifecycle in {"", "active"}

    def _is_bootstrap_url(self, value: str, nonce: str) -> bool:
        parsed = urllib.parse.urlsplit(str(value or ""))
        if parsed.scheme != "http" or parsed.netloc != f"127.0.0.1:{self.port}":
            return False
        if parsed.path != "/bridge-bootstrap":
            return False
        return urllib.parse.parse_qs(parsed.query).get("bridge_nonce", [""])[0] == nonce


def start_bridge_server(port: int = DEFAULT_BRIDGE_PORT) -> subprocess.Popen:
    """Start the local bridge server in a detached background process."""

    runtime_log_dir = log_dir()
    runtime_log_dir.mkdir(parents=True, exist_ok=True)
    stdout = open(runtime_log_dir / "bridge-server.out.log", "ab")
    stderr = open(runtime_log_dir / "bridge-server.err.log", "ab")
    command = [sys.executable, "-m", "chrome_control.server", "--serve", "--port", str(int(port))]
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": stdout,
        "stderr": stderr,
        "cwd": str(Path(__file__).resolve().parents[1]),
    }
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    else:
        kwargs["start_new_session"] = True
    try:
        process = subprocess.Popen(command, **kwargs)
    finally:
        stdout.close()
        stderr.close()
    return process


def start_bridge_server_in_process(port: int = DEFAULT_BRIDGE_PORT):
    """Start the bridge server inside the current Python process."""

    global _IN_PROCESS_SERVER
    if _IN_PROCESS_SERVER is not None:
        return _IN_PROCESS_SERVER

    from . import server as module

    _IN_PROCESS_SERVER = module.start_server(int(port))
    return _IN_PROCESS_SERVER


def _wait_for_bridge_server(
    client: ChromeBridgeClient,
    *,
    timeout: float,
    details: list[str],
    process=None,
) -> bool:
    deadline = time.monotonic() + max(0.1, float(timeout))
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            details.append(f"bridge_exit_code={process.returncode}")
            return False
        try:
            status = client.status()
            if not _server_status_compatible(status):
                details.append("bridge_state=incompatible_running_server")
                return False
            return True
        except Exception:
            time.sleep(0.2)
    return False


def _server_status_compatible(status: dict) -> bool:
    try:
        protocol = int(status.get("protocol_version") or 0)
    except (TypeError, ValueError):
        return False
    return bool(
        str(status.get("bridge_server_version") or "")
        == STANDALONE_BROWSER_CONTROL_VERSION
        and str(status.get("runtime_contract") or "")
        == BRIDGE_RUNTIME_CONTRACT
        and MIN_PROTOCOL_VERSION <= protocol <= MAX_PROTOCOL_VERSION
    )


def ensure_bridge_server(
    port: int = DEFAULT_BRIDGE_PORT,
    timeout: float = 5,
    *,
    persistent: bool = False,
) -> tuple[bool, list[str]]:
    details: list[str] = [f"bridge_port={int(port)}"]
    client = ChromeBridgeClient(port)
    try:
        status = client.status()
        if not _server_status_compatible(status):
            details.append("bridge_state=incompatible_running_server")
            details.append("bridge_restart_required=true")
            return False, details
        details.append("bridge_state=already_running")
        details.append("bridge_server_reused=true")
        return True, details
    except Exception as exc:
        details.append(f"initial_probe={exc}")

    if persistent:
        try:
            with process_lock(
                f"chrome_bridge_server_{int(port)}",
                timeout=max(5.0, float(timeout)),
            ):
                try:
                    status = client.status()
                    if not _server_status_compatible(status):
                        details.append("bridge_state=incompatible_running_server")
                        details.append("bridge_restart_required=true")
                        return False, details
                except Exception:
                    process = start_bridge_server(port)
                    details.append(f"bridge_pid={process.pid}")
                    details.append("bridge_state=process_starting")
                    if not _wait_for_bridge_server(
                        client,
                        timeout=timeout,
                        details=details,
                        process=process,
                    ):
                        details.append("bridge_state=not_ready")
                        return False, details
                    details.append("bridge_state=started")
                    details.append("bridge_server_started=true")
                    return True, details
                details.append("bridge_state=already_running_after_lock")
                details.append("bridge_server_reused=true")
                return True, details
        except TimeoutError as exc:
            details.append(f"bridge_start_lock_timeout={exc}")
            if _wait_for_bridge_server(
                client,
                timeout=timeout,
                details=details,
            ):
                details.append("bridge_state=already_running_after_wait")
                details.append("bridge_server_reused=true")
                return True, details
            details.append("bridge_state=start_in_progress_timeout")
            return False, details

    try:
        start_bridge_server_in_process(port)
        details.append("bridge_state=in_process_starting")
    except Exception as exc:
        details.append(f"in_process_start_failed={exc}")
        process = start_bridge_server(port)
        details.append(f"bridge_pid={process.pid}")
    else:
        process = None

    if _wait_for_bridge_server(
        client,
        timeout=timeout,
        details=details,
        process=process,
    ):
        details.append("bridge_state=started")
        details.append("bridge_server_started=true")
        return True, details
    details.append("bridge_state=not_ready")
    return False, details
