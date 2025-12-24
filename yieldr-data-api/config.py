"""
Application configuration using Pydantic Settings.
Environment variables are loaded from .env.local file.
"""

from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Required settings
    mongodb_uri: str
    quicknode_endpoint: str = Field(alias="QUICKNODE_BASE_RPC_URL")
    moralis_api_key: str
    moralis_base_url: str = "https://deep-index.moralis.io/api/v2.2"
    api_key: str

    # Server configuration
    api_port: int = Field(default=8000, alias="API_PORT")  # Default to 8000 if API_PORT not set

    # Optional settings (for later parts)
    taapi_api_key: str = ""
    quicknode_stream_secret: str = ""

    model_config = SettingsConfigDict(
        env_file="../.env.local",  # Look for .env.local in project root
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )


@lru_cache()
def get_settings() -> Settings:
    """
    Get cached settings instance.
    Uses lru_cache to ensure settings are loaded only once.
    """
    return Settings()
