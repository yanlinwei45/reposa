from __future__ import annotations

import pandas as pd
import numpy as np
from common import DAILY_DIR, FEATURE_DIR


def load_all():
    frames = []
    for p in DAILY_DIR.glob('*.parquet'):
        df = pd.read_parquet(p)
        frames.append(df)
    if not frames:
        raise RuntimeError('no daily parquet files found')
    df = pd.concat(frames, ignore_index=True)
    df = df.sort_values(['symbol', 'date']).reset_index(drop=True)
    return df


def add_features(g: pd.DataFrame) -> pd.DataFrame:
    g = g.copy().sort_values('date')
    g['ret_1'] = g['close'].pct_change()
    g['ret_3'] = g['close'].pct_change(3)
    g['ret_5'] = g['close'].pct_change(5)
    g['ret_10'] = g['close'].pct_change(10)
    g['ret_20'] = g['close'].pct_change(20)
    g['ret_60'] = g['close'].pct_change(60)
    g['ma5'] = g['close'].rolling(5).mean()
    g['ma10'] = g['close'].rolling(10).mean()
    g['ma20'] = g['close'].rolling(20).mean()
    g['ma60'] = g['close'].rolling(60).mean()
    g['avg_amount_20'] = g['amount'].rolling(20).mean()
    g['avg_turnover_5'] = g['turnover_rate'].rolling(5).mean() if 'turnover_rate' in g.columns else np.nan
    g['volatility_5'] = g['ret_1'].rolling(5).std()
    g['volatility_10'] = g['ret_1'].rolling(10).std()
    g['pullback_10'] = g['close'] / g['close'].rolling(10).max() - 1
    g['pullback_20'] = g['close'] / g['close'].rolling(20).max() - 1
    g['distance_to_high_20'] = g['close'] / g['close'].rolling(20).max() - 1
    g['volume_ratio_5'] = g['volume'] / g['volume'].rolling(5).mean()
    g['close_vs_ma20'] = g['close'] / g['ma20'] - 1
    g['close_vs_ma60'] = g['close'] / g['ma60'] - 1
    g['ma20_slope_5'] = g['ma20'] / g['ma20'].shift(5) - 1
    g['trend_quality'] = (
        (g['ma5'] > g['ma10']).astype(int) +
        (g['ma10'] > g['ma20']).astype(int) +
        (g['ma20'] > g['ma60']).astype(int)
    )
    return g


def main():
    df = load_all()
    feat = df.groupby('symbol', group_keys=False).apply(add_features).reset_index(drop=True)
    out = FEATURE_DIR / 'daily_features.parquet'
    feat.to_parquet(out, index=False)
    print(f'features saved: {out} rows={len(feat)}')


if __name__ == '__main__':
    main()
