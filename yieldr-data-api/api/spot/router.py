"""
Router for spot trading endpoints.
"""

from fastapi import APIRouter
from api.spot import scan

router = APIRouter(prefix="/spot", tags=["Spot Trading"])

# Register endpoints
router.include_router(scan.router)
