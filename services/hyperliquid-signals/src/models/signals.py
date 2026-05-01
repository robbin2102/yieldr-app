from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field


class TopTrader(BaseModel):
    rank: int | None = None
    address: str
    size_usd: float


class ConvergenceDoc(BaseModel):
    snapshot_ts: datetime
    coin: str
    side: Literal["LONG", "SHORT"]
    n_traders: int
    total_usd: float
    pct_of_coin: float
    pct_of_all_portfolio: float
    avg_mo_roi: float
    conviction: float
    top_traders: list[TopTrader] = Field(default_factory=list)


class AlertDoc(BaseModel):
    coin: str
    side: Literal["LONG", "SHORT"]
    severity: Literal[1, 2, 3]
    alert_type: Literal["TIER_SIGNAL", "MOMENTUM_ALERT"]
    n_traders: int
    total_usd: float
    conviction: float
    acknowledged: bool = False
    created_at: datetime
    snapshot_ts: datetime
