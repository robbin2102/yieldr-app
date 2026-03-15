"""
Avantis Trade Execution Routes
Mounted at /trade/* in the python-service.

Signing strategy (in priority order):
  1. CDP Wallet Service (HTTP)  — if agent_wallet_address is passed AND
                                   CDP_SERVICE_URL + CDP_SERVICE_SECRET env vars are set.
                                   Delegates signing to the cdp-wallet-service microservice,
                                   keeping the cdp-sdk dependency isolated there.
  2. Local EOA fallback         — AGENT_WALLET_PRIVATE_KEY (legacy / testing)
"""

import asyncio
import os
from typing import Optional, Any
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from web3 import AsyncWeb3, Web3

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import TradeInput, TradeInputOrderType, MarginUpdateType

router = APIRouter()

# USDC on Base mainnet
USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_APPROVE_ABI = [{
    "name": "approve",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "outputs": [{"name": "", "type": "bool"}],
}]

# ABI fragments for direct on-chain reads — avoids SDK balance/allowance bugs
ERC20_READ_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "allowance",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]
USDC_DECIMALS = 1_000_000  # USDC has 6 decimals


async def _usdc_balance(wallet: str) -> float:
    """Read raw on-chain USDC ERC-20 balance for wallet. Never uses the SDK."""
    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(_get_rpc_url()))
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(USDC_BASE_ADDRESS),
        abi=ERC20_READ_ABI,
    )
    raw = await contract.functions.balanceOf(Web3.to_checksum_address(wallet)).call()
    return raw / USDC_DECIMALS


async def _eth_balance(wallet: str) -> float:
    """Read raw on-chain ETH balance for wallet."""
    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(_get_rpc_url()))
    raw = await w3.eth.get_balance(Web3.to_checksum_address(wallet))
    return raw / 1e18


async def _usdc_allowance(owner: str, spender: str) -> float:
    """Read on-chain USDC allowance for owner→spender."""
    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(_get_rpc_url()))
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(USDC_BASE_ADDRESS),
        abi=ERC20_READ_ABI,
    )
    raw = await contract.functions.allowance(
        Web3.to_checksum_address(owner),
        Web3.to_checksum_address(spender),
    ).call()
    return raw / USDC_DECIMALS

# ─────────────────────────────────────────────
# Auth — simple API key header check
# ─────────────────────────────────────────────

async def verify_api_key(x_api_key: str = Header(..., alias="X-API-Key")):
    expected = os.getenv("API_KEY", "")
    if not expected or x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key


# ─────────────────────────────────────────────
# RPC helper
# ─────────────────────────────────────────────

def _get_rpc_url() -> str:
    rpc = os.getenv("QUICKNODE_BASE_RPC_URL", "")
    if not rpc:
        raise HTTPException(status_code=503, detail="QUICKNODE_BASE_RPC_URL is not configured")
    return rpc


async def _fresh_nonce(wallet: str) -> int:
    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(_get_rpc_url()))
    return await w3.eth.get_transaction_count(Web3.to_checksum_address(wallet), "pending")


# ─────────────────────────────────────────────
# CDP Wallet Service — HTTP signing helpers
# ─────────────────────────────────────────────
# Delegates tx signing to the cdp-wallet-service microservice so that
# cdp-sdk (which requires web3>=7) stays isolated from avantis-trader-sdk
# (which requires web3<7).  Requires env vars:
#   CDP_SERVICE_URL    — e.g. http://cdp-wallet-service.railway.internal:8080
#   CDP_SERVICE_SECRET — shared intra-service secret
# ─────────────────────────────────────────────

def _cdp_service_url() -> str:
    return os.getenv("CDP_SERVICE_URL", "").rstrip("/")

def _cdp_service_secret() -> str:
    return os.getenv("CDP_SERVICE_SECRET", "")

def _cdp_service_configured() -> bool:
    configured = bool(_cdp_service_url() and _cdp_service_secret())
    if not configured:
        missing = []
        if not _cdp_service_url():
            missing.append("CDP_SERVICE_URL")
        if not _cdp_service_secret():
            missing.append("CDP_SERVICE_SECRET")
        print(f"[CDP-svc] NOT configured — missing env vars: {missing}")
    return configured


async def _cdp_svc_send_transaction(wallet_address: str, to: str, data: str = "0x", value: int = 0) -> str:
    """
    Delegate transaction signing + broadcast to cdp-wallet-service.
    Returns the tx_hash string (0x...).
    CDP service auto-estimates nonce and gas fees.
    """
    import httpx
    url = f"{_cdp_service_url()}/evm/send-transaction"
    payload = {
        "wallet_address": wallet_address,
        "to": to,
        "data": data,
        "value": value,
        "network": "base",
    }
    print(f"[CDP-svc] send_transaction → {url} wallet={wallet_address} to={to}")
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            url,
            json=payload,
            headers={"x-cdp-secret": _cdp_service_secret()},
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"CDP wallet service error {resp.status_code}: {resp.text}",
        )
    tx_hash = resp.json()["tx_hash"]
    print(f"[CDP-svc] tx submitted: {tx_hash}")
    return tx_hash


async def _cdp_svc_approve_usdc(wallet_address: str, spender: str, required_amount: float):
    """
    Approve the Avantis trading contract to spend USDC on behalf of the agent wallet,
    signing via cdp-wallet-service.  Approves a fixed 10 000 USDC so the allowance
    isn't depleted after a few trades.
    Verifies the allowance is set on-chain before returning.
    """
    w3_sync = Web3(Web3.HTTPProvider(_get_rpc_url()))
    usdc = w3_sync.eth.contract(
        address=Web3.to_checksum_address(USDC_BASE_ADDRESS),
        abi=USDC_APPROVE_ABI,
    )
    APPROVE_AMOUNT_USDC = 10_000.0
    amount_wei = int(APPROVE_AMOUNT_USDC * 1e6)
    data = usdc.encodeABI(fn_name="approve", args=[
        Web3.to_checksum_address(spender),
        amount_wei,
    ])
    print(f"[CDP-svc] approving 10000 USDC for wallet={wallet_address} spender={spender}")
    tx_hash = await _cdp_svc_send_transaction(
        wallet_address=wallet_address,
        to=USDC_BASE_ADDRESS,
        data=data,
        value=0,
    )
    # Wait for the approval tx to be mined before proceeding to the trade
    w3_async = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(_get_rpc_url()))
    receipt = await w3_async.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    status = getattr(receipt, "status", None)
    if status == 0:
        raise HTTPException(
            status_code=500,
            detail=f"USDC approval tx reverted on-chain: {tx_hash}",
        )
    # Verify allowance is actually set
    post_allowance = await _usdc_allowance(wallet_address, spender)
    print(f"[CDP-svc] post-approval allowance={post_allowance:.4f} USDC for spender={spender}")
    if post_allowance < required_amount:
        raise HTTPException(
            status_code=500,
            detail=(
                f"USDC approval tx landed but on-chain allowance ({post_allowance:.4f}) "
                f"is still below required ({required_amount:.4f}). Check spender address: {spender}"
            ),
        )


# ─────────────────────────────────────────────
# CDP Signer stub (satisfies avantis-trader-sdk BaseSigner interface)
# ─────────────────────────────────────────────

try:
    from avantis_trader_sdk.signers.base import BaseSigner as _BaseSigner
    _HAS_BASE_SIGNER = True
except ImportError:
    _HAS_BASE_SIGNER = False
    _BaseSigner = object  # fallback — CdpSigner still works for address lookup


class CdpSigner(_BaseSigner):
    """
    Minimal signer adapter so avantis-trader-sdk accepts our CDP wallet address.
    sign_transaction() is intentionally unused — CdpTraderClient overrides
    sign_and_get_receipt() to delegate to cdp-wallet-service via HTTP.
    """
    def __init__(self, wallet_address: str):
        self._address = wallet_address

    def get_ethereum_address(self) -> str:
        return self._address

    async def sign_transaction(self, transaction):
        raise NotImplementedError("Signing is delegated to cdp-wallet-service")


# ─────────────────────────────────────────────
# CdpTraderClient — trade building via SDK, signing via cdp-wallet-service
# ─────────────────────────────────────────────

class CdpTraderClient(TraderClient):
    """
    Extends avantis-trader-sdk TraderClient so that sign_and_get_receipt()
    routes to the cdp-wallet-service microservice instead of signing locally.
    All trade-building (build_trade_open_tx etc.) still uses the SDK.
    """
    def __init__(self, provider_url: str, agent_wallet_address: str):
        super().__init__(provider_url=provider_url, signer=CdpSigner(agent_wallet_address))
        self._cdp_wallet = agent_wallet_address
        self._w3_async = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(provider_url))

    async def sign_and_get_receipt(self, transaction: dict):
        tx_hash = await _cdp_svc_send_transaction(
            wallet_address=self._cdp_wallet,
            to=transaction["to"],
            data=transaction.get("data", "0x"),
            value=transaction.get("value", 0),
        )
        print(f"[CdpTraderClient] waiting for receipt: {tx_hash}")
        return await self._w3_async.eth.wait_for_transaction_receipt(tx_hash, timeout=120)


# ─────────────────────────────────────────────
# TraderClient factory (local signer fallback)
# ─────────────────────────────────────────────

def _build_trader_client() -> TraderClient:
    rpc_url = _get_rpc_url()
    private_key = os.getenv("AGENT_WALLET_PRIVATE_KEY", "").strip().strip('"').strip("'")
    if not private_key:
        raise HTTPException(status_code=503, detail="AGENT_WALLET_PRIVATE_KEY is not configured")
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key
    client = TraderClient(provider_url=rpc_url)
    client.set_local_signer(private_key)
    return client


def _build_readonly_client() -> TraderClient:
    """TraderClient with no signer — only for tx building and read calls."""
    return TraderClient(provider_url=_get_rpc_url())


async def _sign_and_get_receipt(tx: dict, agent_wallet_address: Optional[str]) -> Any:
    """Route signing to CDP service or local signer depending on what's configured."""
    if agent_wallet_address and _cdp_service_configured():
        return await _cdp_svc_send_transaction(
            wallet_address=agent_wallet_address,
            to=tx["to"],
            data=tx.get("data", "0x"),
            value=tx.get("value", 0),
        )
    client = _build_trader_client()
    return await client.sign_and_get_receipt(tx)


def _serialize_trade(trade) -> dict:
    t = trade.trade if hasattr(trade, "trade") else trade
    return {
        "trader": getattr(t, "trader", None),
        "pair_index": getattr(t, "pair_index", None),
        "trade_index": getattr(t, "trade_index", None),
        "open_collateral": getattr(t, "open_collateral", None),
        "leverage": getattr(t, "leverage", None),
        "open_price": getattr(t, "open_price", None),
        "is_long": getattr(t, "is_long", None),
        "tp": getattr(t, "tp", None),
        "sl": getattr(t, "sl", None),
        "liquidation_price": getattr(trade, "liquidation_price", None),
    }


# ─────────────────────────────────────────────
# Request models
# ─────────────────────────────────────────────

class OpenTradeRequest(BaseModel):
    pair: str
    direction: str                          # "long" | "short"
    collateral: float                       # USDC
    leverage: float
    tp_pct: float                           # % above/below entry
    sl_pct: float
    order_type: str = "MARKET"
    open_price: Optional[float] = None
    agent_wallet_address: Optional[str] = None  # CDP wallet; falls back to AGENT_WALLET_PRIVATE_KEY


class CloseTradeRequest(BaseModel):
    trade_index: int
    pair_index: int
    collateral_to_close: float
    agent_wallet_address: Optional[str] = None


class UpdateTpSlRequest(BaseModel):
    trade_index: int
    pair_index: int
    new_tp: float
    new_sl: float
    agent_wallet_address: Optional[str] = None


class UpdateMarginRequest(BaseModel):
    trade_index: int
    pair_index: int
    amount: float
    action: str                             # "DEPOSIT" | "WITHDRAW"
    agent_wallet_address: Optional[str] = None


class CancelLimitRequest(BaseModel):
    trade_index: int
    pair_index: int
    agent_wallet_address: Optional[str] = None


class FundAgentRequest(BaseModel):
    amount: float
    user_wallet_address: str
    agent_wallet_address: Optional[str] = None  # override destination if CDP wallet


class WithdrawRequest(BaseModel):
    amount: float
    asset: str                              # "ETH" | "USDC"
    to_address: str
    agent_wallet_address: Optional[str] = None


# ─────────────────────────────────────────────
# GET /trade/balance
# ─────────────────────────────────────────────

@router.get("/balance")
async def get_balance(
    agent_wallet_address: Optional[str] = None,
    _: str = Depends(verify_api_key),
):
    if agent_wallet_address:
        client = _build_readonly_client()
        agent_wallet = Web3.to_checksum_address(agent_wallet_address)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()
    try:
        usdc_balance, eth_balance = await asyncio.gather(
            _usdc_balance(agent_wallet),
            _eth_balance(agent_wallet),
        )
        return {
            "agent_wallet": agent_wallet,
            "usdc_balance": usdc_balance,
            "eth_balance": eth_balance,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Balance fetch failed: {str(e)}")


# ─────────────────────────────────────────────
# GET /trade/positions
# ─────────────────────────────────────────────

@router.get("/positions")
async def get_positions(
    agent_wallet_address: Optional[str] = None,
    _: str = Depends(verify_api_key),
):
    if agent_wallet_address:
        client = _build_readonly_client()
        agent_wallet = Web3.to_checksum_address(agent_wallet_address)
    else:
        client = _build_trader_client()
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
        raise HTTPException(status_code=500, detail=f"Positions fetch failed: {str(e)}")


# ─────────────────────────────────────────────
# GET /trade/fees
# ─────────────────────────────────────────────

@router.get("/fees")
async def get_fees(
    pair: str,
    collateral: float,
    leverage: float,
    is_long: bool,
    _: str = Depends(verify_api_key),
):
    client = _build_trader_client()
    agent_wallet = client.get_signer().get_ethereum_address()
    try:
        pair_index = await client.pairs_cache.get_pair_index(pair)
        trade_input = TradeInput(
            trader=agent_wallet,
            pair_index=pair_index,
            collateral_in_trade=collateral,
            is_long=is_long,
            leverage=leverage,
            tp=0.0001,
            sl=0.0001,
            open_price=0,
        )
        opening_fee = await client.fee_parameters.get_new_trade_opening_fee(trade_input)
        loss_protection = await client.trading_parameters.get_loss_protection_for_trade_input(
            trade_input, opening_fee_usdc=opening_fee
        )
        return {
            "pair": pair,
            "pair_index": pair_index,
            "collateral": collateral,
            "leverage": leverage,
            "position_size": collateral * leverage,
            "opening_fee_usdc": opening_fee,
            "loss_protection_pct": loss_protection.percentage,
            "loss_protection_usdc": loss_protection.amount,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fee estimation failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-open
# ─────────────────────────────────────────────

MIN_POSITION_SIZE_USDC = 100.0  # Avantis protocol minimum

@router.post("/execute-open")
async def execute_open(body: OpenTradeRequest, _: str = Depends(verify_api_key)):
    print(f"[execute_open] ── REQUEST RECEIVED ── pair={body.pair} direction={body.direction} collateral={body.collateral} leverage={body.leverage} agent_wallet={body.agent_wallet_address} order_type={body.order_type}")

    position_size = body.collateral * body.leverage
    if position_size < MIN_POSITION_SIZE_USDC:
        raise HTTPException(
            status_code=400,
            detail=f"Position size ${position_size:.2f} is below Avantis minimum of ${MIN_POSITION_SIZE_USDC:.0f} USDC. "
                   f"Increase collateral or leverage (e.g. collateral=10, leverage=10 → $100).",
        )

    # ── Resolve signing strategy ────────────────────────────────────────────────
    # Priority: CDP wallet service (HTTP) > local EOA fallback
    using_cdp = bool(body.agent_wallet_address and _cdp_service_configured())
    print(f"[execute_open] using_cdp={using_cdp} cdp_service_url={_cdp_service_url() or 'NOT SET'}")

    if using_cdp:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
        # CdpTraderClient handles trade building AND routes sign_and_get_receipt to CDP service
        client = CdpTraderClient(provider_url=_get_rpc_url(), agent_wallet_address=agent_wallet)
    else:
        if body.agent_wallet_address:
            print(f"[execute_open] WARN: agent_wallet_address={body.agent_wallet_address} provided but CDP_SERVICE_URL/CDP_SERVICE_SECRET not set — falling back to local signer")
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()

    print(f"[execute_open] agent_wallet resolved to: {agent_wallet}")

    try:
        # ── Pre-trade checks: USDC collateral + ETH gas ────────────────────────
        usdc_balance, eth_balance = await asyncio.gather(
            _usdc_balance(agent_wallet),
            _eth_balance(agent_wallet),
        )
        print(f"[execute_open] wallet balances: usdc={usdc_balance:.6f} eth={eth_balance:.8f}")
        if usdc_balance < body.collateral:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient USDC. Agent wallet has ${usdc_balance:.2f} USDC "
                    f"but trade requires ${body.collateral:.2f} USDC collateral. "
                    f"Deficit: ${body.collateral - usdc_balance:.2f} USDC. "
                    f"Fund the agent wallet at {agent_wallet}."
                ),
            )
        MIN_ETH_FOR_GAS = 0.001
        if eth_balance < MIN_ETH_FOR_GAS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Agent wallet {agent_wallet} has insufficient ETH ({eth_balance:.6f} ETH). "
                    f"Fund with ≥{MIN_ETH_FOR_GAS} ETH to cover the Avantis execution fee and gas costs."
                ),
            )
        # ── End pre-trade checks ────────────────────────────────────────────────

        pair_index = await client.pairs_cache.get_pair_index(body.pair)
        is_long = body.direction.lower() == "long"

        # Fetch live price for reference; use limit price as TP/SL base for LIMIT orders
        price_data = await client.trade.feed_client.get_price_update_data(pair_index)
        live_price = price_data.core.price
        is_limit = body.order_type.upper() in ("LIMIT", "STOP_LIMIT")
        tp_sl_base = body.open_price if (is_limit and body.open_price) else live_price

        tp_price = tp_sl_base * (1 + body.tp_pct / 100) if is_long else tp_sl_base * (1 - body.tp_pct / 100)
        sl_price = tp_sl_base * (1 - body.sl_pct / 100) if is_long else tp_sl_base * (1 + body.sl_pct / 100)

        # ── USDC Approval ───────────────────────────────────────────────────────
        # Approve BOTH Trading and TradingStorage contracts (belt-and-suspenders:
        # we can't know which one calls USDC.transferFrom inside openTrade()).
        _approval_targets = []
        try:
            _approval_targets.append(("Trading",        str(client.contracts["Trading"].address)))
        except Exception as _e:
            print(f"[execute_open] WARNING: cannot resolve Trading contract address: {_e}")
        try:
            _approval_targets.append(("TradingStorage", str(client.contracts["TradingStorage"].address)))
        except Exception as _e:
            print(f"[execute_open] WARNING: cannot resolve TradingStorage contract address: {_e}")

        if not _approval_targets:
            print(f"[execute_open] WARNING: no approval targets resolved — trade may fail with allowance error")

        for _spender_name, _spender_addr in _approval_targets:
            _allowance = await _usdc_allowance(agent_wallet, _spender_addr)
            print(f"[execute_open] allowance[{_spender_name}={_spender_addr}]={_allowance:.4f} USDC (need {body.collateral}) using_cdp={using_cdp}")
            if _allowance < body.collateral:
                print(f"[execute_open] approving {_spender_name}={_spender_addr} for 10000 USDC")
                if using_cdp:
                    await _cdp_svc_approve_usdc(agent_wallet, _spender_addr, body.collateral)
                else:
                    await client.write_contract("USDC", "approve", _spender_addr, int(10_000 * 1e6))
                    # Verify the approval landed before proceeding
                    _post = await _usdc_allowance(agent_wallet, _spender_addr)
                    print(f"[execute_open] {_spender_name} post-approval allowance={_post:.4f} USDC (local signer)")
                    if _post < body.collateral:
                        raise HTTPException(
                            status_code=500,
                            detail=f"USDC approval to {_spender_name}={_spender_addr} did not take effect (post={_post:.4f}). Check AGENT_WALLET_PRIVATE_KEY.",
                        )
            else:
                print(f"[execute_open] {_spender_name} allowance OK — skipping approval")
        # ── End USDC Approval ───────────────────────────────────────────────────

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

        opening_fee = await client.fee_parameters.get_new_trade_opening_fee(trade_input)
        loss_protection = await client.trading_parameters.get_loss_protection_for_trade_input(
            trade_input, opening_fee_usdc=opening_fee
        )

        order_type_map = {
            "MARKET": TradeInputOrderType.MARKET,
            "LIMIT": TradeInputOrderType.LIMIT,
            "STOP_LIMIT": TradeInputOrderType.STOP_LIMIT,
            "MARKET_ZERO_FEE": TradeInputOrderType.MARKET_ZERO_FEE,
        }
        order_type = order_type_map.get(body.order_type.upper(), TradeInputOrderType.MARKET)

        tx = await client.trade.build_trade_open_tx(trade_input, order_type, slippage_percentage=1)
        tx["nonce"] = await _fresh_nonce(agent_wallet)
        receipt = await client.sign_and_get_receipt(tx)

        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "block_number": receipt.blockNumber,
            "status": receipt.status,
            "order_type": body.order_type.upper(),
            "agent_wallet": agent_wallet,
            "pair": body.pair,
            "pair_index": pair_index,
            "direction": body.direction,
            "collateral": body.collateral,
            "leverage": body.leverage,
            "entry_price": live_price,
            "limit_price": body.open_price if is_limit else None,
            "tp_price": tp_price,
            "sl_price": sl_price,
            "opening_fee_usdc": float(opening_fee) if opening_fee is not None else None,
            "loss_protection_pct": loss_protection.percentage,
            "loss_protection_usdc": loss_protection.amount,
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"[execute_open] UNHANDLED EXCEPTION: {type(e).__name__}: {e}\n{tb}")
        raise HTTPException(status_code=500, detail=f"Trade open failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-close
# ─────────────────────────────────────────────

@router.post("/execute-close")
async def execute_close(body: CloseTradeRequest, _: str = Depends(verify_api_key)):
    using_cdp = bool(body.agent_wallet_address and _cdp_service_configured())
    if using_cdp:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
        client = CdpTraderClient(provider_url=_get_rpc_url(), agent_wallet_address=agent_wallet)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()
    try:
        # Fetch trade data before closing to get open_price, is_long, leverage
        trades, _ = await client.trade.get_trades(trader=agent_wallet)
        open_trade = next(
            (t for t in trades
             if getattr(t.trade if hasattr(t, "trade") else t, "trade_index", None) == body.trade_index
             and getattr(t.trade if hasattr(t, "trade") else t, "pair_index", None) == body.pair_index),
            None,
        )
        trade_obj = open_trade.trade if (open_trade and hasattr(open_trade, "trade")) else open_trade
        open_price = getattr(trade_obj, "open_price", None)
        is_long    = getattr(trade_obj, "is_long", None)
        leverage   = getattr(trade_obj, "leverage", None)

        # Fetch live price as exit price
        price_data = await client.trade.feed_client.get_price_update_data(body.pair_index)
        exit_price = price_data.core.price

        # Calculate PnL
        pnl = None
        if open_price and exit_price and leverage is not None and is_long is not None:
            price_delta_pct = (exit_price - open_price) / open_price
            if not is_long:
                price_delta_pct = -price_delta_pct
            pnl = round(price_delta_pct * leverage * body.collateral_to_close, 6)

        # Estimate closing fee (best-effort)
        closing_fee_usdc = None
        try:
            closing_fee_usdc = await client.fee_parameters.get_trade_closing_fee(
                pair_index=body.pair_index,
                trade_index=body.trade_index,
                collateral_to_close=body.collateral_to_close,
                trader=agent_wallet,
            )
        except Exception:
            pass

        tx = await client.trade.build_trade_close_tx(
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            collateral_to_close=body.collateral_to_close,
            trader=agent_wallet,
        )
        tx["nonce"] = await _fresh_nonce(agent_wallet)
        receipt = await client.sign_and_get_receipt(tx)
        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "block_number": receipt.blockNumber,
            "status": receipt.status,
            "trade_index": body.trade_index,
            "pair_index": body.pair_index,
            "entry_price": float(open_price) if open_price is not None else None,
            "collateral_closed": body.collateral_to_close,
            "exit_price": exit_price,
            "pnl": pnl,
            "closing_fee_usdc": float(closing_fee_usdc) if closing_fee_usdc is not None else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade close failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-update-tp-sl
# ─────────────────────────────────────────────

@router.post("/execute-update-tp-sl")
async def execute_update_tp_sl(body: UpdateTpSlRequest, _: str = Depends(verify_api_key)):
    using_cdp = bool(body.agent_wallet_address and _cdp_service_configured())
    if using_cdp:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
        client = CdpTraderClient(provider_url=_get_rpc_url(), agent_wallet_address=agent_wallet)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()
    try:
        tx = await client.trade.build_trade_tp_sl_update_tx(
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            take_profit_price=body.new_tp,
            stop_loss_price=body.new_sl,
            trader=agent_wallet,
        )
        tx["nonce"] = await _fresh_nonce(agent_wallet)
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
async def execute_update_margin(body: UpdateMarginRequest, _: str = Depends(verify_api_key)):
    using_cdp = bool(body.agent_wallet_address and _cdp_service_configured())
    if using_cdp:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
        client = CdpTraderClient(provider_url=_get_rpc_url(), agent_wallet_address=agent_wallet)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()
    try:
        if body.action.upper() not in ("DEPOSIT", "WITHDRAW"):
            raise HTTPException(status_code=400, detail="action must be DEPOSIT or WITHDRAW")
        if body.action.upper() == "DEPOSIT":
            allowance = await client.get_usdc_allowance_for_trading(agent_wallet)
            print(f"[margin_update] USDC allowance for {agent_wallet}: {allowance:.6f} USDC (required: {body.amount}) using_cdp={using_cdp}")
            if allowance < body.amount:
                if using_cdp:
                    spender = str(client.contracts["TradingStorage"].address)
                    print(f"[margin_update] Approving 10000 USDC for spender={spender} via CDP service")
                    await _cdp_svc_approve_usdc(agent_wallet, spender, body.amount)
                else:
                    await client.approve_usdc_for_trading(body.amount * 10)
        tx = await client.trade.build_trade_margin_update_tx(
            trader=agent_wallet,
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            margin_update_type=MarginUpdateType[body.action.upper()],
            collateral_change=body.amount,
        )
        tx["nonce"] = await _fresh_nonce(agent_wallet)
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
async def execute_cancel_limit(body: CancelLimitRequest, _: str = Depends(verify_api_key)):
    using_cdp = bool(body.agent_wallet_address and _cdp_service_configured())
    if using_cdp:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
        client = CdpTraderClient(provider_url=_get_rpc_url(), agent_wallet_address=agent_wallet)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()
    try:
        tx = await client.trade.build_order_cancel_tx(
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            trader=agent_wallet,
        )
        tx["nonce"] = await _fresh_nonce(agent_wallet)
        receipt = await client.sign_and_get_receipt(tx)
        return {
            "success": True,
            "tx_hash": receipt.transactionHash.hex(),
            "status": receipt.status,
            "trade_index": body.trade_index,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cancel limit failed: {str(e)}")


USDC_TRANSFER_ABI = [{
    "name": "transfer",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
    "outputs": [{"name": "", "type": "bool"}],
}]

# ─────────────────────────────────────────────
# POST /trade/fund-agent
# Returns unsigned ERC20 transfer calldata for user's RainbowKit wallet to sign
# ─────────────────────────────────────────────

@router.post("/fund-agent")
async def fund_agent(body: FundAgentRequest, _: str = Depends(verify_api_key)):
    # Use the CDP per-agent wallet address if provided, else fall back to local signer address
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
        calldata = usdc.encodeABI(fn_name="transfer", args=[
            Web3.to_checksum_address(agent_wallet),
            int(body.amount * 10 ** 6),
        ])
        return {
            "agent_wallet": agent_wallet,
            "amount_usdc": body.amount,
            "unsigned_tx": {
                "to": USDC_BASE_ADDRESS,
                "data": calldata,
                "value": "0x0",
                "chainId": 8453,
            },
            "instructions": f"Send {body.amount} USDC from {body.user_wallet_address} to agent wallet {agent_wallet}",
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fund agent tx build failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/withdraw
# Withdraw ETH or USDC from the agent wallet to any address
# ─────────────────────────────────────────────

@router.post("/withdraw")
async def withdraw_from_agent(body: WithdrawRequest, _: str = Depends(verify_api_key)):
    if body.asset.upper() not in ("ETH", "USDC"):
        raise HTTPException(status_code=400, detail="asset must be ETH or USDC")

    using_cdp = bool(body.agent_wallet_address and _cdp_service_configured())

    if using_cdp:
        agent_wallet = Web3.to_checksum_address(body.agent_wallet_address)
    else:
        client = _build_trader_client()
        agent_wallet = client.get_signer().get_ethereum_address()

    to_addr = Web3.to_checksum_address(body.to_address)

    try:
        w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(_get_rpc_url()))

        if body.asset.upper() == "ETH":
            if using_cdp:
                amount_wei = int(body.amount * 10 ** 18)
                tx_hash = await _cdp_svc_send_transaction(
                    wallet_address=agent_wallet,
                    to=to_addr,
                    data="0x",
                    value=amount_wei,
                )
                receipt = await w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
                tx_hash_str = tx_hash
            else:
                from eth_account import Account
                private_key = os.getenv("AGENT_WALLET_PRIVATE_KEY", "").strip().strip('"').strip("'")
                if not private_key.startswith("0x"):
                    private_key = "0x" + private_key
                amount_wei = int(body.amount * 10 ** 18)
                fee_data = await w3.eth.get_block("latest")
                base_fee = fee_data.get("baseFeePerGas", 1_000_000_000)
                nonce = await _fresh_nonce(agent_wallet)
                tx = {
                    "to": to_addr,
                    "value": amount_wei,
                    "data": "0x",
                    "nonce": nonce,
                    "gas": 21_000,
                    "maxPriorityFeePerGas": 1_000_000,
                    "maxFeePerGas": base_fee * 2 + 1_000_000,
                    "type": 2,
                    "chainId": 8453,
                }
                signed = Account.sign_transaction(tx, private_key)
                raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
                tx_hash_bytes = await w3.eth.send_raw_transaction(raw)
                receipt = await w3.eth.wait_for_transaction_receipt(tx_hash_bytes, timeout=120)
                tx_hash_str = receipt.transactionHash.hex()
        else:  # USDC
            w3_sync = Web3(Web3.HTTPProvider(_get_rpc_url()))
            usdc = w3_sync.eth.contract(
                address=Web3.to_checksum_address(USDC_BASE_ADDRESS),
                abi=USDC_TRANSFER_ABI,
            )
            amount_units = int(body.amount * 10 ** 6)
            calldata = usdc.encodeABI(fn_name="transfer", args=[to_addr, amount_units])
            if using_cdp:
                tx_hash = await _cdp_svc_send_transaction(
                    wallet_address=agent_wallet,
                    to=USDC_BASE_ADDRESS,
                    data=calldata,
                    value=0,
                )
                receipt = await w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
                tx_hash_str = tx_hash
            else:
                from eth_account import Account
                private_key = os.getenv("AGENT_WALLET_PRIVATE_KEY", "").strip().strip('"').strip("'")
                if not private_key.startswith("0x"):
                    private_key = "0x" + private_key
                fee_data = await w3.eth.get_block("latest")
                base_fee = fee_data.get("baseFeePerGas", 1_000_000_000)
                nonce = await _fresh_nonce(agent_wallet)
                tx = {
                    "to": USDC_BASE_ADDRESS,
                    "value": 0,
                    "data": calldata,
                    "nonce": nonce,
                    "gas": 100_000,
                    "maxPriorityFeePerGas": 1_000_000,
                    "maxFeePerGas": base_fee * 2 + 1_000_000,
                    "type": 2,
                    "chainId": 8453,
                }
                signed = Account.sign_transaction(tx, private_key)
                raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
                tx_hash_bytes = await w3.eth.send_raw_transaction(raw)
                receipt = await w3.eth.wait_for_transaction_receipt(tx_hash_bytes, timeout=120)
                tx_hash_str = receipt.transactionHash.hex()

        return {
            "success": True,
            "tx_hash": tx_hash_str,
            "asset": body.asset.upper(),
            "amount": body.amount,
            "from": agent_wallet,
            "to": to_addr,
            "status": receipt.status,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Withdraw failed: {str(e)}")
