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
    alchemy_base_url: str = Field(alias="ALCHEMY_BASE_URL")  # Full URL for Base: https://base-mainnet.g.alchemy.com/v2/API_KEY
    moralis_api_key: str
    moralis_base_url: str = "https://deep-index.moralis.io/api/v2.2"
    api_key: str

    # Optional: Ethereum endpoint (if not set, will derive from Base URL)
    alchemy_eth_url: str = Field(default="", alias="ALCHEMY_ETH_URL")

    # Server configuration
    api_port: int = Field(default=8000, alias="API_PORT")

    # Optional settings (for Part 2+)
    quicknode_endpoint: str = Field(default="", alias="QUICKNODE_BASE_RPC_URL")  # For Part 2 eth_getLogs
    taapi_api_key: str = ""
    quicknode_stream_secret: str = ""

    # Agent wallet — EOA private key for signing trades via Avantis SDK (shared fallback)
    # Generate with: cast wallet new  OR  python -c "from eth_account import Account; import secrets; print(Account.from_key(secrets.token_hex(32)).key.hex())"
    agent_wallet_private_key: str = Field(default="", alias="AGENT_WALLET_PRIVATE_KEY")

    # CDP per-agent wallet signing (preferred over shared key when all three are set)
    cdp_api_key_id: str = Field(default="", alias="CDP_API_KEY_ID")
    cdp_api_key_secret: str = Field(default="", alias="CDP_API_KEY_SECRET")
    cdp_wallet_secret: str = Field(default="", alias="CDP_WALLET_SECRET")

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
