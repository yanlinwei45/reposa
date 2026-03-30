from __future__ import annotations

import json
import time
from pathlib import Path
import pandas as pd
import akshare as ak
from common import UNIVERSE_DIR

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / 'config'

SEED_SYMBOLS = [
    '600519', '300059', '601318', '600036', '600900', '601012', '002594', '300750', '601166', '600276',
    '600030', '000858', '601398', '601288', '601988', '601857', '600809', '002714', '002475', '603259',
    '300308', '300033', '002230', '601668', '600887', '600309', '688111', '688981', '002371', '300274'
]


def fetch_spot_with_retry(max_retries: int = 5, sleep_sec: float = 2.0):
    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            return ak.stock_zh_a_spot_em()
        except Exception as e:
            last_err = e
            print(f'[build_universe] attempt {attempt}/{max_retries} failed: {e}')
            time.sleep(sleep_sec * attempt)
    raise last_err


def load_config_seed_symbols() -> list[str]:
    symbols = []
    for name in ['watchlist.json', 'default.json']:
        p = CONFIG_DIR / name
        if not p.exists():
            continue
        try:
            cfg = json.loads(p.read_text(encoding='utf-8'))
            vals = cfg.get('symbols') if isinstance(cfg, dict) else None
            if vals is None and isinstance(cfg, dict):
                vals = (((cfg.get('marketData') or {}).get('symbols')) or [])
            if isinstance(vals, list):
                for s in vals:
                    raw = str(s).lower().replace('sh', '').replace('sz', '').strip()
                    if raw.isdigit() and len(raw) == 6:
                        symbols.append(raw)
        except Exception:
            pass
    return symbols


def build_fallback_universe() -> pd.DataFrame:
    symbols = []
    seen = set()
    for s in load_config_seed_symbols() + SEED_SYMBOLS:
        if s not in seen:
            symbols.append(s)
            seen.add(s)
    df = pd.DataFrame({'symbol': symbols})
    df['name'] = df['symbol']
    df['amount'] = 1e9
    df['turnover_rate'] = 1.0
    return df


def main():
    try:
        df = fetch_spot_with_retry()
        rename_map = {
            '代码': 'symbol',
            '名称': 'name',
            '最新价': 'last_price',
            '涨跌幅': 'pct_change',
            '成交量': 'volume',
            '成交额': 'amount',
            '换手率': 'turnover_rate',
            '市盈率-动态': 'pe_ttm',
            '总市值': 'total_mv',
            '流通市值': 'circ_mv',
        }
        df = df.rename(columns=rename_map)
        cols = [c for c in rename_map.values() if c in df.columns]
        df = df[cols].copy()
        df['symbol'] = df['symbol'].astype(str).str.zfill(6)
        df = df[~df['name'].astype(str).str.contains('ST|退', na=False)]
        df = df[~df['symbol'].str.startswith('8')]
        df = df[~df['symbol'].str.startswith('4')]
        if 'amount' in df.columns:
            df['amount'] = pd.to_numeric(df['amount'], errors='coerce')
            df = df[df['amount'].fillna(0) > 1e8]
        if 'turnover_rate' in df.columns:
            df['turnover_rate'] = pd.to_numeric(df['turnover_rate'], errors='coerce')
        df = df.sort_values(['amount', 'turnover_rate'], ascending=False, na_position='last')
        source = 'akshare_spot'
    except Exception as e:
        print(f'[build_universe] fallback activated due to: {e}')
        df = build_fallback_universe()
        source = 'fallback_seed'
    out = UNIVERSE_DIR / 'universe.csv'
    df.to_csv(out, index=False, encoding='utf-8-sig')
    print(f'universe saved: {out} rows={len(df)} source={source}')


if __name__ == '__main__':
    main()
