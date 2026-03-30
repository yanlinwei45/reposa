from __future__ import annotations

from pathlib import Path
from datetime import datetime, timedelta
import json

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
UNIVERSE_DIR = DATA / 'universe'
DAILY_DIR = DATA / 'daily'
FEATURE_DIR = DATA / 'features'
RESULT_DIR = DATA / 'results'

for p in [UNIVERSE_DIR, DAILY_DIR, FEATURE_DIR, RESULT_DIR]:
    p.mkdir(parents=True, exist_ok=True)


def six_month_window():
    end = datetime.now().date()
    start = end - timedelta(days=190)
    return start.strftime('%Y%m%d'), end.strftime('%Y%m%d')


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')
