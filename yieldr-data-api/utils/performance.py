"""
Performance Metrics Computation

Computes trader performance metrics from swap history:
- PnL (1d, 7d, 30d)
- ROI percentages
- Win rate
- Risk metrics (Sharpe ratio, max drawdown)
- Asset-level performance
"""

from typing import Dict, Any, List
from datetime import datetime, timedelta
import math


def compute_trader_performance(
    swaps: List[Dict[str, Any]],
    current_holdings: Dict[str, float]  # token_address -> amount
) -> Dict[str, Any]:
    """
    Compute comprehensive performance metrics for a trader.

    Args:
        swaps: List of swap transactions (sorted by timestamp desc)
        current_holdings: Current token holdings {token_address: amount}

    Returns:
        Performance metrics dict matching schema in models/schemas.py
    """
    if not swaps:
        return _empty_performance()

    # Time cutoffs
    now = datetime.utcnow()
    cutoff_1d = now - timedelta(days=1)
    cutoff_7d = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    # Filter swaps by timeframe
    swaps_1d = [s for s in swaps if s.get("timestamp", now) >= cutoff_1d]
    swaps_7d = [s for s in swaps if s.get("timestamp", now) >= cutoff_7d]
    swaps_30d = [s for s in swaps if s.get("timestamp", now) >= cutoff_30d]

    # Compute PnL for each timeframe
    pnl_1d = _compute_period_pnl(swaps_1d)
    pnl_7d = _compute_period_pnl(swaps_7d)
    pnl_30d = _compute_period_pnl(swaps_30d)

    # Compute win rate
    win_rate_data = _compute_win_rate(swaps_30d)

    # Compute average win/loss
    avg_metrics = _compute_avg_metrics(swaps_30d)

    # Compute risk metrics
    risk_metrics = _compute_risk_metrics(swaps_30d)

    # Total AUM (value of current holdings)
    total_aum = sum(current_holdings.values())

    # ROI calculation (based on 30d PnL)
    roi_30d_pct = (pnl_30d / total_aum * 100) if total_aum > 0 else 0.0
    roi_7d_pct = (pnl_7d / total_aum * 100) if total_aum > 0 else 0.0
    roi_1d_pct = (pnl_1d / total_aum * 100) if total_aum > 0 else 0.0

    return {
        "total_aum_usd": round(total_aum, 2),
        "total_positions": len(current_holdings),
        "roi_1d_pct": round(roi_1d_pct, 2),
        "roi_7d_pct": round(roi_7d_pct, 2),
        "roi_30d_pct": round(roi_30d_pct, 2),
        "pnl_1d_usd": round(pnl_1d, 2),
        "pnl_7d_usd": round(pnl_7d, 2),
        "pnl_30d_usd": round(pnl_30d, 2),
        "win_rate_pct": round(win_rate_data["win_rate"], 2),
        "total_trades": win_rate_data["total"],
        "total_wins": win_rate_data["wins"],
        "total_losses": win_rate_data["losses"],
        "avg_win_usd": round(avg_metrics["avg_win"], 2),
        "avg_loss_usd": round(avg_metrics["avg_loss"], 2),
        "best_trade_usd": round(avg_metrics["best_trade"], 2),
        "best_trade_token": avg_metrics["best_trade_token"],
        "worst_trade_usd": round(avg_metrics["worst_trade"], 2),
        "worst_trade_token": avg_metrics["worst_trade_token"],
        "sharpe_ratio": round(risk_metrics["sharpe"], 2),
        "max_drawdown_pct": round(risk_metrics["max_drawdown"], 2),
        "avg_leverage": 1.0,  # Base DEX = spot only, no leverage
        "max_leverage": 1.0
    }


def compute_asset_performance(
    swaps: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Compute performance breakdown by asset.

    Args:
        swaps: List of swap transactions

    Returns:
        List of asset performance objects
    """
    if not swaps:
        return []

    # Group swaps by token
    token_swaps = {}
    for swap in swaps:
        token = swap.get("token_address")
        symbol = swap.get("token_symbol", "UNKNOWN")

        if token not in token_swaps:
            token_swaps[token] = {
                "symbol": symbol,
                "swaps": []
            }

        token_swaps[token]["swaps"].append(swap)

    # Compute metrics for each token
    asset_performance = []

    for token, data in token_swaps.items():
        swaps_list = data["swaps"]
        symbol = data["symbol"]

        # Group into buy/sell pairs to compute trades
        trades = _pair_buy_sell_swaps(swaps_list)

        total_trades = len(trades)
        wins = sum(1 for t in trades if t["pnl"] > 0)
        losses = total_trades - wins

        win_rate = (wins / total_trades * 100) if total_trades > 0 else 0.0

        # Best/worst
        pnls = [t["pnl"] for t in trades] if trades else [0]
        best_win = max(pnls) if pnls else 0.0
        worst_loss = min(pnls) if pnls else 0.0
        total_pnl = sum(pnls)

        asset_performance.append({
            "asset_symbol": symbol,
            "trades": total_trades,
            "win_rate_pct": round(win_rate, 2),
            "best_win_usd": round(best_win, 2),
            "worst_loss_usd": round(worst_loss, 2),
            "pnl_usd": round(total_pnl, 2)
        })

    # Sort by PnL descending
    asset_performance.sort(key=lambda x: x["pnl_usd"], reverse=True)

    return asset_performance


def _empty_performance() -> Dict[str, Any]:
    """Return empty performance metrics."""
    return {
        "total_aum_usd": 0.0,
        "total_positions": 0,
        "roi_1d_pct": 0.0,
        "roi_7d_pct": 0.0,
        "roi_30d_pct": 0.0,
        "pnl_1d_usd": 0.0,
        "pnl_7d_usd": 0.0,
        "pnl_30d_usd": 0.0,
        "win_rate_pct": 0.0,
        "total_trades": 0,
        "total_wins": 0,
        "total_losses": 0,
        "avg_win_usd": 0.0,
        "avg_loss_usd": 0.0,
        "best_trade_usd": 0.0,
        "best_trade_token": None,
        "worst_trade_usd": 0.0,
        "worst_trade_token": None,
        "sharpe_ratio": 0.0,
        "max_drawdown_pct": 0.0,
        "avg_leverage": 1.0,
        "max_leverage": 1.0
    }


def _compute_period_pnl(swaps: List[Dict[str, Any]]) -> float:
    """Compute total PnL for a period."""
    pnl = 0.0

    for swap in swaps:
        value = swap.get("value_usd", 0) or 0
        swap_type = swap.get("type", "")

        if swap_type == "buy":
            pnl -= value  # Cost
        elif swap_type == "sell":
            pnl += value  # Revenue

    return pnl


def _compute_win_rate(swaps: List[Dict[str, Any]]) -> Dict[str, int]:
    """Compute win rate from swaps."""
    trades = _pair_buy_sell_swaps(swaps)

    wins = sum(1 for t in trades if t["pnl"] > 0)
    losses = len(trades) - wins

    win_rate = (wins / len(trades) * 100) if trades else 0.0

    return {
        "total": len(trades),
        "wins": wins,
        "losses": losses,
        "win_rate": win_rate
    }


def _compute_avg_metrics(swaps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute average win/loss metrics."""
    trades = _pair_buy_sell_swaps(swaps)

    if not trades:
        return {
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "best_trade": 0.0,
            "best_trade_token": None,
            "worst_trade": 0.0,
            "worst_trade_token": None
        }

    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]

    avg_win = sum(t["pnl"] for t in wins) / len(wins) if wins else 0.0
    avg_loss = sum(t["pnl"] for t in losses) / len(losses) if losses else 0.0

    # Best/worst
    best_trade = max(trades, key=lambda t: t["pnl"])
    worst_trade = min(trades, key=lambda t: t["pnl"])

    return {
        "avg_win": avg_win,
        "avg_loss": abs(avg_loss),
        "best_trade": best_trade["pnl"],
        "best_trade_token": best_trade["token_symbol"],
        "worst_trade": worst_trade["pnl"],
        "worst_trade_token": worst_trade["token_symbol"]
    }


def _compute_risk_metrics(swaps: List[Dict[str, Any]]) -> Dict[str, float]:
    """Compute risk metrics (Sharpe ratio, max drawdown)."""
    trades = _pair_buy_sell_swaps(swaps)

    if not trades:
        return {"sharpe": 0.0, "max_drawdown": 0.0}

    # Daily returns (approximate)
    returns = [t["pnl"] for t in trades]

    # Sharpe ratio (simplified: return/risk)
    avg_return = sum(returns) / len(returns) if returns else 0.0
    std_dev = _std_deviation(returns) if len(returns) > 1 else 1.0

    sharpe = (avg_return / std_dev) if std_dev > 0 else 0.0

    # Max drawdown
    cumulative_pnl = 0.0
    peak = 0.0
    max_dd = 0.0

    for ret in returns:
        cumulative_pnl += ret
        peak = max(peak, cumulative_pnl)
        drawdown = peak - cumulative_pnl
        max_dd = max(max_dd, drawdown)

    max_drawdown_pct = (max_dd / peak * 100) if peak > 0 else 0.0

    return {
        "sharpe": sharpe,
        "max_drawdown": max_drawdown_pct
    }


def _pair_buy_sell_swaps(swaps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Pair buy/sell swaps into trades.

    Simplified: Assume each sell following a buy is a completed trade.
    This is a rough approximation - proper PnL tracking requires FIFO/LIFO accounting.

    Returns:
        List of trade objects with PnL
    """
    trades = []
    token_positions = {}  # token -> {cost_basis, amount}

    # Sort by timestamp
    sorted_swaps = sorted(swaps, key=lambda s: s.get("timestamp", datetime.min))

    for swap in sorted_swaps:
        token = swap.get("token_address")
        symbol = swap.get("token_symbol", "UNKNOWN")
        swap_type = swap.get("type")
        value = swap.get("value_usd", 0) or 0
        amount = swap.get("amount", 0)

        if swap_type == "buy":
            # Add to position
            if token not in token_positions:
                token_positions[token] = {"cost_basis": 0.0, "amount": 0.0, "symbol": symbol}

            token_positions[token]["cost_basis"] += value
            token_positions[token]["amount"] += amount

        elif swap_type == "sell" and token in token_positions:
            # Close position (simplified: sell entire position)
            position = token_positions[token]
            pnl = value - position["cost_basis"]

            trades.append({
                "token_symbol": symbol,
                "pnl": pnl
            })

            # Remove position
            del token_positions[token]

    return trades


def _std_deviation(values: List[float]) -> float:
    """Calculate standard deviation."""
    if len(values) < 2:
        return 0.0

    mean = sum(values) / len(values)
    variance = sum((x - mean) ** 2 for x in values) / (len(values) - 1)

    return math.sqrt(variance)
