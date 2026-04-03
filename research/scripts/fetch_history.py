from __future__ import annotations

import time
import argparse
import pandas as pd
import akshare as ak
from common import UNIVERSE_DIR, DAILY_DIR, six_month_window


def normalize_history_frame(df: pd.DataFrame | None, symbol: str) -> pd.DataFrame | None:
    if df is None or df.empty:
        return None
    rename_map = {
        '日期': 'date',
        '股票代码': 'symbol',
        '开盘': 'open',
        '收盘': 'close',
        '最高': 'high',
        '最低': 'low',
        '成交量': 'volume',
        '成交额': 'amount',
        '振幅': 'amplitude',
        '涨跌幅': 'pct_change',
        '涨跌额': 'chg_amount',
        '换手率': 'turnover_rate',
        '成交量(手)': 'volume',
    }
    df = df.rename(columns=rename_map).copy()
    required = ['date', 'open', 'close', 'high', 'low', 'volume']
    if any(col not in df.columns for col in required):
        return None
    if 'amount' not in df.columns:
        df['amount'] = pd.NA
    if 'amplitude' not in df.columns:
        df['amplitude'] = pd.NA
    if 'pct_change' not in df.columns:
        df['pct_change'] = pd.NA
    if 'chg_amount' not in df.columns:
        df['chg_amount'] = pd.NA
    if 'turnover_rate' not in df.columns:
        df['turnover_rate'] = pd.NA
    df['symbol'] = symbol
    df['date'] = pd.to_datetime(df['date'])
    return df[['date', 'symbol', 'open', 'close', 'high', 'low', 'volume', 'amount', 'amplitude', 'pct_change', 'chg_amount', 'turnover_rate']]


def to_tx_symbol(symbol: str) -> str:
    if symbol.startswith(('600', '601', '603', '605', '688', '689')):
        return f'sh{symbol}'
    return f'sz{symbol}'


def fetch_from_eastmoney(symbol: str, start: str, end: str) -> pd.DataFrame | None:
    df = ak.stock_zh_a_hist(symbol=symbol, period='daily', start_date=start, end_date=end, adjust='qfq')
    return normalize_history_frame(df, symbol)


def fetch_from_tencent(symbol: str, start: str, end: str) -> pd.DataFrame | None:
    df = ak.stock_zh_a_hist_tx(symbol=to_tx_symbol(symbol), start_date=start, end_date=end, adjust='qfq')
    return normalize_history_frame(df, symbol)


def fetch_one(symbol: str, start: str, end: str, max_retries: int = 3):
    sources = [
        ('eastmoney', fetch_from_eastmoney),
        ('tencent', fetch_from_tencent),
    ]
    last_err = None
    for source_name, source_fn in sources:
        for attempt in range(1, max_retries + 1):
            try:
                df = source_fn(symbol, start, end)
                if df is None or df.empty:
                    raise RuntimeError('empty history frame')
                return df
            except Exception as e:
                last_err = e
                print(f'[fetch_history] {symbol} source={source_name} attempt {attempt}/{max_retries} failed: {e}')
                time.sleep(0.8 * attempt)
    print(f'[fetch_history] {symbol} failed permanently: {last_err}')
    return None


def main(limit: int | None = None, skip_existing: bool = True):
    uni = pd.read_csv(UNIVERSE_DIR / 'universe.csv', dtype={'symbol': str})
    symbols = uni['symbol'].tolist()
    if limit:
        symbols = symbols[:limit]
    start, end = six_month_window()
    ok = 0
    for i, symbol in enumerate(symbols, 1):
        path = DAILY_DIR / f'{symbol}.parquet'
        if skip_existing and path.exists():
            ok += 1
            continue
        df = fetch_one(symbol, start, end)
        if df is not None and len(df) >= 60:
            df.to_parquet(path, index=False)
            ok += 1
        if i % 20 == 0:
            print(f'progress {i}/{len(symbols)} ok={ok}')
        time.sleep(0.2)
    print(f'done ok={ok}/{len(symbols)}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument('--no-skip-existing', action='store_true')
    args = parser.parse_args()
    main(limit=args.limit, skip_existing=not args.no_skip_existing)
