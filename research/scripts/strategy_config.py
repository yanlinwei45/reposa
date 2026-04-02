from __future__ import annotations

import json
from functools import lru_cache

from common import ROOT


@lru_cache(maxsize=1)
def load_strategy_config() -> dict:
    path = ROOT.parent / 'config' / 'strategy.json'
    return json.loads(path.read_text(encoding='utf-8'))


def get_research_strategy_config() -> dict:
    return load_strategy_config().get('research', {})


def get_backtest_config() -> dict:
    return load_strategy_config().get('backtest', {})
