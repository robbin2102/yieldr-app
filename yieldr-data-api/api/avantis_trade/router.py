"""
Avantis Trade Execution Router
FastAPI endpoints for opening, closing, and managing perp trades on Avantis (Base chain).

Signing strategy (per-agent CDP wallets):
  - If agent_wallet_address is provided AND CDP_SERVICE_URL + CDP_SERVICE_SECRET are set
    → CdpTraderClient delegates signing to the cdp-wallet-service microservice via HTTP.
    This sidesteps the web3 version conflict (avantis-trader-sdk needs web3<7,
    cdp-sdk needs web3>=7.6.0) by keeping them in separate processes.
  - Otherwise falls back to shared LocalSigner (AGENT_WALLET_PRIVATE_KEY).
"""

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from web3 import AsyncWeb3
import httpx

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import TradeInput, TradeInputOrderType, MarginUpdateType
from avantis_trader_sdk.signers.local_signer import LocalSigner
from avantis_trader_sdk.signers.base import BaseSigner

from api.dependencies import verify_api_key
from config import get_settings

settings = get_settings()
router = APIRouter()
logger = logging.getLogger("avantis_trade.router")


# ─────────────────────────────────────────────
# CDP Wallet Service — HTTP client helpers
# ─────────────────────────────────────────────

def _cdp_service_configured() -> bool:
    """True when cdp-wallet-service URL and secret are both set."""
    return bool(settings.cdp_service_url and settings.cdp_service_secret)


async def _cdp_send_transaction(wallet_address: str, to: str, data: str = "0x", value: int = 0) -> str:
    """
    Delegate transaction signing + broadcast to cdp-wallet-service.
    Returns the tx hash string.
    """
    url = f"{settings.cdp_service_url.rstrip('/')}/evm/send-transaction"
    payload = {
        "wallet_address": wallet_address,
        "to": to,
        "data": data,
        "value": value,
        "network": "base-mainnet",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            url,
            json=payload,
            headers={"x-cdp-secret": settings.cdp_service_secret},
        )
    if resp.status_code != 200:
        logger.error(f"[CDP-svc] send-transaction failed {resp.status_code}: {resp.text}")
        raise HTTPException(
            status_code=502,
            detail=f"CDP wallet service error {resp.status_code}: {resp.text}",
        )
    return resp.json()["tx_hash"]


# ─────────────────────────────────────────────
# CDP Signer — satisfies BaseSigner interface
# ─────────────────────────────────────────────

class CdpSigner(BaseSigner):
    """
    Adapter so avantis-trader-sdk sees a valid signer.
    sign_transaction() is intentionally unused — CdpTraderClient overrides
    sign_and_get_receipt() to delegate to the cdp-wallet-service via HTTP.
    """
    def __init__(self, wallet_address: str):
        self._address = wallet_address

    def get_ethereum_address(self) -> str:
        return self._address

    async def sign_transaction(self, transaction):
        raise NotImplementedError("Signing is delegated to cdp-wallet-service")


# ─────────────────────────────────────────────
# CdpTraderClient — signs via cdp-wallet-service
# ─────────────────────────────────────────────

class CdpTraderClient(TraderClient):
    """
    Extends TraderClient so that every call to sign_and_get_receipt() is routed
    to the cdp-wallet-service microservice (which owns cdp-sdk).

    This avoids the web3 version conflict between avantis-trader-sdk (web3<7)
    and cdp-sdk (web3>=7.6.0) by keeping them in separate processes.
    """
    def __init__(self, provider_url: str, agent_wallet_address: str, async_web3: AsyncWeb3):
        super().__init__(provider_url=provider_url, signer=CdpSigner(agent_wallet_address))
        self._cdp_wallet = agent_wallet_address
        self._async_web3 = async_web3

    async def sign_and_get_receipt(self, transaction: dict):
        tx_hash = await _cdp_send_transaction(
            wallet_address=self._cdp_wallet,
            to=transaction["to"],
            data=transaction.get("data", "0x"),
            value=transaction.get("value", 0),
        )
        return await self._async_web3.eth.wait_for_transaction_receipt(tx_hash)


# ─────────────────────────────────────────────
# Client Factory
# ─────────────────────────────────────────────

def _get_rpc_url() -> str:
    rpc = settings.quicknode_endpoint
    if not rpc:
        raise HTTPException(
            status_code=503,
            detail="QUICKNODE_BASE_RPC_URL is not configured"
        )
    return rpc


def _build_trader_client(agent_wallet_address: Optional[str] = None) -> TraderClient:
    """
    Return the appropriate TraderClient:
      - CdpTraderClient  when agent_wallet_address + cdp-wallet-service are configured
      - LocalSigner-backed TraderClient  as fallback (shared AGENT_WALLET_PRIVATE_KEY)
    """
    rpc_url    = _get_rpc_url()
    async_web3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(rpc_url, request_kwargs={"timeout": 60}))

    if agent_wallet_address and _cdp_service_configured():
        logger.info(f"[CDP-svc] using CDP wallet {agent_wallet_address}")
        return CdpTraderClient(
            provider_url=rpc_url,
            agent_wallet_address=agent_wallet_address,
            async_web3=async_web3,
        )

    # Fallback — shared EOA wallet
    private_key = settings.agent_wallet_private_key
    if not private_key:
        raise HTTPException(
            status_code=503,
            detail="No signing method available: AGENT_WALLET_PRIVATE_KEY not set and CDP_SERVICE_URL not configured",
        )
    signer = LocalSigner(private_key, async_web3)
    return TraderClient(provider_url=rpc_url, signer=signer)


def _serialize_receipt(receipt) -> dict:
    """Convert a web3 TxReceipt (AttributeDict with HexBytes) to a plain dict."""
    return {
        "transactionHash": receipt.transactionHash.hex(),
        "blockNumber": receipt.blockNumber,
        "status": receipt.status,
        "gasUsed": receipt.gasUsed,
    }


def _serialize_trade(trade) -> dict:
    """Convert a TradeResponse object to a plain dict."""
    return {
        "trader": trade.trader,
        "pair_index": trade.pair_index,
        "trade_index": trade.trade_index,
        "collateral": trade.collateral_in_trade if hasattr(trade, "collateral_in_trade") else None,
        "open_collateral": trade.open_collateral if hasattr(trade, "open_collateral") else None,
        "leverage": trade.leverage,
        "open_price": trade.open_price if hasattr(trade, "open_price") else None,
        "is_long": trade.is_long if hasattr(trade, "is_long") else None,
        "tp": trade.tp if hasattr(trade, "tp") else None,
        "sl": trade.sl if hasattr(trade, "sl") else None,
    }


# ─────────────────────────────────────────────
# Request / Response Models
# ─────────────────────────────────────────────

class OpenTradeRequest(BaseModel):
    pair: str                           # e.g. "ETH/USD"
    direction: str                      # "long" | "short"
    collateral: float                   # USDC amount
    leverage: float
    tp_pct: float                       # % above/below entry (e.g. 3.0 for 3%)
    sl_pct: float                       # % below/above entry
    order_type: str = "MARKET"          # MARKET | LIMIT | STOP_LIMIT | MARKET_ZERO_FEE
    open_price: Optional[float] = None  # Required for LIMIT/STOP_LIMIT
    agent_wallet_address: Optional[str] = None  # CDP wallet → per-agent signing


class CloseTradeRequest(BaseModel):
    trade_index: int
    pair_index: int
    collateral_to_close: float          # Full collateral = full close
    agent_wallet_address: Optional[str] = None


class UpdateTpSlRequest(BaseModel):
    trade_index: int
    pair_index: int
    new_tp: float                       # Absolute price
    new_sl: float                       # Absolute price (0 to remove)
    agent_wallet_address: Optional[str] = None


class UpdateMarginRequest(BaseModel):
    trade_index: int
    pair_index: int
    amount: float
    action: str                         # "DEPOSIT" | "WITHDRAW"
    agent_wallet_address: Optional[str] = None


class CancelLimitRequest(BaseModel):
    order_index: int
    pair_index: int
    agent_wallet_address: Optional[str] = None


class CreateWalletRequest(BaseModel):
    name: str                               # e.g. "yieldr-agent-<user_id>"
    idempotency_key: str                    # Stable per-user key → same key = same wallet


class FundAgentRequest(BaseModel):
    amount: float                           # USDC to transfer
    user_wallet_address: str                # User's connected wallet (sender)
    agent_wallet_address: Optional[str] = None  # Agent's CDP wallet (funding destination)


class WithdrawRequest(BaseModel):
    amount: float                           # Amount to withdraw
    asset: str                              # "ETH" | "USDC"
    to_address: str                         # Destination wallet address
    agent_wallet_address: Optional[str] = None  # Agent's CDP wallet (source)


# ─────────────────────────────────────────────
# POST /trade/execute-open
# ─────────────────────────────────────────────

@router.post("/execute-open")
async def execute_open(
    body: OpenTradeRequest,
    _: str = Depends(verify_api_key),
):
    """
    Open a perp trade on Avantis. Agent wallet signs autonomously.
    Returns tx receipt + trade details.
    """
    client = _build_trader_client(body.agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        # 1. Resolve pair index + live price
        pair_index = await client.pairs_cache.get_pair_index(body.pair)

        # 2. Compute TP/SL from percentage once we have price from the build_trade_open_tx
        #    TradeInput with openPrice=0 → SDK auto-fetches price for MARKET orders.
        #    We set tp/sl as absolute prices based on a temporary price from the price feed.
        price_data = await client.trade.feed_client.get_price_update_data(pair_index)
        entry_price = price_data.core.price

        is_long = body.direction.lower() == "long"
        tp_price = entry_price * (1 + body.tp_pct / 100) if is_long else entry_price * (1 - body.tp_pct / 100)
        sl_price = entry_price * (1 - body.sl_pct / 100) if is_long else entry_price * (1 + body.sl_pct / 100)

        # 3. Check and approve USDC allowance if needed
        allowance = await client.get_usdc_allowance_for_trading(agent_wallet)
        if allowance < body.collateral:
            await client.approve_usdc_for_trading(body.collateral * 10)

        # 4. Build TradeInput
        trade_input = TradeInput(
            trader=agent_wallet,
            pair_index=pair_index,
            collateral_in_trade=body.collateral,
            is_long=is_long,
            leverage=body.leverage,
            tp=tp_price,
            sl=sl_price,
            open_price=body.open_price or 0,
        )

        # 5. Get fee estimates
        position_size = body.collateral * body.leverage
        opening_fee = await client.fee_parameters.get_opening_fee(
            position_size=position_size,
            is_long=is_long,
            pair_index=pair_index,
        )
        loss_protection = await client.trading_parameters.get_loss_protection_for_trade_input(
            trade_input, opening_fee_usdc=opening_fee
        )

        # 6. Resolve order type
        order_type_map = {
            "MARKET": TradeInputOrderType.MARKET,
            "LIMIT": TradeInputOrderType.LIMIT,
            "STOP_LIMIT": TradeInputOrderType.STOP_LIMIT,
            "MARKET_ZERO_FEE": TradeInputOrderType.MARKET_ZERO_FEE,
        }
        order_type = order_type_map.get(body.order_type.upper(), TradeInputOrderType.MARKET)

        # 7. Build tx, sign, and broadcast
        tx = await client.trade.build_trade_open_tx(trade_input, order_type, slippage_percentage=1)
        receipt = await client.sign_and_get_receipt(tx)

        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "block_number": receipt.blockNumber,
            "status": receipt.status,
            "agent_wallet": agent_wallet,
            "pair": body.pair,
            "pair_index": pair_index,
            "direction": body.direction,
            "collateral": body.collateral,
            "leverage": body.leverage,
            "entry_price": entry_price,
            "tp_price": tp_price,
            "sl_price": sl_price,
            "opening_fee_usdc": opening_fee,
            "loss_protection_pct": loss_protection.percentage,
            "loss_protection_usdc": loss_protection.amount,
            "order_type": body.order_type,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade open failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-close
# ─────────────────────────────────────────────

@router.post("/execute-close")
async def execute_close(
    body: CloseTradeRequest,
    _: str = Depends(verify_api_key),
):
    """Close an open trade. Full close = pass full collateral amount."""
    client = _build_trader_client(body.agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        tx = await client.trade.build_trade_close_tx(
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            collateral_to_close=body.collateral_to_close,
            trader=agent_wallet,
        )
        receipt = await client.sign_and_get_receipt(tx)

        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "block_number": receipt.blockNumber,
            "status": receipt.status,
            "trade_index": body.trade_index,
            "pair_index": body.pair_index,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade close failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-update-tp-sl
# ─────────────────────────────────────────────

@router.post("/execute-update-tp-sl")
async def execute_update_tp_sl(
    body: UpdateTpSlRequest,
    _: str = Depends(verify_api_key),
):
    """Update take profit and stop loss prices on an open trade."""
    client = _build_trader_client(body.agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        tx = await client.trade.build_trade_tp_sl_update_tx(
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            take_profit_price=body.new_tp,
            stop_loss_price=body.new_sl,
            trader=agent_wallet,
        )
        receipt = await client.sign_and_get_receipt(tx)

        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "status": receipt.status,
            "new_tp": body.new_tp,
            "new_sl": body.new_sl,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TP/SL update failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-update-margin
# ─────────────────────────────────────────────

@router.post("/execute-update-margin")
async def execute_update_margin(
    body: UpdateMarginRequest,
    _: str = Depends(verify_api_key),
):
    """Deposit or withdraw collateral from an open trade."""
    client = _build_trader_client(body.agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        if body.action.upper() not in ("DEPOSIT", "WITHDRAW"):
            raise HTTPException(status_code=400, detail="action must be DEPOSIT or WITHDRAW")

        # Check allowance before deposit
        if body.action.upper() == "DEPOSIT":
            allowance = await client.get_usdc_allowance_for_trading(agent_wallet)
            if allowance < body.amount:
                await client.approve_usdc_for_trading(body.amount * 10)

        margin_type = MarginUpdateType[body.action.upper()]

        tx = await client.trade.build_trade_margin_update_tx(
            trader=agent_wallet,
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            margin_update_type=margin_type,
            collateral_change=body.amount,
        )
        receipt = await client.sign_and_get_receipt(tx)

        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "status": receipt.status,
            "action": body.action,
            "amount": body.amount,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Margin update failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-cancel-limit
# ─────────────────────────────────────────────

@router.post("/execute-cancel-limit")
async def execute_cancel_limit(
    body: CancelLimitRequest,
    _: str = Depends(verify_api_key),
):
    """Cancel a pending limit or stop-limit order."""
    client = _build_trader_client(body.agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        tx = await client.trade.build_order_cancel_tx(
            pair_index=body.pair_index,
            trade_index=body.order_index,
            trader=agent_wallet,
        )
        receipt = await client.sign_and_get_receipt(tx)

        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "status": receipt.status,
            "order_index": body.order_index,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cancel limit failed: {str(e)}")


# ─────────────────────────────────────────────
# GET /trade/positions
# ─────────────────────────────────────────────

@router.get("/positions")
async def get_positions(
    agent_wallet_address: Optional[str] = None,
    _: str = Depends(verify_api_key),
):
    """Fetch all open trades and pending limit orders for the agent wallet."""
    client = _build_trader_client(agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        trades, pending_orders = await client.trade.get_trades(trader=agent_wallet)

        return {
            "agent_wallet": agent_wallet,
            "open_trades": [_serialize_trade(t) for t in trades],
            "pending_orders": [_serialize_trade(o) for o in pending_orders],
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fetch positions failed: {str(e)}")


# ─────────────────────────────────────────────
# GET /trade/balance
# ─────────────────────────────────────────────

@router.get("/balance")
async def get_balance(
    agent_wallet_address: Optional[str] = None,
    _: str = Depends(verify_api_key),
):
    """Return USDC balance and ETH balance of the agent wallet."""
    client = _build_trader_client(agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        usdc_balance = await client.get_usdc_balance(agent_wallet)
        eth_balance = await client.get_balance(agent_wallet)

        return {
            "agent_wallet": agent_wallet,
            "usdc_balance": usdc_balance,
            "eth_balance": eth_balance,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fetch balance failed: {str(e)}")


# ─────────────────────────────────────────────
# GET /trade/fees
# ─────────────────────────────────────────────

@router.get("/fees")
async def get_fees(
    pair: str,
    collateral: float,
    leverage: float,
    is_long: bool,
    order_type: str = "MARKET",
    open_price: Optional[float] = None,
    agent_wallet_address: Optional[str] = None,
    _: str = Depends(verify_api_key),
):
    """
    Estimate opening fee and loss protection for a prospective trade.
    Use this before execution to show the user the cost breakdown.
    """
    client = _build_trader_client(agent_wallet_address)
    agent_wallet = client.get_signer().get_ethereum_address()

    try:
        pair_index = await client.pairs_cache.get_pair_index(pair)
        position_size = collateral * leverage

        opening_fee = await client.fee_parameters.get_opening_fee(
            position_size=position_size,
            is_long=is_long,
            pair_index=pair_index,
        )

        # Build a TradeInput for loss protection calculation
        trade_input = TradeInput(
            trader=agent_wallet,
            pair_index=pair_index,
            collateral_in_trade=collateral,
            is_long=is_long,
            leverage=leverage,
            tp=0.0001,  # Placeholder — only needed for loss protection calc
            sl=0.0001,
            open_price=open_price or 0,
        )
        loss_protection = await client.trading_parameters.get_loss_protection_for_trade_input(
            trade_input, opening_fee_usdc=opening_fee
        )

        return {
            "pair": pair,
            "pair_index": pair_index,
            "collateral": collateral,
            "leverage": leverage,
            "position_size": position_size,
            "opening_fee_usdc": opening_fee,
            "loss_protection_pct": loss_protection.percentage,
            "loss_protection_usdc": loss_protection.amount,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fee estimation failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/create-wallet
# Proxies to cdp-wallet-service /evm/create-account
# ─────────────────────────────────────────────

@router.post("/create-wallet")
async def create_agent_wallet(
    body: CreateWalletRequest,
    _: str = Depends(verify_api_key),
):
    """
    Create (or retrieve) a CDP EVM wallet for an agent.
    Idempotent — calling with the same idempotency_key returns the same address.
    Proxies to the cdp-wallet-service microservice.
    """
    if not _cdp_service_configured():
        raise HTTPException(
            status_code=503,
            detail="CDP wallet service not configured (CDP_SERVICE_URL / CDP_SERVICE_SECRET missing)",
        )

    url = f"{settings.cdp_service_url.rstrip('/')}/evm/create-account"
    logger.info(f"[create-wallet] name={body.name} key={body.idempotency_key}")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                url,
                json={"name": body.name, "idempotency_key": body.idempotency_key},
                headers={"x-cdp-secret": settings.cdp_service_secret},
            )
        if resp.status_code != 200:
            logger.error(f"[create-wallet] CDP svc error {resp.status_code}: {resp.text}")
            raise HTTPException(
                status_code=502,
                detail=f"CDP wallet service error {resp.status_code}: {resp.text}",
            )
        data = resp.json()
        logger.info(f"[create-wallet] address={data.get('address')}")
        return {"address": data["address"], "name": data["name"]}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[create-wallet] failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Wallet creation failed: {e}")


# ─────────────────────────────────────────────
# POST /trade/withdraw
# Agent wallet signs and sends ETH or USDC to a specified address
# ─────────────────────────────────────────────

async def _send_transaction_any(
    agent_wallet_address: Optional[str],
    to: str,
    data: str = "0x",
    value: int = 0,
) -> str:
    """
    Send a transaction using the CDP service (preferred) or local private key.
    Returns the tx hash string.
    """
    if agent_wallet_address and _cdp_service_configured():
        return await _cdp_send_transaction(
            wallet_address=agent_wallet_address, to=to, data=data, value=value
        )

    # Fallback: sign with local private key
    from eth_account import Account
    private_key = settings.agent_wallet_private_key
    if not private_key:
        raise HTTPException(
            status_code=503,
            detail="No signing method available: neither CDP service nor AGENT_WALLET_PRIVATE_KEY is configured",
        )
    rpc_url = _get_rpc_url()
    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(rpc_url))
    account = Account.from_key(private_key)
    nonce = await w3.eth.get_transaction_count(account.address)
    gas_price = await w3.eth.gas_price
    tx = {
        "nonce": nonce,
        "to": AsyncWeb3.to_checksum_address(to),
        "value": value,
        "data": data,
        "gas": 100_000,
        "gasPrice": gas_price,
        "chainId": 8453,
    }
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
    tx_hash = await w3.eth.send_raw_transaction(raw)
    return tx_hash.hex()


@router.post("/withdraw")
async def withdraw_from_agent(
    body: WithdrawRequest,
    _: str = Depends(verify_api_key),
):
    """
    Withdraw ETH or USDC from the agent CDP wallet to a destination address.
    The agent wallet signs and broadcasts autonomously (no user signature needed).
    """
    from web3 import Web3

    if body.asset.upper() not in ("ETH", "USDC"):
        raise HTTPException(status_code=400, detail="asset must be ETH or USDC")

    # Resolve agent wallet address
    if body.agent_wallet_address:
        agent_wallet = body.agent_wallet_address
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()

    to_addr = Web3.to_checksum_address(body.to_address)

    try:
        if body.asset.upper() == "ETH":
            amount_wei = int(body.amount * 10 ** 18)
            tx_hash = await _send_transaction_any(
                agent_wallet_address=body.agent_wallet_address,
                to=to_addr,
                value=amount_wei,
            )
        else:  # USDC
            w3 = Web3(Web3.HTTPProvider(_get_rpc_url()))
            usdc = w3.eth.contract(
                address=Web3.to_checksum_address(USDC_BASE_ADDRESS),
                abi=USDC_TRANSFER_ABI,
            )
            amount_units = int(body.amount * 10 ** 6)  # USDC has 6 decimals
            calldata = usdc.encodeABI(fn_name="transfer", args=[to_addr, amount_units])
            tx_hash = await _send_transaction_any(
                agent_wallet_address=body.agent_wallet_address,
                to=USDC_BASE_ADDRESS,
                data=calldata,
            )

        return {
            "success": True,
            "tx_hash": tx_hash,
            "asset": body.asset.upper(),
            "amount": body.amount,
            "from_wallet": agent_wallet,
            "to_address": to_addr,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Withdraw failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/fund-agent
# Returns an unsigned ERC20 transfer tx — user signs this via RainbowKit
# ─────────────────────────────────────────────

# USDC contract on Base mainnet
USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_TRANSFER_ABI = [
    {
        "name": "transfer",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    }
]


@router.post("/fund-agent")
async def fund_agent(
    body: FundAgentRequest,
    _: str = Depends(verify_api_key),
):
    """
    Build unsigned USDC transfer calldata for the user's wallet to sign via RainbowKit/wagmi.
    Destination is the agent's CDP wallet (body.agent_wallet_address if provided,
    otherwise falls back to the shared trading wallet derived from AGENT_WALLET_PRIVATE_KEY).
    """
    from web3 import Web3

    # Determine the funding destination:
    #   1. Agent's own CDP wallet address (preferred — per-agent isolation)
    #   2. Shared trading wallet (fallback when CDP not yet set up)
    if body.agent_wallet_address:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()

    try:
        w3 = Web3(Web3.HTTPProvider(_get_rpc_url()))
        usdc = w3.eth.contract(
            address=Web3.to_checksum_address(USDC_BASE_ADDRESS),
            abi=USDC_TRANSFER_ABI,
        )
        amount_wei = int(body.amount * 10 ** 6)  # USDC = 6 decimals
        calldata = usdc.encodeABI(fn_name="transfer", args=[
            Web3.to_checksum_address(agent_wallet),
            amount_wei,
        ])

        return {
            "agent_wallet": agent_wallet,
            "amount_usdc": body.amount,
            "unsigned_tx": {
                "to": USDC_BASE_ADDRESS,
                "data": calldata,
                "value": "0x0",
                "chainId": 8453,  # Base mainnet
            },
            "instructions": (
                f"Send {body.amount} USDC from {body.user_wallet_address} "
                f"to agent wallet {agent_wallet}"
            ),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fund agent tx build failed: {str(e)}")
