from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field


class TraderDoc(BaseModel):
    address: str
    display_name: str | None = None
    account_value: float
    day_pnl: float
    week_pnl: float
    month_pnl: float
    all_pnl: float
    month_roi: float
    all_roi: float
    month_vlm: float
    all_vlm: float
    month_eff: float
    all_eff: float
    roi_ratio: float
    cohort_status: Literal["active", "dropped"] = "active"
    in_cohort_since: datetime
    last_seen: datetime


class CohortChangeDoc(BaseModel):
    address: str
    display_name: str | None = None
    change_type: Literal["NEW_ENTRANT", "DROPPED"]
    ts: datetime
    snapshot: dict = Field(default_factory=dict)
