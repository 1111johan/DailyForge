"""Minimal browser controller contract shared by CLI and future page objects.

Threading contract: controller instances are not thread-safe. Create, connect,
use, and disconnect each controller from the same thread. For concurrent work,
create one controller per worker thread.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
import time
from typing import Any


SnapshotResult = dict[str, Any]


class BrowserControlError(Exception):
    """Base class for browser-control failures."""


class ConnectFailed(BrowserControlError):
    """Browser or bridge connection failed."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "connect_failed",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = str(code or "connect_failed")
        self.details = dict(details or {})


class ElementNotFound(BrowserControlError):
    """Element lookup failed."""


class WaitTimeout(BrowserControlError):
    """A wait condition timed out."""


class StaleElementRef(BrowserControlError):
    """Snapshot ref no longer belongs to the active page state."""


class PageRefreshed(BrowserControlError):
    """The page navigated or refreshed while an operation was running."""


class ArtifactExists(BrowserControlError):
    """A local evidence artifact would overwrite an existing file."""

    code = "artifact_exists"


class UnsupportedCapability(BrowserControlError):
    """Current backend does not support an option or operation."""


# Backward-compatible import used by existing modules and tests.
CapabilityNotSupported = UnsupportedCapability


class TaskStopped(BrowserControlError):
    """External stop event was triggered."""


def completed_download_result(
    *,
    file_name: str,
    file_size: int,
    path: str,
) -> dict[str, Any]:
    """Return the backend-independent successful download contract."""

    return {
        "ok": True,
        "status": "complete",
        "fileName": str(file_name or ""),
        "fileSize": max(0, int(file_size or 0)),
        "path": str(path or ""),
    }


class BrowserController(ABC):
    """Small synchronous browser control surface.

    Browser bridge clients are synchronous; subclasses must keep all browser
    work on the thread that created and connected the controller.
    """

    def __init__(
        self,
        *,
        provider: str,
        port: int,
        stop_event=None,
        evidence: bool = False,
        browser_session_id: str = "",
        owned: bool = False,
        owner_token: str = "",
        owned_window_ids: tuple[str | int, ...] = (),
        owned_process_id: int | None = None,
    ) -> None:
        self.provider = str(provider)
        self.port = int(port)
        self.stop_event = stop_event
        self.evidence = bool(evidence)
        self.browser_session_id = str(browser_session_id or "")
        self.owned = bool(owned)
        self.owner_token = str(owner_token or "")
        self.owned_window_ids = {
            str(value) for value in owned_window_ids if str(value or "")
        }
        self.owned_process_id = (
            int(owned_process_id) if owned_process_id not in (None, "") else None
        )
        self.current_page_id = ""
        self._active_page_lease_guard = None

    def capabilities(self) -> dict[str, Any]:
        """Describe the backend contract without silently degrading operations."""

        return {
            "provider": self.provider,
            "browser_session_id": self.browser_session_id,
            "operations": {},
            "limitations": [],
        }

    def persist_ownership(self) -> None:
        """Persist safe-close ownership across short-lived CLI invocations."""

        from .session_registry import new_owner_token, save_session

        if not self.owner_token:
            self.owner_token = new_owner_token()
        save_session(
            provider=self.provider,
            port=self.port,
            browser_session_id=self.browser_session_id,
            owned=self.owned,
            owner_token=self.owner_token,
            process_id=self.owned_process_id,
            window_ids=self.owned_window_ids,
        )

    def remove_ownership(self) -> None:
        from .session_registry import remove_session

        remove_session(self.provider, self.port)

    def page_lease(
        self,
        *,
        mode: str,
        page_id: str = "",
        owner_id: str = "",
        ttl_seconds: float = 30,
        takeover: bool = False,
        registry=None,
    ):
        """Create a renewable cross-process lease for one automation page."""

        from .leases import PageLeaseGuard, PageLeaseRegistry, new_lease_owner

        target = str(page_id or self.current_page_id or self.browser_session_id or "session")
        resource = f"{self.provider}:{self.port}:{target}"
        guard = PageLeaseGuard(
            registry or PageLeaseRegistry(),
            resource,
            str(owner_id or new_lease_owner()),
            mode=mode,
            ttl_seconds=ttl_seconds,
            takeover=takeover,
        )
        guard.on_acquired = lambda active: setattr(self, "_active_page_lease_guard", active)
        guard.on_released = lambda active: (
            setattr(self, "_active_page_lease_guard", None)
            if self._active_page_lease_guard is active else None
        )
        return guard

    def page_lease_metadata(self) -> dict[str, Any]:
        guard = self._active_page_lease_guard
        return guard.fencing_metadata() if guard is not None else {}

    def check_stopped(self) -> None:
        if self.stop_event is not None and self.stop_event.is_set():
            raise TaskStopped("browser task stopped")

    def ensure_no_locator_options(self, loc: dict[str, Any], *, supported: tuple[str, ...]) -> None:
        unsupported = [
            key for key, value in loc.items()
            if value not in (None, "", [], 0, False) and key not in supported
        ]
        if unsupported:
            raise UnsupportedCapability(
                f"{self.provider} backend does not support locator option(s): {', '.join(sorted(unsupported))}"
            )

    def evidence_path(self, action: str) -> Path:
        from datetime import datetime

        from .runtime_paths import evidence_dir

        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        return evidence_dir() / f"{stamp}_{action}.png"

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def disconnect(self) -> None: ...

    @abstractmethod
    def state(self) -> dict: ...

    def list_pages(self) -> list[dict]:
        raise UnsupportedCapability(
            f"{self.provider} backend does not support page listing"
        )

    def get_page(self, page_id: str) -> dict:
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
        raise UnsupportedCapability(
            f"{self.provider} backend does not support opening pages"
        )

    def switch_page(self, page_id: str, *, timeout: float = 10) -> dict:
        raise UnsupportedCapability(
            f"{self.provider} backend does not support switching pages"
        )

    def close_page(self, page_id: str) -> dict:
        raise UnsupportedCapability(
            f"{self.provider} backend does not support closing pages"
        )

    def list_windows(self) -> list[dict]:
        """Group pages by their backend window identifier."""

        windows: dict[str, dict[str, Any]] = {}
        for page in self.list_pages():
            window_id = str(page.get("window_id") or "")
            row = windows.setdefault(
                window_id,
                {
                    "browser_session_id": str(
                        page.get("browser_session_id")
                        or self.browser_session_id
                        or ""
                    ),
                    "window_id": window_id,
                    "active": False,
                    "owned": window_id in self.owned_window_ids,
                    "pages": [],
                },
            )
            row["pages"].append(page)
            row["active"] = bool(row["active"] or page.get("active"))
        return list(windows.values())

    def open_window(self, url: str, *, timeout: float = 20) -> dict:
        return self.open_page(url, open_mode="new_window", timeout=timeout)

    def switch_window(self, window_id: str, *, timeout: float = 10) -> dict:
        for window in self.list_windows():
            if str(window.get("window_id") or "") != str(window_id or ""):
                continue
            pages = window.get("pages") or []
            target = next((page for page in pages if page.get("active")), None)
            target = target or (pages[0] if pages else None)
            if target is None:
                break
            return self.switch_page(str(target.get("page_id") or ""), timeout=timeout)
        raise BrowserControlError(f"window_not_found: {window_id}")

    def close_window(
        self,
        window_id: str,
        *,
        confirmation: str = "",
        allow_user_window: bool = False,
    ) -> dict:
        raise UnsupportedCapability(
            f"{self.provider} backend does not support closing windows"
        )

    def close_browser(
        self,
        *,
        confirmation: str = "",
        allow_user_browser: bool = False,
    ) -> dict:
        raise UnsupportedCapability(
            f"{self.provider} backend does not support closing browser sessions"
        )

    @abstractmethod
    def goto(self, url: str, *, wait_until: str = "load", timeout: float = 30) -> None: ...

    @abstractmethod
    def wait_for(self, selector: str, *, state: str = "visible", timeout: float = 10, **loc) -> None: ...

    @abstractmethod
    def click(self, selector: str, *, timeout: float = 10, **loc) -> None: ...

    def click_text(
        self,
        text: str,
        *,
        selector: str = "",
        exact: bool = True,
        timeout: float = 10,
    ) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support text clicks")

    @abstractmethod
    def fill(self, selector: str, text: str, *, timeout: float = 10, **loc) -> None: ...

    @abstractmethod
    def highlight(self, selector: str, *, duration_ms: int = 1600, **loc) -> None: ...

    @abstractmethod
    def screenshot(self, path: str = "", *, full_page: bool = False) -> str: ...

    def set_download_directory(self, path: str) -> str:
        raise UnsupportedCapability(f"{self.provider} backend does not support download directory")

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
        raise UnsupportedCapability(f"{self.provider} backend does not support element find")

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
        raise UnsupportedCapability(f"{self.provider} backend does not support element extraction")

    def inspect_point(self, x: int, y: int) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support point inspection")

    def scan_top_elements(self, max_top: int = 900, limit: int = 80) -> list[dict]:
        raise UnsupportedCapability(f"{self.provider} backend does not support element scan")

    def hover(self, selector: str, *, timeout: float = 10, **loc) -> None:
        raise UnsupportedCapability(f"{self.provider} backend does not support hover")

    def trusted_click(self, selector: str, *, timeout_ms: int = 5000, expected_url_prefix: str = "", **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support trusted click")

    def trusted_click_and_wait_download(
        self,
        selector: str,
        *,
        timeout: float = 60,
        poll_interval: float = 0.25,
        progress_callback=None,
        **loc,
    ) -> dict:
        raise UnsupportedCapability(
            f"{self.provider} backend does not support trusted click download monitoring"
        )

    def upload_file(
        self,
        selector: str,
        file_paths,
        *,
        multiple: bool = False,
        timeout_ms: int = 10000,
        **loc,
    ) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support file upload")

    def reload(self, *, timeout: float = 30) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support reload")

    def go_back(self, *, timeout: float = 30) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support back navigation")

    def go_forward(self, *, timeout: float = 30) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support forward navigation")

    def type_text(self, selector: str, text: str, *, delay_ms: int = 40, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support typing")

    def clear(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support clearing inputs")

    def focus(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support focus")

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
        raise UnsupportedCapability(f"{self.provider} backend does not support keyboard input")

    def check(self, selector: str, *, checked: bool = True, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support check controls")

    def select_option(
        self,
        selector: str,
        *,
        value: str = "",
        label: str = "",
        index: int = -1,
        **loc,
    ) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support select controls")

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
        raise UnsupportedCapability(f"{self.provider} backend does not support scrolling")

    def double_click(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support double click")

    def context_menu(self, selector: str, *, timeout: float = 10, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support context menu")

    def drag_and_drop(self, source: str, target: str, **loc) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support drag and drop")

    def dialog_state(self) -> dict:
        raise UnsupportedCapability(f"{self.provider} backend does not support dialog inspection")

    def handle_dialog(
        self,
        *,
        accept: bool,
        prompt_text: str = "",
        confirmation: str = "",
    ) -> dict:
        if accept and not str(confirmation or "").strip():
            raise BrowserControlError("dialog_accept_requires_confirmation")
        raise UnsupportedCapability(f"{self.provider} backend does not support dialogs")

    def get_value(self, selector: str, **loc) -> str:
        raise UnsupportedCapability(f"{self.provider} backend does not support reading values")

    def wait_for_state(
        self,
        *,
        url_contains: str = "",
        title_contains: str = "",
        selector: str = "",
        selector_state: str = "visible",
        value: str | None = None,
        timeout: float = 10,
        poll_interval: float = 0.1,
        **loc,
    ) -> dict:
        """Wait for observable state without an unbounded fixed sleep."""

        if value is not None:
            raise UnsupportedCapability(
                "value-based waits are disabled because input values are sensitive"
            )

        deadline = time.monotonic() + max(0.0, float(timeout))
        last_state: dict[str, Any] = {}
        last_error = ""
        while True:
            self.check_stopped()
            try:
                last_state = self.state()
                matched = True
                if url_contains:
                    matched = matched and url_contains in str(last_state.get("url") or "")
                if title_contains:
                    matched = matched and title_contains in str(last_state.get("title") or "")
                if selector:
                    try:
                        self.wait_for(
                            selector,
                            state=selector_state,
                            timeout=min(0.25, max(0.05, deadline - time.monotonic())),
                            **loc,
                        )
                    except (WaitTimeout, ElementNotFound):
                        matched = False
                if matched:
                    return {
                        "matched": True,
                        "state": last_state,
                        "conditions": {
                            "url_contains": url_contains,
                            "title_contains": title_contains,
                            "selector": selector,
                            "selector_state": selector_state,
                            "value": value,
                        },
                    }
            except PageRefreshed as exc:
                last_error = str(exc)
            if time.monotonic() >= deadline:
                raise WaitTimeout(
                    f"state_wait_timeout: state={last_state!r}; error={last_error}"
                )
            wait_seconds = min(max(0.02, float(poll_interval)), 0.5)
            if self.stop_event is not None:
                self.stop_event.wait(wait_seconds)
            else:
                time.sleep(wait_seconds)

    @abstractmethod
    def snapshot(self, *, scope: str = "viewport", within: str = "", limit: int = 120) -> SnapshotResult: ...

    @abstractmethod
    def click_ref(self, ref: str, snapshot_id: str, *, timeout: float = 10) -> None: ...

    @abstractmethod
    def highlight_ref(self, ref: str, snapshot_id: str, *, duration_ms: int = 1600) -> None: ...

    @abstractmethod
    def run_js(self, script: str, *args): ...
