from datetime import datetime, timezone
from decimal import Decimal
import re

STAGES = ['validate_wallet','resolve_fomo_identity','resolve_linked_wallets','fetch_90d_chain_activity',
'extract_fomo_trade_legs','reconcile_trade_legs','deduplicate_economic_actions','classify_external_inventory',
'reconstruct_fifo_inventory','build_position_episodes','load_or_backfill_ohlc','compute_action_features',
'compute_episode_features','evaluate_pattern_catalog','apply_validation_and_readiness_gates',
'build_action_assessments','build_position_stories','fetch_current_holdings','compute_edge_print','persist_completed_scan']
class ScanFailure(Exception):
    def __init__(self, code, message):
        super().__init__(code)
        self.code, self.safe_message = code, message

def now(): return datetime.now(timezone.utc)
def iso(value): return value.isoformat() if isinstance(value,datetime) else value
def time(value): return datetime.fromisoformat(value.replace('Z','+00:00')) if isinstance(value,str) else value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value

def normalize_wallet(value):
    if re.fullmatch(r'0x[0-9a-fA-F]{40}',value): return value.lower(),'evm'
    alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    if 32<=len(value)<=44 and all(c in alphabet for c in value):
        n=0
        for c in value:n=n*58+alphabet.index(c)
        if (n.bit_length()+7)//8 + len(value)-len(value.lstrip('1')) == 32:return value,'solana'
    raise ScanFailure('invalid_wallet','Enter a valid EVM or Solana wallet address.')

def serial(value):
    if isinstance(value,datetime):return iso(value)
    if isinstance(value,Decimal):return format(value,'f')
    if hasattr(value,'to_decimal'):return format(value.to_decimal(),'f')
    if isinstance(value,dict):return {k:serial(v) for k,v in value.items() if k!='_id'}
    if isinstance(value,(list,tuple)):return [serial(v) for v in value]
    return value

def decimal(value):
    return None if value is None else format(Decimal(str(value)),'f')
