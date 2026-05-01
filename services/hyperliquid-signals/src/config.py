from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env.local"),  # falls back to root .env.local if present
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # MongoDB
    mongo_uri: str = Field(default="mongodb://localhost:27017", alias="MONGO_URI")
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

    # --- Signal thresholds ---
    tier1_conviction: float = Field(default=0.9, alias="TIER1_CONVICTION")
    tier1_min_traders: int = Field(default=5, alias="TIER1_MIN_TRADERS")
    tier1_min_usd: float = Field(default=1_000_000, alias="TIER1_MIN_USD")
    tier2_conviction: float = Field(default=0.7, alias="TIER2_CONVICTION")
    tier2_min_traders: int = Field(default=10, alias="TIER2_MIN_TRADERS")
    tier3_min_traders: int = Field(default=5, alias="TIER3_MIN_TRADERS")
    momentum_threshold_pct: float = Field(default=50.0, alias="MOMENTUM_THRESHOLD_PCT")

    # --- Concurrency ---
    snapshot_concurrency: int = Field(default=15, alias="SNAPSHOT_CONCURRENCY")

    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
