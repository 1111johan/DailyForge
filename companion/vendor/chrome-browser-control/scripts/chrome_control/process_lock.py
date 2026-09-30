"""Small cross-process file lock used by browser runtime launchers."""

from __future__ import annotations

import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def process_lock(name: str, *, timeout: float = 25):
    lock_dir = Path(tempfile.gettempdir()) / "chrome_browser_control_locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(
        char if char.isalnum() or char in {"-", "_"} else "_"
        for char in str(name or "process")
    )
    lock_path = lock_dir / f"{safe_name}.lock"
    handle = lock_path.open("a+b")
    if lock_path.stat().st_size == 0:
        handle.write(b"0")
        handle.flush()
    deadline = time.monotonic() + max(0.1, float(timeout))
    acquired = False
    try:
        while time.monotonic() < deadline:
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (OSError, BlockingIOError):
                time.sleep(0.1)
                continue
            acquired = True
            break
        if not acquired:
            raise TimeoutError(f"process lock timeout: {safe_name}")
        yield
    finally:
        if acquired:
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        handle.close()
