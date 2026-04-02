from __future__ import annotations

from pathlib import Path
import shutil

from common import RESULT_DIR, ROOT


def sync_watchlist_to_runtime() -> Path | None:
    src = RESULT_DIR / 'watchlist.json'
    if not src.exists():
        return None

    dst = ROOT.parent / 'config' / 'watchlist.json'
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return dst
