# Research Layer

Python research layer for full A-share universe analysis over the last 6 months and a short-term (~1 month) rotation strategy.

## Setup

```bash
cd research
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python scripts/build_universe.py
python scripts/fetch_history.py
python scripts/build_features.py
python scripts/rank_stocks.py
python scripts/backtest.py
python scripts/export_watchlist.py
```

## Outputs

- `data/universe/universe.csv`
- `data/daily/*.parquet`
- `data/features/daily_features.parquet`
- `data/results/latest_ranking.csv`
- `data/results/backtest_summary.json`
- `data/results/watchlist.json`
