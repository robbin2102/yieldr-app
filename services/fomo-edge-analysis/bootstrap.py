"""Use the audited Python source, never a TypeScript port of its economics."""
import os
import sys
from pathlib import Path
ROOT = Path(os.environ.get('FOMO_ENGINE_ROOT', Path(__file__).parent / 'vendor')).resolve()
sys.path.insert(0, str(ROOT))
MISSING = ['scripts/extract_fomo_trades.py','scripts/fetch_wallet_transfers.py','scripts/parse_solana_trades.py','fomo_analysis/v3_3_pattern_engine.py','fomo_analysis/v3_3_economics.py','fomo_analysis/v3_3_stories.py','fomo_analysis/pnl_reporting.py']
def missing_source():
    return [p for p in MISSING if not (ROOT / p).is_file()]
