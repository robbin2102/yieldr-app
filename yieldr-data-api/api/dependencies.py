"""
API dependencies for authentication and authorization.
"""

from fastapi import Header, HTTPException, status
from config import get_settings

settings = get_settings()


async def verify_api_key(x_api_key: str = Header(..., alias="X-API-Key")):
    """
    Verify API key from request header.

    Args:
        x_api_key: API key from X-API-Key header

    Raises:
        HTTPException: 401 if API key is invalid

    Returns:
        str: The verified API key
    """
    if x_api_key != settings.api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key"
        )
    return x_api_key
