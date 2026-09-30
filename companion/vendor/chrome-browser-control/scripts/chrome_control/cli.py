"""Small JSON CLI for the standalone Chrome extension bridge."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from .base import (
    BrowserControlError,
    CapabilityNotSupported,
    ConnectFailed,
    PageRefreshed,
    StaleElementRef,
    WaitTimeout,
)
from .client import DEFAULT_BRIDGE_PORT
from .doctor import run_browser_doctor
from .factory import connect_controller
from .runtime_paths import evidence_dir


class CliError(RuntimeError):
    def __init__(self, message: str, exit_code: int = 1, *, details=None):
        super().__init__(message)
        self.exit_code = int(exit_code)
        self.details = details


READ_ONLY_COMMANDS = {
    "doctor",
    "state",
    "capabilities",
    "pages",
    "windows",
    "snapshot",
    "find",
    "extract",
    "inspect-point",
    "screenshot",
    "wait",
}

REDACTED_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "bridge_token",
    "cookie",
    "cookies",
    "password",
    "secret",
    "set_cookie",
    "value",
}
OMITTED_KEYS = {"html", "file_paths", "filepaths", "upload_paths", "uploadpaths"}
SAFE_EXTRACT_FIELDS = {
    "visibleText", "href", "title", "ariaLabel", "role", "tag", "name"
}


def public_url(value: str) -> str:
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    host = parsed.hostname
    display_host = f"[{host}]" if ":" in host else host
    try:
        port = f":{parsed.port}" if parsed.port else ""
    except ValueError:
        port = ""
    return urlunsplit(
        (parsed.scheme.lower(), f"{display_host}{port}", parsed.path or "/", "", "")
    )


def sanitize_output(value, key: str = ""):
    """Redact bridge credentials and sensitive fields in machine output."""

    normalized = str(key or "").lower().replace("-", "_")
    compact = normalized.replace("_", "")
    if (
        normalized in REDACTED_KEYS
        or normalized.endswith("_token")
        or compact.endswith("token")
        or compact.startswith(("password", "cookie", "authorization", "secret"))
    ):
        return "[REDACTED]"
    if normalized in OMITTED_KEYS:
        return "[OMITTED]"
    if isinstance(value, dict):
        return {
            str(item_key): sanitize_output(item_value, str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [sanitize_output(item, normalized) for item in value]
    if isinstance(value, str) and (
        normalized in {"href", "taburl", "url", "source_url"}
        or normalized.endswith("_url")
    ):
        return public_url(value)
    return value


def emit(payload, *, exit_code: int | None = None) -> int:
    output = payload if isinstance(payload, dict) else {"result": payload}
    print(json.dumps(sanitize_output(output), ensure_ascii=False, indent=2, default=str))
    return int(exit_code if exit_code is not None else (0 if output.get("ok", True) else 1))


def safe_page(page: dict) -> dict:
    return sanitize_output({
        "browser_session_id": str(page.get("browser_session_id") or ""),
        "window_id": page.get("window_id"),
        "page_id": str(page.get("page_id") or ""),
        "tab_id": page.get("tab_id"),
        "client_id": str(page.get("client_id") or ""),
        "url": str(page.get("url") or ""),
        "title": str(page.get("title") or ""),
        "ready_state": str(page.get("ready_state") or page.get("readyState") or ""),
        "active": bool(page.get("active")),
        "controllable": bool(page.get("controllable", True)),
        "owned": bool(page.get("owned", False)),
    })


def safe_state(controller) -> dict:
    try:
        return safe_page(controller.state())
    except Exception as exc:
        return {"unavailable": True, "error": type(exc).__name__}


def default_screenshot_path() -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    configured = os.environ.get("CHROME_BROWSER_CONTROL_EVIDENCE_DIR", "").strip()
    root = Path(configured).expanduser() if configured else evidence_dir()
    return root / f"screenshot_{stamp}.png"


def parse_attrs(values: list[str]) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for item in values:
        name, separator, value = str(item or "").partition("=")
        if not separator or not name.strip():
            raise CliError("--attr must use NAME=VALUE", 2)
        attrs[name.strip()] = value
    return attrs


def validate_url(value: str) -> str:
    parsed = urlsplit(str(value or "").strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise CliError("target URL must be a valid http/https URL", 2)
    return str(value).strip()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="chrome-browser-control",
        description="Control ordinary Google Chrome through the local extension bridge.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_BRIDGE_PORT)
    parser.add_argument("--client-id", default="")
    parser.add_argument("--page-id", default="", help="Pin the command to a stable page ID.")
    parser.add_argument(
        "--lease-owner",
        default=os.environ.get("CHROME_BROWSER_CONTROL_LEASE_OWNER", ""),
    )
    parser.add_argument("--lease-ttl", type=float, default=30)
    parser.add_argument("--takeover-lease", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor")
    sub.add_parser("state")
    sub.add_parser("capabilities")
    sub.add_parser("pages")
    sub.add_parser("windows")

    open_cmd = sub.add_parser("open")
    open_cmd.add_argument("url")
    open_cmd.add_argument("--mode", choices=["new_tab", "current_tab", "new_window"], default="new_tab")
    open_cmd.add_argument("--timeout", type=float, default=20)

    switch = sub.add_parser("switch")
    switch.add_argument("page_id")
    switch.add_argument("--timeout", type=float, default=10)
    close = sub.add_parser("close")
    close.add_argument("page_id")
    close.add_argument(
        "--confirmation",
        required=True,
        help="Record the user's explicit approval to close this tab.",
    )
    switch_window = sub.add_parser("switch-window")
    switch_window.add_argument("window_id", type=int)
    switch_window.add_argument("--timeout", type=float, default=10)
    close_window = sub.add_parser("close-window")
    close_window.add_argument("window_id", type=int)
    close_window.add_argument(
        "--confirmation",
        required=True,
        help="Record the user's explicit approval to close this Chrome window.",
    )

    for name in ("reload", "back", "forward"):
        command = sub.add_parser(name)
        command.add_argument("--timeout", type=float, default=30)

    goto = sub.add_parser("goto")
    goto.add_argument("url")
    goto.add_argument("--timeout", type=float, default=30)

    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--scope", choices=["viewport", "full"], default="viewport")
    snapshot.add_argument("--within", default="")
    snapshot.add_argument("--limit", type=int, default=120)

    find = sub.add_parser("find")
    find.add_argument("--text", default="")
    find.add_argument("--css", default="")
    find.add_argument("--exact", action="store_true")
    find.add_argument("--role", default="")
    find.add_argument("--tag", default="")
    find.add_argument("--attr", action="append", default=[])
    find.add_argument("--all-frames", action="store_true")
    find.add_argument("--no-shadow", action="store_true")
    find.add_argument("--limit", type=int, default=20)

    extract = sub.add_parser("extract")
    extract.add_argument("--css", required=True)
    extract.add_argument("--fields", default="visibleText,href,title,ariaLabel")
    extract.add_argument("--limit", type=int, default=100)
    extract.add_argument("--include-hidden", action="store_true")
    extract.add_argument("--all-frames", action="store_true")
    extract.add_argument("--no-shadow", action="store_true")

    inspect_point = sub.add_parser("inspect-point")
    inspect_point.add_argument("--x", type=int, required=True)
    inspect_point.add_argument("--y", type=int, required=True)

    click = sub.add_parser("click")
    click.add_argument("--css", default="")
    click.add_argument("--ref", default="")
    click.add_argument("--snapshot-id", default="")
    click.add_argument("--timeout", type=float, default=10)

    click_text = sub.add_parser("click-text")
    click_text.add_argument("--text", required=True)
    click_text.add_argument("--css", default="")
    click_text.add_argument("--contains", action="store_true")
    click_text.add_argument("--timeout", type=float, default=10)

    for name in ("clear", "focus", "hover", "double-click", "context-menu"):
        command = sub.add_parser(name)
        command.add_argument("--css", required=True)
        command.add_argument("--timeout", type=float, default=10)

    fill = sub.add_parser("fill")
    fill.add_argument("--css", required=True)
    fill.add_argument("--text", required=True)
    fill.add_argument("--timeout", type=float, default=10)

    type_cmd = sub.add_parser("type")
    type_cmd.add_argument("--css", required=True)
    type_cmd.add_argument("--text", required=True)
    type_cmd.add_argument("--delay-ms", type=int, default=40)

    upload = sub.add_parser("upload")
    upload.add_argument("--css", required=True)
    upload.add_argument("--file", action="append", required=True, dest="files")
    upload.add_argument("--timeout", type=float, default=30)

    check = sub.add_parser("check")
    check.add_argument("--css", required=True)
    check.add_argument("--unchecked", action="store_true")

    press = sub.add_parser("press")
    press.add_argument("key")
    press.add_argument("--css", default="")
    press.add_argument("--ctrl", action="store_true")
    press.add_argument("--alt", action="store_true")
    press.add_argument("--shift", action="store_true")
    press.add_argument("--meta", action="store_true")

    select = sub.add_parser("select")
    select.add_argument("--css", required=True)
    select.add_argument("--value", default="")
    select.add_argument("--label", default="")
    select.add_argument("--index", type=int, default=-1)

    drag = sub.add_parser("drag")
    drag.add_argument("--source", required=True)
    drag.add_argument("--target", required=True)

    hover = sub.add_parser("highlight")
    hover.add_argument("--css", default="")
    hover.add_argument("--ref", default="")
    hover.add_argument("--snapshot-id", default="")
    hover.add_argument("--duration", type=int, default=1600)

    wait = sub.add_parser("wait")
    wait.add_argument("--url-contains", default="")
    wait.add_argument("--title-contains", default="")
    wait.add_argument("--css", default="")
    wait.add_argument("--state", choices=["attached", "detached", "visible", "hidden"], default="visible")
    wait.add_argument("--timeout", type=float, default=10)

    scroll = sub.add_parser("scroll")
    scroll.add_argument("--css", default="")
    scroll.add_argument("--x", type=int, default=0)
    scroll.add_argument("--y", type=int, default=0)
    scroll.add_argument("--behavior", choices=["auto", "smooth"], default="auto")
    scroll.add_argument("--block", default="center")

    screenshot = sub.add_parser("screenshot")
    screenshot.add_argument("--out", default="")
    return parser


def action_result(controller, command: str, result, before: dict, started: float) -> int:
    return emit({
        "ok": True,
        "command": command,
        "elapsed_seconds": round(time.perf_counter() - started, 3),
        "result": result,
        "before": before,
        "after": safe_state(controller),
    })


def _pin_page(controller, args) -> None:
    if args.page_id and args.command not in {
        "pages", "windows", "switch", "close", "switch-window", "close-window"
    }:
        controller.switch_page(args.page_id, timeout=10)


def run(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    if args.command == "doctor":
        report = run_browser_doctor(port=args.port, client_id=args.client_id, recover=False)
        return emit({"ok": report.get("status") != "blocked", **report}, exit_code=0 if report.get("status") != "blocked" else 2)

    controller = connect_controller(
        port=args.port,
        client_id=args.client_id,
        persistent_bridge_server=True,
        fallback_to_latest=not bool(args.client_id),
    )
    lease_guard = None
    try:
        lease_guard = controller.page_lease(
            mode="read" if args.command in READ_ONLY_COMMANDS else "write",
            page_id=args.page_id,
            owner_id=args.lease_owner,
            ttl_seconds=args.lease_ttl,
            takeover=args.takeover_lease,
        )
        lease_guard.__enter__()
        _pin_page(controller, args)

        if args.command == "state":
            return emit({"ok": True, "command": "state", "state": controller.state()})
        if args.command == "capabilities":
            return emit(controller.capabilities())
        if args.command == "pages":
            return emit({"ok": True, "pages": [safe_page(row) for row in controller.list_pages()]})
        if args.command == "windows":
            rows = controller.list_windows()
            return emit({"ok": True, "windows": rows})
        if args.command == "open":
            before = safe_state(controller)
            result = controller.open_page(validate_url(args.url), open_mode=args.mode, timeout=args.timeout)
            return action_result(controller, args.command, result, before, started)
        if args.command == "switch":
            before = safe_state(controller)
            result = controller.switch_page(args.page_id, timeout=args.timeout)
            return action_result(controller, args.command, result, before, started)
        if args.command == "close":
            before = safe_state(controller)
            result = controller.close_page(args.page_id)
            return action_result(controller, args.command, result, before, started)
        if args.command == "switch-window":
            before = safe_state(controller)
            result = controller.switch_window(str(args.window_id), timeout=args.timeout)
            return action_result(controller, args.command, result, before, started)
        if args.command == "close-window":
            before = safe_state(controller)
            result = controller.close_window(
                str(args.window_id),
                confirmation=args.confirmation,
                allow_user_window=True,
            )
            return action_result(controller, args.command, result, before, started)
        if args.command == "goto":
            before = safe_state(controller)
            url = validate_url(args.url)
            controller.goto(url, timeout=args.timeout)
            return action_result(controller, args.command, {"url": public_url(url)}, before, started)
        if args.command in {"reload", "back", "forward"}:
            before = safe_state(controller)
            callback = {"reload": controller.reload, "back": controller.go_back, "forward": controller.go_forward}[args.command]
            return action_result(controller, args.command, callback(timeout=args.timeout), before, started)
        if args.command == "snapshot":
            return emit({"ok": True, "command": "snapshot", **controller.snapshot(scope=args.scope, within=args.within, limit=args.limit)})
        if args.command == "find":
            limit = max(1, min(1000, args.limit))
            if args.css:
                result = controller.extract_elements(args.css, fields=["visibleText", "href", "title", "ariaLabel"], limit=limit, all_frames=args.all_frames, include_shadow=not args.no_shadow)
                return emit({"ok": True, "command": "find", **result})
            if not any((args.text, args.role, args.tag, args.attr)):
                raise CliError("find requires --text, --role, --tag, --attr, or --css", 2)
            elements = controller.find_elements(
                text=args.text,
                exact=args.exact,
                role=args.role,
                tag=args.tag,
                attrs=parse_attrs(args.attr),
                limit=limit,
                all_frames=args.all_frames,
                include_shadow=not args.no_shadow,
            )
            return emit({"ok": True, "command": "find", "count": len(elements), "elements": elements})
        if args.command == "extract":
            fields = [item.strip() for item in args.fields.split(",") if item.strip()]
            unsupported_fields = sorted(set(fields) - SAFE_EXTRACT_FIELDS)
            if unsupported_fields:
                raise CliError(
                    "extract fields are limited to visibleText, href, title, ariaLabel, role, tag, and name",
                    2,
                    details={"unsupported_fields": unsupported_fields},
                )
            result = controller.extract_elements(args.css, fields=fields, limit=max(1, min(1000, args.limit)), include_hidden=args.include_hidden, all_frames=args.all_frames, include_shadow=not args.no_shadow)
            return emit({"ok": True, "command": "extract", **result})
        if args.command == "inspect-point":
            return emit({
                "ok": True,
                "command": "inspect-point",
                **controller.inspect_point(args.x, args.y),
            })
        if args.command == "click":
            before = safe_state(controller)
            if args.css:
                controller.click(args.css, timeout=args.timeout)
                result = {"clicked": True, "selector": args.css}
            elif args.ref and args.snapshot_id:
                controller.click_ref(args.ref, args.snapshot_id, timeout=args.timeout)
                result = {"clicked": True, "ref": args.ref}
            else:
                raise CliError("click requires --css, or both --ref and --snapshot-id", 2)
            return action_result(controller, args.command, result, before, started)
        if args.command == "click-text":
            before = safe_state(controller)
            result = controller.click_text(
                args.text,
                selector=args.css,
                exact=not args.contains,
                timeout=args.timeout,
            )
            return action_result(controller, args.command, result, before, started)
        if args.command == "fill":
            before = safe_state(controller)
            controller.fill(args.css, args.text, timeout=args.timeout)
            return action_result(controller, args.command, {"filled": True, "selector": args.css, "value_length": len(args.text)}, before, started)
        if args.command == "type":
            before = safe_state(controller)
            result = controller.type_text(args.css, args.text, delay_ms=args.delay_ms)
            return action_result(controller, args.command, result or {"typed": True, "value_length": len(args.text)}, before, started)
        if args.command == "upload":
            before = safe_state(controller)
            result = controller.upload_file(
                args.css,
                args.files,
                multiple=len(args.files) > 1,
                timeout_ms=max(1000, int(args.timeout * 1000)),
            )
            return action_result(controller, args.command, result, before, started)
        if args.command in {"clear", "focus", "hover", "double-click", "context-menu"}:
            before = safe_state(controller)
            callback = {
                "clear": controller.clear,
                "focus": controller.focus,
                "hover": controller.hover,
                "double-click": controller.double_click,
                "context-menu": controller.context_menu,
            }[args.command]
            result = callback(args.css, timeout=args.timeout)
            return action_result(controller, args.command, result or {"completed": True}, before, started)
        if args.command == "check":
            before = safe_state(controller)
            return action_result(controller, args.command, controller.check(args.css, checked=not args.unchecked), before, started)
        if args.command == "press":
            before = safe_state(controller)
            result = controller.press_key(args.key, selector=args.css, ctrl=args.ctrl, alt=args.alt, shift=args.shift, meta=args.meta)
            return action_result(controller, args.command, result, before, started)
        if args.command == "select":
            if not (args.value or args.label or args.index >= 0):
                raise CliError("select requires --value, --label, or --index", 2)
            before = safe_state(controller)
            result = controller.select_option(args.css, value=args.value, label=args.label, index=args.index)
            return action_result(controller, args.command, result, before, started)
        if args.command == "drag":
            before = safe_state(controller)
            return action_result(controller, args.command, controller.drag_and_drop(args.source, args.target), before, started)
        if args.command == "highlight":
            if args.css:
                controller.highlight(args.css, duration_ms=args.duration)
                return emit({"ok": True, "highlighted": True, "selector": args.css})
            if args.ref and args.snapshot_id:
                controller.highlight_ref(args.ref, args.snapshot_id, duration_ms=args.duration)
                return emit({"ok": True, "highlighted": True, "ref": args.ref})
            raise CliError("highlight requires --css, or both --ref and --snapshot-id", 2)
        if args.command == "wait":
            result = controller.wait_for_state(url_contains=args.url_contains, title_contains=args.title_contains, selector=args.css, selector_state=args.state, timeout=args.timeout)
            return emit({"ok": True, "command": "wait", **result})
        if args.command == "scroll":
            before = safe_state(controller)
            result = controller.scroll(selector=args.css, x=args.x, y=args.y, behavior=args.behavior, block=args.block)
            return action_result(controller, args.command, result, before, started)
        if args.command == "screenshot":
            out = Path(args.out).expanduser().resolve() if args.out else default_screenshot_path()
            path = controller.screenshot(str(out))
            return emit({"ok": True, "command": "screenshot", "path": path, "bytes": Path(path).stat().st_size})
        raise CliError(f"unknown command: {args.command}", 2)
    finally:
        if lease_guard is not None:
            lease_guard.__exit__(None, None, None)
        controller.disconnect()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except CliError as exc:
        return emit({"ok": False, "error_code": "cli_error", "error": str(exc), "details": exc.details}, exit_code=exc.exit_code)
    except StaleElementRef:
        return emit({"ok": False, "error_code": "stale_element_ref", "error": "ref is stale; run snapshot again"}, exit_code=1)
    except PageRefreshed:
        return emit({"ok": False, "error_code": "page_refreshed", "error": "page changed; run snapshot again"}, exit_code=1)
    except CapabilityNotSupported as exc:
        return emit({"ok": False, "error_code": "unsupported_capability", "error": str(exc)}, exit_code=1)
    except ConnectFailed as exc:
        return emit({"ok": False, "error_code": exc.code, "error": str(exc), "details": exc.details}, exit_code=2)
    except BrowserControlError as exc:
        return emit({
            "ok": False,
            "error_code": str(getattr(exc, "code", type(exc).__name__)),
            "error": str(exc),
        }, exit_code=2)
    except Exception as exc:
        return emit({"ok": False, "error_code": str(getattr(exc, "code", type(exc).__name__)), "error": str(exc)}, exit_code=1)


if __name__ == "__main__":
    raise SystemExit(main())
