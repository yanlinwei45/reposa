from __future__ import annotations

from dataclasses import dataclass, asdict
import pandas as pd

from strategy_config import get_research_strategy_config


@dataclass
class ScoreParams:
    min_avg_amount_20: float
    min_price_above_ma20: bool
    min_trend_quality: int
    min_ma20_slope_5: float
    ret10_min: float
    ret10_max: float
    ret20_min: float
    ret20_max: float
    ret5_min: float
    ret5_max: float
    ret60_min: float | None
    ret60_max: float | None
    pullback10_min: float
    pullback10_max: float
    close_vs_ma20_min: float
    close_vs_ma20_max: float
    max_volatility10: float
    volume_ratio5_min: float
    volume_ratio5_max: float
    top_n: int
    weights: dict

    def to_dict(self):
        return asdict(self)


def load_score_params() -> ScoreParams:
    cfg = get_research_strategy_config()
    filt = cfg.get('filter', {})
    return ScoreParams(
        min_avg_amount_20=float(filt.get('minAvgAmount20', 2e8)),
        min_price_above_ma20=bool(filt.get('minPriceAboveMa20', True)),
        min_trend_quality=int(filt.get('minTrendQuality', 2)),
        min_ma20_slope_5=float(filt.get('minMa20Slope5', -0.01)),
        ret10_min=float(filt.get('ret10Min', -0.03)),
        ret10_max=float(filt.get('ret10Max', 0.08)),
        ret20_min=float(filt.get('ret20Min', -0.05)),
        ret20_max=float(filt.get('ret20Max', 0.2)),
        ret5_min=float(filt.get('ret5Min', -0.06)),
        ret5_max=float(filt.get('ret5Max', 0.12)),
        ret60_min=float(filt['ret60Min']) if filt.get('ret60Min') is not None else None,
        ret60_max=float(filt['ret60Max']) if filt.get('ret60Max') is not None else None,
        pullback10_min=float(filt.get('pullback10Min', -0.08)),
        pullback10_max=float(filt.get('pullback10Max', -0.005)),
        close_vs_ma20_min=float(filt.get('closeVsMa20Min', -0.05)),
        close_vs_ma20_max=float(filt.get('closeVsMa20Max', 0.03)),
        max_volatility10=float(filt.get('maxVolatility10', 0.02)),
        volume_ratio5_min=float(filt.get('volumeRatio5Min', 0.6)),
        volume_ratio5_max=float(filt.get('volumeRatio5Max', 1.6)),
        top_n=int(cfg.get('topN', 30)),
        weights=dict(cfg.get('weights', {})),
    )


def pct_rank(s: pd.Series, ascending=True):
    return s.rank(pct=True, ascending=ascending)


def ensure_feature_columns(x: pd.DataFrame) -> pd.DataFrame:
    x = x.copy()
    defaults = {
        'ret_10': 0.0,
        'ret_60': 0.0,
        'distance_to_high_20': 0.0,
        'ma20_slope_5': 0.0,
        'volatility_10': 0.0,
        'pullback_10': 0.0,
        'close_vs_ma20': 0.0,
        'volume_ratio_5': 1.0,
    }
    for col, value in defaults.items():
        if col not in x.columns:
            x[col] = value
    return x


def filter_frame(x: pd.DataFrame, p: ScoreParams) -> pd.DataFrame:
    x = ensure_feature_columns(x)
    x = x[(x['avg_amount_20'] > p.min_avg_amount_20)]
    x = x[(x['ret_10'] > p.ret10_min) & (x['ret_10'] < p.ret10_max)]
    x = x[(x['ret_20'] > p.ret20_min) & (x['ret_20'] < p.ret20_max)]
    x = x[(x['ret_5'] > p.ret5_min) & (x['ret_5'] < p.ret5_max)]
    if p.ret60_min is not None:
        x = x[x['ret_60'] > p.ret60_min]
    if p.ret60_max is not None:
        x = x[x['ret_60'] < p.ret60_max]
    x = x[(x['pullback_10'] > p.pullback10_min) & (x['pullback_10'] < p.pullback10_max)]
    x = x[(x['close_vs_ma20'] > p.close_vs_ma20_min) & (x['close_vs_ma20'] < p.close_vs_ma20_max)]
    x = x[x['volatility_10'] < p.max_volatility10]
    x = x[(x['volume_ratio_5'] > p.volume_ratio5_min) & (x['volume_ratio_5'] < p.volume_ratio5_max)]
    if p.min_price_above_ma20:
        x = x[x['close'] > x['ma20']]
    x = x[x['trend_quality'] >= p.min_trend_quality]
    x = x[x['ma20_slope_5'] >= p.min_ma20_slope_5]
    return x


def score_frame(x: pd.DataFrame, p: ScoreParams | None = None) -> pd.DataFrame:
    p = p or load_score_params()
    x = filter_frame(x, p)
    if x.empty:
        return x

    w = p.weights
    x['score'] = (
        float(w.get('ret10', 0.14)) * pct_rank(x['ret_10']) +
        float(w.get('ret20', 0.1)) * pct_rank(x['ret_20']) +
        float(w.get('ret5', 0.04)) * pct_rank(x['ret_5']) +
        float(w.get('avgTurnover5', 0.12)) * pct_rank(x['avg_turnover_5']) +
        float(w.get('volumeRatio5', 0.05)) * pct_rank(x['volume_ratio_5'], ascending=False) +
        float(w.get('volatility10', 0.16)) * pct_rank(x['volatility_10'], ascending=False) +
        float(w.get('pullback10', 0.18)) * pct_rank(x['pullback_10'], ascending=False) +
        float(w.get('closeVsMa20', 0.1)) * pct_rank(x['close_vs_ma20'], ascending=False) +
        float(w.get('closeVsMa60', 0.04)) * pct_rank(x['close_vs_ma60']) +
        float(w.get('ret60', 0.02)) * pct_rank(x['ret_60']) +
        float(w.get('distanceToHigh20', 0.03)) * pct_rank(x['distance_to_high_20'], ascending=False) +
        float(w.get('ma20Slope5', 0.06)) * pct_rank(x['ma20_slope_5'])
    )
    return x.sort_values('score', ascending=False)
