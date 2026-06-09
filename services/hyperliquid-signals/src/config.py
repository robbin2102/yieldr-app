import os
from pathlib import Path
from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

def _load_env_local() -> None:
    for candidate in [Path(".env"), Path("../../.env.local")]:
        if candidate.exists():
            for key, val in dotenv_values(candidate).items():
                if key and val is not None and key not in os.environ:
                    os.environ[key] = val

_load_env_local()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    # MongoDB
    mongo_uri: str = Field(default="mongodb://localhost:27017", alias="MONGODB_URI")
    mongo_db_name: str = Field(default="yieldr", alias="MONGO_DB_NAME")

    # Server
    port: int = Field(default=8000, alias="PORT")
    cors_origins: str = Field(default="*", alias="CORS_ORIGINS")

    # Snapshot interval (seconds) — set to 60 or 30 for bot testing, default 300
    snapshot_interval_s: int = Field(default=300, alias="SNAPSHOT_INTERVAL_S")

    # --- Filter thresholds ---
    min_av: float = Field(default=50_000, alias="MIN_AV")
    max_av: float = Field(default=50_000_000, alias="MAX_AV")
    min_month_roi: float = Field(default=0.3, alias="MIN_MONTH_ROI")
    min_all_roi: float = Field(default=0.5, alias="MIN_ALL_ROI")
    min_month_vlm: float = Field(default=1_000_000, alias="MIN_MONTH_VLM")
    min_pnl_av_ratio: float = Field(default=0.1, alias="MIN_PNL_AV_RATIO")
    min_month_eff: float = Field(default=0.005, alias="MIN_MONTH_EFF")

    # --- Filter toggles ---
    filter_efficiency_enabled: bool = Field(default=True, alias="FILTER_EFFICIENCY_ENABLED")

    # --- Position change thresholds ---
    position_change_threshold_pct: float = Field(default=10.0, alias="POSITION_CHANGE_THRESHOLD_PCT")
    leverage_change_threshold: float = Field(default=5.0, alias="LEVERAGE_CHANGE_THRESHOLD")

    # --- Legacy signal thresholds ---
    tier1_conviction: float = Field(default=0.9, alias="TIER1_CONVICTION")
    tier1_min_traders: int = Field(default=5, alias="TIER1_MIN_TRADERS")
    tier1_min_usd: float = Field(default=1_000_000, alias="TIER1_MIN_USD")
    tier2_conviction: float = Field(default=0.7, alias="TIER2_CONVICTION")
    tier2_min_traders: int = Field(default=10, alias="TIER2_MIN_TRADERS")
    tier3_min_traders: int = Field(default=5, alias="TIER3_MIN_TRADERS")
    momentum_threshold_pct: float = Field(default=50.0, alias="MOMENTUM_THRESHOLD_PCT")

    # --- Signal v2 thresholds ---
    accel_metric_threshold: float = Field(default=0.10, alias="ACCEL_METRIC_THRESHOLD")
    whale_min_usd: float = Field(default=100_000, alias="WHALE_MIN_USD")
    whale_dormant_days: int = Field(default=7, alias="WHALE_DORMANT_DAYS")
    whale_scaleup_threshold: float = Field(default=0.5, alias="WHALE_SCALEUP_THRESHOLD")
    asymmetric_threshold: float = Field(default=0.20, alias="ASYMMETRIC_THRESHOLD")
    rotation_threshold: float = Field(default=0.015, alias="ROTATION_THRESHOLD")
    funding_threshold: float = Field(default=0.00005, alias="FUNDING_THRESHOLD")
    stale_age_days: float = Field(default=14.0, alias="STALE_AGE_DAYS")
    stale_max_new_entries: int = Field(default=1, alias="STALE_MAX_NEW_ENTRIES")
    leverage_spike_ratio: float = Field(default=1.5, alias="LEVERAGE_SPIKE_RATIO")

    # --- Concurrency ---
    snapshot_concurrency: int = Field(default=15, alias="SNAPSHOT_CONCURRENCY")

    # ── Execution bot ──────────────────────────────────────────────────────────
    bot_enabled: bool = Field(default=False, alias="BOT_ENABLED")
    bot_testnet: bool = Field(default=True, alias="BOT_TESTNET")
    hl_wallet_address: str = Field(default="", alias="HL_WALLET_ADDRESS")
    hl_private_key: str = Field(default="", alias="HL_PRIVATE_KEY")

    # Capital management
    bot_position_size_usdc: float = Field(default=100.0, alias="BOT_POSITION_SIZE_USDC")
    bot_max_capital_usdc: float = Field(default=500.0, alias="BOT_MAX_CAPITAL_USDC")
    bot_leverage: int = Field(default=1, alias="BOT_LEVERAGE")
    daily_loss_limit_pct: float = Field(default=0.05, alias="DAILY_LOSS_LIMIT_PCT")

    # Execution quality gates
    spread_limit_bps: float = Field(default=4.0, alias="SPREAD_LIMIT_BPS")
    drift_limit_bps: float = Field(default=20.0, alias="DRIFT_LIMIT_BPS")

    # Coin/strategy filtering
    bot_excluded_coins: str = Field(default="", alias="BOT_EXCLUDED_COINS")
    # Comma-separated strategies to auto-execute; others only signal
    bot_strategies: str = Field(default="WAKEUP_LS10_4H,WHALE_FLIP", alias="BOT_STRATEGIES")

    # Order retries — applies to both entry and close (ALO at mid)
    bot_order_retries: int = Field(default=5, alias="BOT_ORDER_RETRIES")
    # Seconds to wait for fill before cancelling and re-quoting
    bot_order_wait_s: int = Field(default=15, alias="BOT_ORDER_WAIT_S")

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
