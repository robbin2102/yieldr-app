from datetime import datetime
from typing import Literal
from pydantic import BaseModel


class PositionDoc(BaseModel):
    address: str
    coin: str
    side: Literal["LONG", "SHORT"]
    size_usd: float
    szi: float
    entry_px: float
    leverage: float
    unrealized_pnl: float
    snapshot_ts: datetime


class PositionChangeDoc(BaseModel):
    address: str
    coin: str
    change_type: Literal["NEW_POSITION", "SIZE_CHANGE", "FLIP", "CLOSED", "LEVERAGE_CHANGE"]
    previous_state: dict | None = None
    new_state: dict | None = None
    ts: datetime
