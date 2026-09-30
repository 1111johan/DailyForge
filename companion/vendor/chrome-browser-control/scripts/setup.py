"""Prepare and pair the local Chrome bridge extension."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from chrome_control.client import DEFAULT_BRIDGE_PORT, ChromeBridgeClient, ensure_bridge_server  # noqa: E402
from chrome_control.doctor import run_browser_doctor  # noqa: E402
from chrome_control.runtime_paths import EXTENSION_DIR, data_dir  # noqa: E402
from chrome_control.upload_policy import add_upload_root  # noqa: E402


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    return code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare the local Chrome bridge and pair the unpacked extension."
    )
    parser.add_argument("--port", type=int, default=DEFAULT_BRIDGE_PORT)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare", help="Start/reuse the local bridge service.")
    doctor = sub.add_parser("doctor", help="Check bridge, extension, and pairing readiness.")
    extension_path = sub.add_parser("extension-path", help="Print the unpacked extension directory.")
    enroll = sub.add_parser("enroll", help="Open a one-use pairing page in Chrome.")
    rotate = sub.add_parser(
        "rotate-token",
        help="Atomically rotate the local token; existing extension pairings must re-enroll.",
    )
    upload_root = sub.add_parser(
        "allow-upload-root",
        help="Allow image uploads from one existing local directory.",
    )
    upload_root.add_argument("path")
    for command in (prepare, doctor, extension_path, enroll, rotate):
        # Accept both ``setup.py --port 16881 prepare`` and the more natural
        # ``setup.py prepare --port 16881`` without overriding a global value.
        command.add_argument("--port", type=int, default=argparse.SUPPRESS)
    enroll.add_argument("--no-open", action="store_true", help="Print the URL instead of opening it.")
    enroll.add_argument("--timeout", type=float, default=20)
    enroll.add_argument(
        "--chrome-path",
        default=os.environ.get("CHROME_BROWSER_CONTROL_CHROME", ""),
        help="Path to Google Chrome when it cannot be detected automatically.",
    )
    return parser


def find_chrome(explicit: str = "") -> Path | None:
    if str(explicit or "").strip():
        candidate = Path(explicit).expanduser()
        return candidate.resolve() if candidate.is_file() else None

    candidates: list[Path] = []
    if sys.platform.startswith("win"):
        for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            root = os.environ.get(variable, "").strip()
            if root:
                candidates.append(Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe")
    elif sys.platform == "darwin":
        candidates.extend([
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path.home() / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ])
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            resolved = shutil.which(name)
            if resolved:
                candidates.append(Path(resolved))
    return next((path.resolve() for path in candidates if path.is_file()), None)


def open_in_chrome(url: str, explicit: str = "") -> Path:
    executable = find_chrome(explicit)
    if executable is None:
        raise FileNotFoundError(
            "Google Chrome was not found; pass --chrome-path or set "
            "CHROME_BROWSER_CONTROL_CHROME"
        )
    subprocess.Popen(
        [str(executable), str(url)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return executable


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "extension-path":
        print(str(EXTENSION_DIR))
        return 0
    if args.command == "doctor":
        report = run_browser_doctor(port=args.port, start_server=True)
        return emit({"ok": report.get("status") != "blocked", **report}, 0 if report.get("status") != "blocked" else 2)
    if args.command == "allow-upload-root":
        try:
            root_count = add_upload_root(args.path)
        except (OSError, ValueError) as exc:
            return emit({
                "ok": False,
                "error_code": "upload_root_invalid",
                "error": str(exc),
            }, 2)
        return emit({
            "ok": True,
            "command": "allow-upload-root",
            "configured": True,
            "root_count": root_count,
        })

    try:
        ok, details = ensure_bridge_server(args.port, timeout=5, persistent=True)
    except Exception as exc:
        return emit({"ok": False, "error_code": type(exc).__name__, "error": str(exc)}, 2)
    if not ok:
        return emit({"ok": False, "error_code": "bridge_server_unavailable", "details": details}, 2)

    if args.command == "prepare":
        return emit({
            "ok": True,
            "command": "prepare",
            "port": args.port,
            "extension_path": str(EXTENSION_DIR),
            "runtime_dir": str(data_dir()),
            "details": details,
            "next": "Load the extension path as an unpacked extension, then run enroll.",
        })

    if args.command == "enroll":
        client = ChromeBridgeClient(args.port, timeout=max(3, args.timeout))
        try:
            url, nonce = client.bootstrap_url()
        except Exception as exc:
            return emit({"ok": False, "error_code": str(getattr(exc, "code", type(exc).__name__)), "error": str(exc)}, 2)
        if args.no_open:
            return emit({
                "ok": True,
                "command": "enroll",
                "bootstrap_url": url,
                "expires_in_seconds": 120,
                "note": "This URL contains a one-use pairing code; do not share it.",
            })
        try:
            chrome_path = open_in_chrome(url, args.chrome_path)
        except (OSError, ValueError) as exc:
            return emit({
                "ok": False,
                "error_code": "browser_open_failed",
                "error": str(exc),
            }, 2)
        try:
            registered = client.wait_for_bootstrap_client(nonce, timeout=args.timeout)
        except TimeoutError:
            return emit({
                "ok": False,
                "error_code": "pairing_timeout",
                "error": "Chrome did not register the extension page before timeout; refresh it and run enroll again.",
            }, 2)
        return emit({
            "ok": True,
            "command": "enroll",
            "paired": True,
            "chrome_path": str(chrome_path),
            "client_id": registered.get("client_id"),
            "tab_id": registered.get("tab_id"),
            "expires_in_seconds": 0,
        })

    if args.command == "rotate-token":
        try:
            # The server re-reads the token for every request, so this also
            # works for the detached persistent process started above.  The
            # replacement is never included in CLI output.
            from chrome_control.server import rotate_bridge_token

            rotate_bridge_token()
        except (OSError, RuntimeError) as exc:
            return emit({
                "ok": False,
                "error_code": "token_rotation_failed",
                "error": str(exc),
            }, 2)
        return emit({
            "ok": True,
            "command": "rotate-token",
            "details": details,
            "next": "Run enroll again to pair the extension with the new token.",
        })

    return emit({"ok": False, "error_code": "unknown_command"}, 2)


if __name__ == "__main__":
    raise SystemExit(main())
