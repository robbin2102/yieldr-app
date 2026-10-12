"""Normalized, database-friendly analytics records."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any


def decimal_or_none(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    return Decimal(str(value))


@dataclass(frozen=True)
class NormalizedTrade:
    trader_id: str
    wallet: str
    chain: str
    transaction_id: str
    leg_index: int
    timestamp: datetime
    side: str
    token_address: str
    token_symbol: str | None
    token_amount: Decimal
    usd_notional: Decimal | None
    execution_price_usd: Decimal | None
    amount_source: str | None
    evidence: str

    @property
    def trade_id(self) -> str:
        return f"{self.trader_id}:{self.chain}:{self.transaction_id}:{self.leg_index}"

    def as_document(self) -> dict[str, Any]:
        document = asdict(self)
        document["trade_id"] = self.trade_id
        for key in ("token_amount", "usd_notional", "execution_price_usd"):
            value = document[key]
            document[key] = None if value is None else format(value, "f")
        return document


@dataclass(frozen=True)
class PricePoint:
    chain: str
    token_address: str
    timestamp: datetime
    value_usd: Decimal
    source: str = "alchemy_historical_sample"


@dataclass(frozen=True)
class Candle:
    chain: str
    token_address: str
    open_time: datetime
    interval: str
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    sample_count: int
    source: str
    quality: str

