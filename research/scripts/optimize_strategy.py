from __future__ import annotations

import itertools
import pandas as pd
from common import FEATURE_DIR, RESULT_DIR, write_json
from scoring import ScoreParams
from backtest import run_backtest


def objective(summary: dict) -> float:
    return (
        summary['total_return'] * 1.0 +
        summary['win_rate'] * 0.35 +
        summary['avg_period_return'] * 8.0 +
        summary['max_drawdown'] * 0.6
    )


def main():
    df = pd.read_parquet(FEATURE_DIR / 'daily_features.parquet')
    param_grid = []
    for min_avg_amount_20, min_trend_quality, ret20_max, top_n, hold_days in itertools.product(
        [2e8, 3e8, 5e8],
        [1, 2, 3],
        [0.20, 0.30, 0.40],
        [3, 5, 8],
        [5, 7, 10]
    ):
        p = ScoreParams(
            min_avg_amount_20=min_avg_amount_20,
            min_trend_quality=min_trend_quality,
            ret20_max=ret20_max,
        )
        param_grid.append((p, top_n, hold_days))

    rows = []
    best = None
    best_score = None
    for idx, (params, top_n, hold_days) in enumerate(param_grid, 1):
        _, _, summary = run_backtest(df, top_n=top_n, hold_days=hold_days, params=params)
        score = objective(summary)
        row = {
            'trial': idx,
            'objective': score,
            **summary,
        }
        rows.append(row)
        if best_score is None or score > best_score:
            best_score = score
            best = row
        print(f"trial {idx}/{len(param_grid)} objective={score:.4f} top_n={top_n} hold_days={hold_days} total_return={summary['total_return']:.4f} max_dd={summary['max_drawdown']:.4f} win_rate={summary['win_rate']:.4f}")

    out_df = pd.DataFrame(rows).sort_values('objective', ascending=False)
    out_df.to_csv(RESULT_DIR / 'optimization_results.csv', index=False, encoding='utf-8-sig')
    write_json(RESULT_DIR / 'best_params.json', best)
    print('best=', best)


if __name__ == '__main__':
    main()
