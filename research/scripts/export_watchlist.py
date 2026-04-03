from __future__ import annotations

import json

import pandas as pd
from common import RESULT_DIR, ROOT, write_json
from runtime_bridge import sync_watchlist_to_runtime
from scoring import load_score_params


def load_existing_watchlist():
    for path in [RESULT_DIR / 'watchlist.json', ROOT.parent / 'config' / 'watchlist.json']:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            continue
        if int(data.get('count', 0) or 0) > 0 and data.get('items'):
            return data
    return None


def main(top_n: int = 30):
    df = pd.read_csv(RESULT_DIR / 'latest_ranking.csv', dtype={'symbol': str})
    params = load_score_params()
    top_n = int(top_n or params.top_n)
    top = df.head(top_n).copy()
    if top.empty:
        existing = load_existing_watchlist()
        if existing:
            write_json(RESULT_DIR / 'watchlist.json', existing)
            synced = sync_watchlist_to_runtime()
            print(f'watchlist preserved count={existing.get("count", 0)} runtime_sync={synced}')
            return
    if 'score' not in top.columns:
        top['score'] = None
    if 'name' not in top.columns:
        top['name'] = top['symbol']
    payload = {
        'generated_from': 'research/data/results/latest_ranking.csv',
        'mode': str(top['ranking_mode'].iloc[0]) if not top.empty and 'ranking_mode' in top.columns else 'strict',
        'count': int(len(top)),
        'symbols': top['symbol'].tolist(),
        'items': top[['symbol', 'name', 'score'] + (['ranking_mode'] if 'ranking_mode' in top.columns else [])].fillna('').to_dict(orient='records')
    }
    write_json(RESULT_DIR / 'watchlist.json', payload)
    synced = sync_watchlist_to_runtime()
    print(f'watchlist exported count={len(top)} runtime_sync={synced}')


if __name__ == '__main__':
    main()
