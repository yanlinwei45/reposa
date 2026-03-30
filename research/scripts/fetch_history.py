from __future__ import annotations

import time
import argparse
import pandas as pd
import akshare as ak
from common import UNIVERSE_DIR, DAILY_DIR, six_month_window


def fetch_one(symbol: str, start: str, end: str, max_retries: int = 3):
    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            df = ak.stock_zh_a_hist(symbol=symbol, period='daily', start_date=start, end_date=end, adjust='qfq')
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
            }
            df = df.rename(columns=rename_map)
            df['symbol'] = symbol
            df['date'] = pd.to_datetime(df['date'])
            return df
        except Exception as e:
            last_err = e
            print(f'[fetch_history] {symbol} attempt {attempt}/{max_retries} failed: {e}')
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
