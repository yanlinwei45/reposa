from __future__ import annotations

import argparse
import json
import pandas as pd
from common import FEATURE_DIR, RESULT_DIR, write_json
from scoring import ScoreParams, score_frame


def run_backtest(df: pd.DataFrame, top_n: int = 5, hold_days: int = 10, params: ScoreParams | None = None):
    params = params or ScoreParams()
    df = df.copy()
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values(['date', 'symbol']).reset_index(drop=True)
    dates = sorted(df['date'].unique())
    daily_returns = []
    picks_log = []
    for i in range(60, len(dates) - hold_days):
        d = dates[i]
        day_df = df[df['date'] == d].copy()
        ranked = score_frame(day_df, params)
        picks = ranked.head(top_n)['symbol'].tolist()
        if not picks:
            daily_returns.append({'date': str(d.date()), 'ret': 0.0})
            continue
        future = df[df['symbol'].isin(picks) & df['date'].isin(dates[i+1:i+hold_days+1])].copy()
        entry = future.groupby('symbol').head(1)[['symbol', 'close']].rename(columns={'close': 'entry_close'})
        exit_ = future.groupby('symbol').tail(1)[['symbol', 'close']].rename(columns={'close': 'exit_close'})
        merged = entry.merge(exit_, on='symbol', how='inner')
        merged['ret'] = merged['exit_close'] / merged['entry_close'] - 1
        port_ret = float(merged['ret'].mean()) if not merged.empty else 0.0
        daily_returns.append({'date': str(d.date()), 'ret': port_ret})
        picks_log.append({'date': str(d.date()), 'picks': picks, 'ret': port_ret})
    bt = pd.DataFrame(daily_returns)
    bt['equity'] = (1 + bt['ret']).cumprod() if not bt.empty else pd.Series(dtype=float)
    total_return = float(bt['equity'].iloc[-1] - 1) if not bt.empty else 0.0
    max_dd = float((bt['equity'] / bt['equity'].cummax() - 1).min()) if not bt.empty else 0.0
    win_rate = float((bt['ret'] > 0).mean()) if not bt.empty else 0.0
    summary = {
        'top_n': top_n,
        'hold_days': hold_days,
        'observations': int(len(bt)),
        'total_return': total_return,
        'max_drawdown': max_dd,
        'win_rate': win_rate,
        'avg_period_return': float(bt['ret'].mean()) if not bt.empty else 0.0,
        'params': params.to_dict(),
    }
    return bt, picks_log, summary


def load_best_config():
    p = RESULT_DIR / 'best_params.json'
    if p.exists():
        data = json.loads(p.read_text(encoding='utf-8'))
        params = ScoreParams(**(data.get('params') or data))
        top_n = int(data.get('top_n', 5))
        hold_days = int(data.get('hold_days', 10))
        return params, top_n, hold_days
    return ScoreParams(), 5, 10


def main(top_n: int | None = None, hold_days: int | None = None):
    df = pd.read_parquet(FEATURE_DIR / 'daily_features.parquet')
    params, best_top_n, best_hold_days = load_best_config()
    top_n = top_n or best_top_n
    hold_days = hold_days or best_hold_days
    bt, picks_log, summary = run_backtest(df, top_n=top_n, hold_days=hold_days, params=params)
    bt.to_csv(RESULT_DIR / 'backtest_curve.csv', index=False, encoding='utf-8-sig')
    write_json(RESULT_DIR / 'backtest_summary.json', summary)
    write_json(RESULT_DIR / 'backtest_picks.json', picks_log[-30:])
    print(summary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--top-n', type=int, default=None)
    parser.add_argument('--hold-days', type=int, default=None)
    args = parser.parse_args()
    main(top_n=args.top_n, hold_days=args.hold_days)
