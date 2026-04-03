from __future__ import annotations

from dataclasses import replace

import pandas as pd
from common import FEATURE_DIR, RESULT_DIR
from scoring import load_score_params, score_frame


def build_fallback_params(params):
    return replace(
        params,
        min_price_above_ma20=False,
        min_trend_quality=max(1, params.min_trend_quality - 1),
        min_ma20_slope_5=min(params.min_ma20_slope_5, -0.002),
        ret10_min=min(params.ret10_min, -0.03),
        ret10_max=max(params.ret10_max, 0.03),
        ret20_min=min(params.ret20_min, -0.03),
        ret20_max=max(params.ret20_max, 0.08),
        ret5_min=min(params.ret5_min, -0.03),
        ret5_max=max(params.ret5_max, 0.02),
        ret60_max=0.08 if params.ret60_max is None else max(params.ret60_max, 0.08),
        pullback10_min=min(params.pullback10_min, -0.05),
        pullback10_max=max(params.pullback10_max, 0.0),
        close_vs_ma20_min=min(params.close_vs_ma20_min, -0.03),
        close_vs_ma20_max=max(params.close_vs_ma20_max, 0.02),
        max_volatility10=max(params.max_volatility10, 0.02),
        volume_ratio5_min=min(params.volume_ratio5_min, 0.7),
        volume_ratio5_max=max(params.volume_ratio5_max, 1.5),
    )


def main():
    df = pd.read_parquet(FEATURE_DIR / 'daily_features.parquet')
    latest_date = pd.to_datetime(df['date']).max()
    x = df[pd.to_datetime(df['date']) == latest_date].copy()
    params = load_score_params()
    ranking_mode = 'strict'
    x = score_frame(x, params)
    if x.empty:
        ranking_mode = 'fallback'
        x = score_frame(x=df[pd.to_datetime(df['date']) == latest_date].copy(), p=build_fallback_params(params))
    if not x.empty:
        x = x.copy()
        x['ranking_mode'] = ranking_mode
    out = RESULT_DIR / 'latest_ranking.csv'
    x.to_csv(out, index=False, encoding='utf-8-sig')
    print(
        f'ranking saved: {out} rows={len(x)} latest_date={latest_date.date()} '
        f'mode={ranking_mode} params={params.to_dict()}'
    )


if __name__ == '__main__':
    main()
