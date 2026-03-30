from __future__ import annotations

import pandas as pd
from common import RESULT_DIR, write_json


def main(top_n: int = 30):
    df = pd.read_csv(RESULT_DIR / 'latest_ranking.csv', dtype={'symbol': str})
    top = df.head(top_n).copy()
    if 'name' not in top.columns:
        top['name'] = top['symbol']
    payload = {
        'generated_from': 'research/data/results/latest_ranking.csv',
        'count': int(len(top)),
        'symbols': top['symbol'].tolist(),
        'items': top[['symbol', 'name', 'score']].fillna('').to_dict(orient='records')
    }
    write_json(RESULT_DIR / 'watchlist.json', payload)
    print(f'watchlist exported count={len(top)}')


if __name__ == '__main__':
    main()
