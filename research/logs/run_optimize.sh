#!/bin/bash
set -e
source .venv/bin/activate
python scripts/build_universe.py
python scripts/fetch_history.py --limit 30
python scripts/build_features.py
python scripts/optimize_strategy.py
python scripts/rank_stocks.py
python scripts/backtest.py
python scripts/export_watchlist.py
cp data/results/watchlist.json ../config/watchlist.json
