from __future__ import annotations

import argparse
import json
from dataclasses import dataclass

import pandas as pd

from common import FEATURE_DIR, RESULT_DIR, write_json
from scoring import ScoreParams, load_score_params, score_frame
from strategy_config import get_backtest_config


@dataclass
class Position:
    symbol: str
    entry_date: pd.Timestamp
    entry_price: float
    quantity: int
    score: float
    hold_days: int = 0
    high_price: float | None = None


def compute_position_value(frame: pd.DataFrame, positions: dict[str, Position]) -> float:
    value = 0.0
    for symbol, pos in positions.items():
        if symbol not in frame.index:
            continue
        value += float(frame.loc[symbol]['close']) * pos.quantity
    return value


def load_best_config():
    path = RESULT_DIR / 'best_params.json'
    params = load_score_params()
    bt_cfg = get_backtest_config()
    top_n = int(bt_cfg.get('topN', 5))
    max_hold_days = int(bt_cfg.get('maxHoldDays', 10))

    if path.exists():
        data = json.loads(path.read_text(encoding='utf-8'))
        top_n = int(data.get('top_n', top_n))
        max_hold_days = int(data.get('hold_days', max_hold_days))
    return params, top_n, max_hold_days


def build_daily_maps(df: pd.DataFrame):
    by_date = {}
    for d, g in df.groupby('date'):
        by_date[pd.Timestamp(d)] = g.set_index('symbol').sort_index()
    return by_date


def get_exit_reason(row: pd.Series, pos: Position, cfg: dict) -> tuple[bool, str]:
    stop_loss_pct = float(cfg.get('stopLossPct', -5))
    take_profit_pct = float(cfg.get('takeProfitPct', 10))
    weak_take_profit_pct = float(cfg.get('weakTakeProfitPct', 8))
    trailing_profit_pct = float(cfg.get('takeProfitPartialPct', 6))
    trailing_drawdown_pct = float(cfg.get('exitDrawdownFromHighPct', 4))
    pnl_pct = (row['close'] / pos.entry_price - 1) * 100

    if pnl_pct <= stop_loss_pct:
        return True, 'stop_loss'

    high_price = max(pos.high_price or pos.entry_price, row['high'])
    drawdown_from_high = (1 - (row['close'] / high_price)) * 100 if high_price else 0
    if pnl_pct >= trailing_profit_pct and drawdown_from_high >= trailing_drawdown_pct:
        return True, 'trailing_take_profit'

    if pnl_pct >= take_profit_pct:
        return True, 'take_profit'

    if pos.score < 0.8 and pnl_pct >= weak_take_profit_pct:
        return True, 'weak_take_profit'

    if pos.hold_days >= int(cfg.get('maxHoldDays', 10)):
        return True, 'max_hold_days'

    return False, ''


def run_backtest(
    df: pd.DataFrame,
    top_n: int | None = None,
    hold_days: int | None = None,
    params: ScoreParams | None = None,
    backtest_overrides: dict | None = None,
    start_date: str | pd.Timestamp | None = None,
    warmup_bars: int = 60,
):
    params = params or load_score_params()
    backtest_cfg = {**get_backtest_config(), **(backtest_overrides or {})}
    top_n = int(top_n or backtest_cfg.get('topN', 5))
    max_hold_days = int(hold_days or backtest_cfg.get('maxHoldDays', 10))

    df = df.copy()
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values(['date', 'symbol']).reset_index(drop=True)
    daily_map = build_daily_maps(df)
    dates = sorted(daily_map.keys())

    initial_capital = float(backtest_cfg.get('initialCapital', 10000000))
    max_positions = int(backtest_cfg.get('maxPositions', 5))
    lot_size = int(backtest_cfg.get('lotSize', 100))
    slippage_bp = float(backtest_cfg.get('slippageBp', 10))
    fee_bp = float(backtest_cfg.get('feeBp', 3))
    reentry_cooldown_days = int(backtest_cfg.get('reentryCooldownDays', 0) or 0)

    cash = initial_capital
    positions: dict[str, Position] = {}
    last_exit_index: dict[str, int] = {}
    equity_curve = []
    picks_log = []
    trade_log = []

    start_idx = max(warmup_bars, 0)
    if start_date is not None:
        start_ts = pd.Timestamp(start_date)
        while start_idx < len(dates) and dates[start_idx] < start_ts:
            start_idx += 1

    for i in range(start_idx, len(dates) - 1):
        current_date = dates[i]
        next_date = dates[i + 1]
        current_frame = daily_map[current_date]
        next_frame = daily_map[next_date]

        closed_trades = []

        for symbol in list(positions.keys()):
            if symbol not in current_frame.index:
                continue

            row = current_frame.loc[symbol]
            pos = positions[symbol]
            pos.hold_days += 1
            pos.high_price = max(pos.high_price or pos.entry_price, float(row['high']))
            should_exit, exit_reason = get_exit_reason(row, pos, {**backtest_cfg, 'maxHoldDays': max_hold_days})
            if not should_exit:
                continue

            exit_price = float(row['close']) * (1 - slippage_bp / 10000)
            fee = exit_price * pos.quantity * fee_bp / 10000
            cash += exit_price * pos.quantity - fee
            pnl_pct = exit_price / pos.entry_price - 1
            closed_trades.append(pnl_pct)
            trade_log.append({
                'date': str(current_date.date()),
                'symbol': symbol,
                'entry_date': str(pos.entry_date.date()),
                'entry_price': pos.entry_price,
                'exit_price': exit_price,
                'quantity': pos.quantity,
                'hold_days': pos.hold_days,
                'pnl_pct': pnl_pct,
                'reason': exit_reason,
                'score': pos.score,
            })
            last_exit_index[symbol] = i
            del positions[symbol]

        ranked = score_frame(current_frame.reset_index(), params)
        available_slots = max_positions - len(positions)
        candidates = []
        if available_slots > 0:
            for _, row in ranked.iterrows():
                symbol = row['symbol']
                if symbol in positions or symbol not in next_frame.index:
                    continue
                last_exit_at = last_exit_index.get(symbol)
                if last_exit_at is not None and reentry_cooldown_days > 0 and (i - last_exit_at) < reentry_cooldown_days:
                    continue
                candidates.append(row)
                if len(candidates) >= min(top_n, available_slots):
                    break

        day_picks = []
        remaining_slots = max(1, available_slots)
        for row in candidates:
            symbol = row['symbol']
            next_row = next_frame.loc[symbol]
            entry_price = float(next_row['open']) * (1 + slippage_bp / 10000)
            budget = cash / remaining_slots
            quantity = int(budget / entry_price / lot_size) * lot_size
            if quantity < lot_size:
                continue
            fee = entry_price * quantity * fee_bp / 10000
            cost = entry_price * quantity + fee
            if cost > cash:
                continue
            cash -= cost
            positions[symbol] = Position(
                symbol=symbol,
                entry_date=next_date,
                entry_price=entry_price,
                quantity=quantity,
                score=float(row['score']),
                high_price=entry_price,
            )
            day_picks.append(symbol)
            remaining_slots = max(1, remaining_slots - 1)

        next_positions_value = compute_position_value(next_frame, positions)
        equity = cash + next_positions_value
        daily_ret = 0.0 if not equity_curve else (equity / equity_curve[-1]['equity']) - 1
        equity_curve.append({
            'date': str(next_date.date()),
            'equity': equity,
            'cash': cash,
            'positions': len(positions),
            'ret': daily_ret,
        })
        picks_log.append({
            'date': str(current_date.date()),
            'picks': day_picks,
            'open_positions': sorted(positions.keys()),
            'closed': len(closed_trades),
        })

    bt = pd.DataFrame(equity_curve)
    bt['equity'] = bt['equity'].astype(float) if not bt.empty else pd.Series(dtype=float)
    bt['ret'] = bt['ret'].astype(float) if not bt.empty else pd.Series(dtype=float)
    total_return = float(bt['equity'].iloc[-1] / initial_capital - 1) if not bt.empty else 0.0
    max_dd = float((bt['equity'] / bt['equity'].cummax() - 1).min()) if not bt.empty else 0.0
    win_rate = float((pd.DataFrame(trade_log)['pnl_pct'] > 0).mean()) if trade_log else 0.0
    sharpe = float((bt['ret'].mean() / bt['ret'].std()) * (252 ** 0.5)) if len(bt) > 1 and bt['ret'].std() not in (0, 0.0) else 0.0
    profit_factor = None
    avg_trade_return = 0.0
    if trade_log:
        trade_df = pd.DataFrame(trade_log)
        gross_profit = float(trade_df.loc[trade_df['pnl_pct'] > 0, 'pnl_pct'].sum())
        gross_loss = float(-trade_df.loc[trade_df['pnl_pct'] < 0, 'pnl_pct'].sum())
        if gross_loss > 0:
            profit_factor = gross_profit / gross_loss
        avg_trade_return = float(trade_df['pnl_pct'].mean())
    summary = {
        'top_n': top_n,
        'hold_days': max_hold_days,
        'observations': int(len(bt)),
        'trades': int(len(trade_log)),
        'total_return': total_return,
        'max_drawdown': max_dd,
        'win_rate': win_rate,
        'sharpe': sharpe,
        'profit_factor': profit_factor,
        'avg_trade_return': avg_trade_return,
        'avg_period_return': float(bt['ret'].mean()) if not bt.empty else 0.0,
        'params': params.to_dict(),
        'backtest_config': backtest_cfg,
    }
    return bt, picks_log, trade_log, summary


def main(top_n: int | None = None, hold_days: int | None = None):
    df = pd.read_parquet(FEATURE_DIR / 'daily_features.parquet')
    params, best_top_n, best_hold_days = load_best_config()
    top_n = top_n or best_top_n
    hold_days = hold_days or best_hold_days
    bt, picks_log, trade_log, summary = run_backtest(df, top_n=top_n, hold_days=hold_days, params=params)
    bt.to_csv(RESULT_DIR / 'backtest_curve.csv', index=False, encoding='utf-8-sig')
    write_json(RESULT_DIR / 'backtest_summary.json', summary)
    write_json(RESULT_DIR / 'backtest_picks.json', picks_log[-30:])
    write_json(RESULT_DIR / 'backtest_trades.json', trade_log[-200:])
    print(summary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--top-n', type=int, default=None)
    parser.add_argument('--hold-days', type=int, default=None)
    args = parser.parse_args()
    main(top_n=args.top_n, hold_days=args.hold_days)
