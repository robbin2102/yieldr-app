import os
from pathlib import Path
from dotenv import dotenv_values
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

# Pre-load .env.local manually so we can skip unparseable lines without crashing.
# pydantic-settings dotenv loader aborts on bad lines; this is more resilient.
def _load_env_local() -> None:
    for candidate in [Path(".env"), Path("../../.env.local")]:
        if candidate.exists():
            for key, val in dotenv_values(candidate).items():
                if key and val is not None and key not in os.environ:
                    os.environ[key] = val

_load_env_local()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        extra="ignore",  # env vars already loaded above via _load_env_local
    )

    # MongoDB — alias matches MONGODB_URI used across all existing yieldr services
    mongo_uri: str = Field(default="mongodb://localhost:27017", alias="MONGODB_URI")
    mongo_db_name: str = Field(default="yieldr", alias="MONGO_DB_NAME")

    # Server
    port: int = Field(default=8000, alias="PORT")
    cors_origins: str = Field(default="*", alias="CORS_ORIGINS")

    # --- Filter thresholds ---
    min_av: float = Field(default=50_000, alias="MIN_AV")
    max_av: float = Field(default=50_000_000, alias="MAX_AV")
    max_month_roi: float = Field(default=5.0, alias="MAX_MONTH_ROI")
    max_all_roi: float = Field(default=50.0, alias="MAX_ALL_ROI")
    min_month_vlm: float = Field(default=1_000_000, alias="MIN_MONTH_VLM")
    min_pnl_av_ratio: float = Field(default=0.1, alias="MIN_PNL_AV_RATIO")
    min_month_eff: float = Field(default=0.005, alias="MIN_MONTH_EFF")
    min_roi_ratio: float = Field(default=0.3, alias="MIN_ROI_RATIO")

    # --- Filter toggles ---
    filter_roi_cap_enabled: bool = Field(default=False, alias="FILTER_ROI_CAP_ENABLED")
    filter_efficiency_enabled: bool = Field(default=True, alias="FILTER_EFFICIENCY_ENABLED")
    filter_roi_ratio_enabled: bool = Field(default=True, alias="FILTER_ROI_RATIO_ENABLED")

    # --- Position change thresholds ---
    position_change_threshold_pct: float = Field(default=10.0, alias="POSITION_CHANGE_THRESHOLD_PCT")
    leverage_change_threshold: float = Field(default=5.0, alias="LEVERAGE_CHANGE_THRESHOLD")

    # --- Legacy signal thresholds (kept for backward compat) ---
    tier1_conviction: float = Field(default=0.9, alias="TIER1_CONVICTION")
    tier1_min_traders: int = Field(default=5, alias="TIER1_MIN_TRADERS")
    tier1_min_usd: float = Field(default=1_000_000, alias="TIER1_MIN_USD")
    tier2_conviction: float = Field(default=0.7, alias="TIER2_CONVICTION")
    tier2_min_traders: int = Field(default=10, alias="TIER2_MIN_TRADERS")
    tier3_min_traders: int = Field(default=5, alias="TIER3_MIN_TRADERS")
    momentum_threshold_pct: float = Field(default=50.0, alias="MOMENTUM_THRESHOLD_PCT")

    # --- Signal v2 thresholds ---
    # CONVERGENCE_ACCELERATION: % increase in a sub-metric to count as accelerating
    accel_metric_threshold: float = Field(default=0.10, alias="ACCEL_METRIC_THRESHOLD")
    # WHALE_ACTIVITY: min USD position to consider a Q1 trader a "whale"
    whale_min_usd: float = Field(default=100_000, alias="WHALE_MIN_USD")
    # WHALE_ACTIVITY: dormant if last activity older than N days
    whale_dormant_days: int = Field(default=7, alias="WHALE_DORMANT_DAYS")
    # WHALE_ACTIVITY: SCALEUP threshold (fraction increase)
    whale_scaleup_threshold: float = Field(default=0.5, alias="WHALE_SCALEUP_THRESHOLD")
    # ASYMMETRIC_POSITIONING: threshold pp gap between count_conviction and dollar_conviction
    asymmetric_threshold: float = Field(default=0.20, alias="ASYMMETRIC_THRESHOLD")
    # CAPITAL_ROTATION: portfolio share delta threshold (fraction)
    rotation_threshold: float = Field(default=0.015, alias="ROTATION_THRESHOLD")
    # FUNDING_DIVERGENCE: funding rate magnitude that matters
    funding_threshold: float = Field(default=0.00005, alias="FUNDING_THRESHOLD")
    # STALE_POSITION_DECAY: avg position age in days to flag as stale
    stale_age_days: float = Field(default=14.0, alias="STALE_AGE_DAYS")
    # STALE_POSITION_DECAY: max new entries in 7d to flag as stale
    stale_max_new_entries: int = Field(default=1, alias="STALE_MAX_NEW_ENTRIES")
    # LEVERAGE_SPIKE: leverage ratio vs previous snapshot to trigger signal
    leverage_spike_ratio: float = Field(default=1.5, alias="LEVERAGE_SPIKE_RATIO")

    # --- Concurrency ---
    snapshot_concurrency: int = Field(default=15, alias="SNAPSHOT_CONCURRENCY")

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
