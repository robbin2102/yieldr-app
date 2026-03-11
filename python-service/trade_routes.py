"""
Avantis Trade Execution Routes
Mounted at /trade/* in the python-service.
Agent signs transactions autonomously via LocalSigner (EOA private key in env).
"""

import os
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from web3 import AsyncWeb3, Web3

from avantis_trader_sdk import TraderClient
from avantis_trader_sdk.types import TradeInput, TradeInputOrderType, MarginUpdateType
from avantis_trader_sdk.signers.local_signer import LocalSigner

router = APIRouter()

# ─────────────────────────────────────────────
# Auth — simple API key header check
# ─────────────────────────────────────────────

async def verify_api_key(x_api_key: str = Header(..., alias="X-API-Key")):
    expected = os.getenv("API_KEY", "")
    if not expected or x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key


# ─────────────────────────────────────────────
# Signer + Client factory
# ─────────────────────────────────────────────

def _get_rpc_url() -> str:
    rpc = os.getenv("QUICKNODE_BASE_RPC_URL", "")
    if not rpc:
        raise HTTPException(status_code=503, detail="QUICKNODE_BASE_RPC_URL is not configured")
    return rpc


def _build_trader_client() -> TraderClient:
    rpc_url = _get_rpc_url()
    private_key = os.getenv("AGENT_WALLET_PRIVATE_KEY", "").strip().strip('"').strip("'")
    if not private_key:
        raise HTTPException(status_code=503, detail="AGENT_WALLET_PRIVATE_KEY is not configured")
    if not private_key.startswith("0x"):
        private_key = "0x" + private_key
    async_web3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(rpc_url, request_kwargs={"timeout": 60}))
    signer = LocalSigner(private_key, async_web3)
    return TraderClient(provider_url=rpc_url, signer=signer)


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
    direction: str          # "long" | "short"
    collateral: float       # USDC
    leverage: float
    tp_pct: float           # % above/below entry
    sl_pct: float
    order_type: str = "MARKET"
    open_price: Optional[float] = None


class CloseTradeRequest(BaseModel):
    trade_index: int
    pair_index: int
    collateral_to_close: float


class UpdateTpSlRequest(BaseModel):
    trade_index: int
    pair_index: int
    new_tp: float
    new_sl: float


class UpdateMarginRequest(BaseModel):
    trade_index: int
    pair_index: int
    amount: float
    action: str             # "DEPOSIT" | "WITHDRAW"


class CancelLimitRequest(BaseModel):
    order_index: int
    pair_index: int


class FundAgentRequest(BaseModel):
    amount: float
    user_wallet_address: str


# ─────────────────────────────────────────────
# GET /trade/balance
# ─────────────────────────────────────────────

@router.get("/balance")
async def get_balance(_: str = Depends(verify_api_key)):
    client = _build_trader_client()
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
        raise HTTPException(status_code=500, detail=f"Balance fetch failed: {str(e)}")


# ─────────────────────────────────────────────
# GET /trade/positions
# ─────────────────────────────────────────────

@router.get("/positions")
async def get_positions(_: str = Depends(verify_api_key)):
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
        opening_fee = await client.fee_parameters.get_opening_fee(
            position_size=collateral * leverage,
            is_long=is_long,
            pair_index=pair_index,
        )
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
    position_size = body.collateral * body.leverage
    if position_size < MIN_POSITION_SIZE_USDC:
        raise HTTPException(
            status_code=400,
            detail=f"Position size ${position_size:.2f} is below Avantis minimum of ${MIN_POSITION_SIZE_USDC:.0f} USDC. "
                   f"Increase collateral or leverage (e.g. collateral=10, leverage=10 → $100).",
        )

    client = _build_trader_client()
    agent_wallet = client.get_signer().get_ethereum_address()
    try:
        pair_index = await client.pairs_cache.get_pair_index(body.pair)
        is_long = body.direction.lower() == "long"

        # Fetch live price to compute TP/SL
        price_data = await client.trade.feed_client.get_price_update_data(pair_index)
        entry_price = price_data.core.price

        tp_price = entry_price * (1 + body.tp_pct / 100) if is_long else entry_price * (1 - body.tp_pct / 100)
        sl_price = entry_price * (1 - body.sl_pct / 100) if is_long else entry_price * (1 + body.sl_pct / 100)

        # Approve USDC if needed
        allowance = await client.get_usdc_allowance_for_trading(agent_wallet)
        if allowance < body.collateral:
            await client.approve_usdc_for_trading(body.collateral * 10)

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

        opening_fee = await client.fee_parameters.get_opening_fee(
            position_size=body.collateral * body.leverage,
            is_long=is_long,
            pair_index=pair_index,
        )
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
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Trade open failed: {str(e)}")


# ─────────────────────────────────────────────
# POST /trade/execute-close
# ─────────────────────────────────────────────

@router.post("/execute-close")
async def execute_close(body: CloseTradeRequest, _: str = Depends(verify_api_key)):
    client = _build_trader_client()
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
async def execute_update_tp_sl(body: UpdateTpSlRequest, _: str = Depends(verify_api_key)):
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
    client = _build_trader_client()
    agent_wallet = client.get_signer().get_ethereum_address()
    try:
        if body.action.upper() not in ("DEPOSIT", "WITHDRAW"):
            raise HTTPException(status_code=400, detail="action must be DEPOSIT or WITHDRAW")
        if body.action.upper() == "DEPOSIT":
            allowance = await client.get_usdc_allowance_for_trading(agent_wallet)
            if allowance < body.amount:
                await client.approve_usdc_for_trading(body.amount * 10)
        tx = await client.trade.build_trade_margin_update_tx(
            trader=agent_wallet,
            pair_index=body.pair_index,
            trade_index=body.trade_index,
            margin_update_type=MarginUpdateType[body.action.upper()],
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
async def execute_cancel_limit(body: CancelLimitRequest, _: str = Depends(verify_api_key)):
    client = _build_trader_client()
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
# POST /trade/fund-agent
# Returns unsigned ERC20 transfer calldata for user's RainbowKit wallet to sign
# ─────────────────────────────────────────────

USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_TRANSFER_ABI = [{
    "name": "transfer",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
    "outputs": [{"name": "", "type": "bool"}],
}]

@router.post("/fund-agent")
async def fund_agent(body: FundAgentRequest, _: str = Depends(verify_api_key)):
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
