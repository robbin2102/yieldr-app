"""
CDP Wallet Service — Router

Endpoints:
  POST /evm/send-transaction   Sign + broadcast a transaction via CDP MPC wallet
  POST /evm/create-account     Create a new CDP EVM account (idempotent)
"""

import os
import logging
from typing import Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("cdp-wallet-service.router")
router = APIRouter()


# ─────────────────────────────────────────────
# Auth helper
# ─────────────────────────────────────────────

def _verify_secret(x_cdp_secret: Optional[str]) -> None:
    """Reject requests that don't carry the shared intra-service secret."""
    expected = os.getenv("CDP_SERVICE_SECRET")
    if not expected:
        raise HTTPException(status_code=503, detail="CDP_SERVICE_SECRET not configured")
    if x_cdp_secret != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─────────────────────────────────────────────
# CDP client — lazy singleton
# ─────────────────────────────────────────────

_cdp_client = None


def _get_cdp_client():
    global _cdp_client
    if _cdp_client is not None:
        return _cdp_client

    key_id = os.getenv("CDP_API_KEY_ID")
    key_secret = (os.getenv("CDP_API_KEY_SECRET") or "").replace("\\n", "\n")
    wallet_sec = os.getenv("CDP_WALLET_SECRET")

    if not (key_id and key_secret and wallet_sec):
        raise HTTPException(
            status_code=503,
            detail="CDP credentials not configured (CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET)",
        )

    from cdp import CdpClient
    _cdp_client = CdpClient(
        api_key_id=key_id,
        api_key_secret=key_secret,
        wallet_secret=wallet_sec,
    )
    logger.info("[CDP] client initialised OK")
    return _cdp_client


# ─────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────

class SendTransactionRequest(BaseModel):
    wallet_address: str         # CDP EVM account address (0x...)
    to: str                     # Contract / recipient address
    data: str = "0x"            # Encoded calldata
    value: int = 0              # Native token value in wei (0 for USDC ops)
    network: str = "base"


class SendTransactionResponse(BaseModel):
    tx_hash: str


class CreateAccountRequest(BaseModel):
    name: str                   # e.g. "yieldr-my-agent"
    idempotency_key: str        # Ensures same key always returns same account


class CreateAccountResponse(BaseModel):
    address: str
    name: str


# ─────────────────────────────────────────────
# POST /evm/send-transaction
# ─────────────────────────────────────────────

@router.post("/evm/send-transaction", response_model=SendTransactionResponse)
async def send_transaction(
    body: SendTransactionRequest,
    x_cdp_secret: Optional[str] = Header(default=None, alias="x-cdp-secret"),
):
    """
    Sign and broadcast a transaction using a CDP MPC wallet.
    CDP auto-estimates nonce and gas fees — callers don't need to set them.
    """
    _verify_secret(x_cdp_secret)
    cdp = _get_cdp_client()

    logger.info(f"[send-tx] wallet={body.wallet_address} to={body.to} network={body.network}")

    try:
        from cdp.evm_transaction_types import TransactionRequestEIP1559

        tx_req = TransactionRequestEIP1559(
            to=body.to,
            data=body.data,
            value=body.value,
            # nonce / gas / maxFeePerGas omitted → CDP auto-estimates
        )

        tx_hash = await cdp.evm.send_transaction(
            address=body.wallet_address,
            transaction=tx_req,
            network=body.network,
        )

        # tx_hash may be a HexBytes or plain str depending on SDK version
        tx_hash_str = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
        logger.info(f"[send-tx] broadcast OK tx_hash={tx_hash_str}")
        return SendTransactionResponse(tx_hash=tx_hash_str)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[send-tx] failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"CDP send_transaction failed: {e}")


# ─────────────────────────────────────────────
# POST /evm/create-account
# ─────────────────────────────────────────────

@router.post("/evm/create-account", response_model=CreateAccountResponse)
async def create_account(
    body: CreateAccountRequest,
    x_cdp_secret: Optional[str] = Header(default=None, alias="x-cdp-secret"),
):
    """
    Create (or retrieve) a CDP EVM account by idempotency key.
    Safe to call multiple times — same key returns the same account.
    """
    _verify_secret(x_cdp_secret)
    cdp = _get_cdp_client()

    logger.info(f"[create-account] name={body.name} idempotency_key={body.idempotency_key}")

    try:
        account = await cdp.evm.create_account(
            name=body.name,
            idempotency_key=body.idempotency_key,
        )
        logger.info(f"[create-account] address={account.address}")
        return CreateAccountResponse(address=account.address, name=body.name)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[create-account] failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"CDP create_account failed: {e}")
