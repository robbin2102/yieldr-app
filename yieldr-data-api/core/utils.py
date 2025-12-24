"""
Core utility functions for data processing and formatting.
"""

from datetime import datetime, timezone
from typing import Any, Optional


def safe_float(value: Any, default: float = 0.0) -> float:
    """
    Safely convert a value to float, returning default if conversion fails.

    Args:
        value: Value to convert (can be str, int, float, None, etc.)
        default: Default value to return if conversion fails

    Returns:
        float: Converted value or default

    Example:
        >>> safe_float("123.45")
        123.45
        >>> safe_float(None)
        0.0
        >>> safe_float("invalid", 10.0)
        10.0
    """
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (ValueError, TypeError):
        return default


def format_datetime(dt: Optional[datetime] = None, iso: bool = True) -> str:
    """
    Format datetime to string (ISO 8601 or human-readable).

    Args:
        dt: Datetime to format (defaults to current UTC time)
        iso: If True, return ISO 8601 format; else human-readable

    Returns:
        str: Formatted datetime string

    Example:
        >>> format_datetime(iso=True)
        '2024-01-15T10:30:45Z'
        >>> format_datetime(iso=False)
        '2024-01-15 10:30:45 UTC'
    """
    if dt is None:
        dt = datetime.now(timezone.utc)

    if iso:
        return dt.isoformat().replace("+00:00", "Z")
    else:
        return dt.strftime("%Y-%m-%d %H:%M:%S UTC")


def normalize_address(address: str) -> str:
    """
    Normalize Ethereum address to lowercase (for consistent comparisons).

    Args:
        address: Ethereum address (checksummed or not)

    Returns:
        str: Lowercase address

    Example:
        >>> normalize_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    """
    return address.lower().strip()
