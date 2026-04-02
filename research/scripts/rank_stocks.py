from __future__ import annotations

import pandas as pd
from common import FEATURE_DIR, RESULT_DIR
from scoring import load_score_params, score_frame


def main():
    df = pd.read_parquet(FEATURE_DIR / 'daily_features.parquet')
    latest_date = pd.to_datetime(df['date']).max()
    x = df[pd.to_datetime(df['date']) == latest_date].copy()
    params = load_score_params()
    x = score_frame(x, params)
    out = RESULT_DIR / 'latest_ranking.csv'
    x.to_csv(out, index=False, encoding='utf-8-sig')
    print(f'ranking saved: {out} rows={len(x)} latest_date={latest_date.date()} params={params.to_dict()}')


if __name__ == '__main__':
    main()
