from __future__ import annotations

import itertools
from dataclasses import replace

import pandas as pd

from backtest import run_backtest
from common import FEATURE_DIR, RESULT_DIR, write_json
from scoring import ScoreParams, load_score_params


def score_summary(summary: dict) -> float:
    total_return = float(summary['total_return'])
    sharpe = float(summary.get('sharpe', 0.0))
    avg_trade_return = float(summary.get('avg_trade_return', 0.0))
    max_drawdown = abs(float(summary['max_drawdown']))
    trades = int(summary.get('trades', 0))
    profit_factor_raw = summary.get('profit_factor')
    if profit_factor_raw is None:
        profit_factor = 12.0 if trades > 0 and float(summary.get('win_rate', 0.0)) >= 0.999 and avg_trade_return > 0 else 0.0
    else:
        profit_factor = min(float(profit_factor_raw), 20.0)

    return (
        total_return * 4.0 +
        sharpe * 0.7 +
        profit_factor * 0.4 +
        avg_trade_return * 8.0 -
        max_drawdown * 4.0 +
        min(trades, 8) * 0.08
    )


def objective(full: dict, early: dict, recent: dict) -> float:
    score = score_summary(full) + score_summary(early) * 0.6 + score_summary(recent)
    if full['trades'] < 4:
        score -= (4 - full['trades']) * 0.8
    if recent['trades'] < 2:
        score -= (2 - recent['trades']) * 1.0
    if full['total_return'] <= 0:
        score -= 2.0
    if recent['total_return'] <= 0:
        score -= 2.5
    if early['total_return'] <= 0:
        score -= 1.0
    return score


def make_params(base: ScoreParams, overrides: dict) -> ScoreParams:
    return replace(base, **overrides)


def iter_trials(base_params: ScoreParams):
    weight_profiles = [
        {
            'ret10': 0.16,
            'ret20': 0.16,
            'ret5': 0.02,
            'avgTurnover5': 0.08,
            'volumeRatio5': 0.05,
            'volatility10': 0.14,
            'pullback10': 0.16,
            'closeVsMa20': 0.10,
            'closeVsMa60': 0.05,
            'ret60': 0.04,
            'distanceToHigh20': 0.02,
            'ma20Slope5': 0.08,
        },
        {
            'ret10': 0.14,
            'ret20': 0.18,
            'ret5': 0.02,
            'avgTurnover5': 0.08,
            'volumeRatio5': 0.05,
            'volatility10': 0.16,
            'pullback10': 0.18,
            'closeVsMa20': 0.08,
            'closeVsMa60': 0.05,
            'ret60': 0.03,
            'distanceToHigh20': 0.01,
            'ma20Slope5': 0.08,
        },
    ]

    for (
        top_n,
        hold_days,
        stop_loss_pct,
        take_profit_pct,
        trailing_profit_pct,
        trailing_drawdown_pct,
        ret20_min,
        ret5_max,
        pullback10_min,
        max_volatility10,
        close_vs_ma20_max,
        weights,
    ) in itertools.product(
        [1, 2],
        [4, 5],
        [-3.0, -3.5, -4.0],
        [4.5, 5.0, 6.0],
        [2.5, 3.0, 3.5],
        [1.5, 2.0],
        [0.0, 0.02],
        [0.0, 0.01],
        [-0.06, -0.05],
        [0.016, 0.018],
        [0.015, 0.02],
        weight_profiles,
    ):
        params = make_params(
            base_params,
            {
                'min_price_above_ma20': True,
                'min_trend_quality': 2,
                'min_ma20_slope_5': 0.0,
                'ret20_min': ret20_min,
                'ret20_max': 0.18,
                'ret5_min': -0.04,
                'ret5_max': ret5_max,
                'pullback10_min': pullback10_min,
                'pullback10_max': -0.005,
                'close_vs_ma20_min': -0.025,
                'close_vs_ma20_max': close_vs_ma20_max,
                'max_volatility10': max_volatility10,
                'volume_ratio5_min': 0.7,
                'volume_ratio5_max': 1.5,
                'weights': weights,
            },
        )
        bt_overrides = {
            'stopLossPct': stop_loss_pct,
            'takeProfitPct': take_profit_pct,
            'takeProfitPartialPct': trailing_profit_pct,
            'weakTakeProfitPct': max(take_profit_pct - 1.0, trailing_profit_pct),
            'exitDrawdownFromHighPct': trailing_drawdown_pct,
        }
        yield params, top_n, hold_days, bt_overrides


def main():
    df = pd.read_parquet(FEATURE_DIR / 'daily_features.parquet')
    df['date'] = pd.to_datetime(df['date'])
    dates = sorted(df['date'].unique())
    if len(dates) < 80:
        raise RuntimeError('not enough history to optimize')

    recent_df = df[df['date'].isin(dates[-92:])].copy()
    early_df = df[df['date'].isin(dates[:92])].copy()
    base_params = load_score_params()
    trials = list(iter_trials(base_params))

    rows = []
    best = None
    best_score = None
    for idx, (params, top_n, hold_days, bt_overrides) in enumerate(trials, 1):
        _, _, _, full_summary = run_backtest(df, top_n=top_n, hold_days=hold_days, params=params, backtest_overrides=bt_overrides)
        _, _, _, early_summary = run_backtest(early_df, top_n=top_n, hold_days=hold_days, params=params, backtest_overrides=bt_overrides)
        _, _, _, recent_summary = run_backtest(recent_df, top_n=top_n, hold_days=hold_days, params=params, backtest_overrides=bt_overrides)
        score = objective(full_summary, early_summary, recent_summary)

        row = {
            'trial': idx,
            'objective': score,
            'stop_loss_pct': bt_overrides['stopLossPct'],
            'take_profit_pct': bt_overrides['takeProfitPct'],
            'trailing_profit_pct': bt_overrides['takeProfitPartialPct'],
            'trailing_drawdown_pct': bt_overrides['exitDrawdownFromHighPct'],
            'full_total_return': full_summary['total_return'],
            'full_max_drawdown': full_summary['max_drawdown'],
            'full_trades': full_summary['trades'],
            'full_win_rate': full_summary['win_rate'],
            'full_sharpe': full_summary.get('sharpe', 0.0),
            'recent_total_return': recent_summary['total_return'],
            'recent_max_drawdown': recent_summary['max_drawdown'],
            'recent_trades': recent_summary['trades'],
            'recent_win_rate': recent_summary['win_rate'],
            'recent_sharpe': recent_summary.get('sharpe', 0.0),
            'early_total_return': early_summary['total_return'],
            'early_max_drawdown': early_summary['max_drawdown'],
            'early_trades': early_summary['trades'],
            'early_win_rate': early_summary['win_rate'],
            'early_sharpe': early_summary.get('sharpe', 0.0),
            'top_n': top_n,
            'hold_days': hold_days,
            'params': params.to_dict(),
            'backtest_config': full_summary['backtest_config'],
            'summary_full': full_summary,
            'summary_recent': recent_summary,
            'summary_early': early_summary,
        }
        rows.append(row)
        if best_score is None or score > best_score:
            best_score = score
            best = row
        print(
            f"trial {idx}/{len(trials)} objective={score:.4f} "
            f"full_ret={full_summary['total_return']:.4f} recent_ret={recent_summary['total_return']:.4f} "
            f"full_trades={full_summary['trades']} recent_trades={recent_summary['trades']}"
        )

    out_df = pd.DataFrame(rows).sort_values(
        ['objective', 'full_total_return', 'recent_total_return'],
        ascending=[False, False, False],
    )
    out_df.to_csv(RESULT_DIR / 'optimization_results.csv', index=False, encoding='utf-8-sig')
    write_json(RESULT_DIR / 'best_params.json', best)
    print('best=', best)


if __name__ == '__main__':
    main()
