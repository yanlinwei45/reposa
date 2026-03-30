from __future__ import annotations

from dataclasses import dataclass, asdict
import pandas as pd


@dataclass
class ScoreParams:
    min_avg_amount_20: float = 3e8
    min_price_above_ma20: bool = True
    min_trend_quality: int = 2
    ret20_min: float = -0.05
    ret20_max: float = 0.30
    ret5_min: float = -0.03
    ret5_max: float = 0.15
    ret10_w: float = 0.24
    ret20_w: float = 0.18
    ret5_w: float = 0.14
    avg_turnover_5_w: float = 0.12
    volume_ratio_5_w: float = 0.08
    volatility_10_w: float = 0.10
    pullback_10_w: float = 0.08
    close_vs_ma20_w: float = 0.04
    close_vs_ma60_w: float = 0.02

    def to_dict(self):
        return asdict(self)


def pct_rank(s: pd.Series, ascending=True):
    return s.rank(pct=True, ascending=ascending)


def filter_frame(x: pd.DataFrame, p: ScoreParams) -> pd.DataFrame:
    x = x.copy()
    x = x[(x['avg_amount_20'] > p.min_avg_amount_20)]
    x = x[(x['ret_20'] > p.ret20_min) & (x['ret_20'] < p.ret20_max)]
    x = x[(x['ret_5'] > p.ret5_min) & (x['ret_5'] < p.ret5_max)]
    if p.min_price_above_ma20:
        x = x[x['close'] > x['ma20']]
    x = x[x['trend_quality'] >= p.min_trend_quality]
    return x


def score_frame(x: pd.DataFrame, p: ScoreParams | None = None) -> pd.DataFrame:
    p = p or ScoreParams()
    x = filter_frame(x, p)
    if x.empty:
        return x
    x = x.copy()
    x['score'] = (
        p.ret10_w * pct_rank(x['ret_10']) +
        p.ret20_w * pct_rank(x['ret_20']) +
        p.ret5_w * pct_rank(x['ret_5']) +
        p.avg_turnover_5_w * pct_rank(x['avg_turnover_5']) +
        p.volume_ratio_5_w * pct_rank(x['volume_ratio_5']) +
        p.volatility_10_w * pct_rank(x['volatility_10'], ascending=False) +
        p.pullback_10_w * pct_rank(x['pullback_10'], ascending=False) +
        p.close_vs_ma20_w * pct_rank(x['close_vs_ma20']) +
        p.close_vs_ma60_w * pct_rank(x['close_vs_ma60'])
    )
    return x.sort_values('score', ascending=False)
