"""Real engine + isolated provider fixtures, never reachable from production."""
from datetime import datetime,timedelta,timezone
from copy import deepcopy
import uuid
import mongomock
import pytest
from worker import process_one
from protocol import STAGES,serial
from inputs import Inputs
A='0x'+'a'*40;B='0x'+'b'*40
END=datetime(2026,10,12,12,tzinfo=timezone.utc)
def scan(wallet=A,end=END,force=False):
    sid=uuid.uuid4().hex*2
    return {'_id':sid,'kind':'fresh_scan','contract_version':1,'scan_id':sid,'input_wallet':wallet,'normalized_wallet':wallet,'wallet_type':'evm',
      'linked_wallets':{'evm':wallet,'solana':None},'window_start':serial(end-timedelta(days=90)),'window_end':serial(end),
      'scan_started_at':serial(end),'force_fresh':force,'status':'running','lease_owner':uuid.uuid4().hex,'completed_stages':[],
      'counts':{},'classification':'known_fomo_analysis_pending'}
class Provider:
    def __init__(self,empty=False,unpriced=False):self.empty=empty;self.unpriced=unpriced;self.calls=[]
    def fetch(self,scan):self.calls.append(scan['normalized_wallet']);return 2
    def extract(self,scan):
        if self.empty:return []
        return [{'timestamp':serial(END-timedelta(days=2-i)),'chain':'base','side':'BUY' if i==0 else 'SELL',
             'token_address_or_mint':'0x'+'1'*40,'token_symbol':'T','token_amount':'10','quote_symbol':'USDC',
             'quote_amount':None if self.unpriced else ('10' if i==0 else '15'),'transaction_id':f"{scan['normalized_wallet']}:{i}",'fomo_evidence':'TOKEN_CREDIT_FROM_SETTLEMENT' if i==0 else 'TOKEN_DEBIT_TO_SETTLEMENT'} for i in range(2)]
    def external_inventory(self,scan,trades):return [],set()
    def candles(self,scan,trades):return [],{'missing_windows':1,'provider_calls':0}
    def holdings(self,scan,episodes,ledgers):return {'status':'available','source':'test-provider','stale':False,'observedAt':serial(END+timedelta(minutes=1)),
        'items':[{'wallet':scan['normalized_wallet'],'chain':'base','tokenAddress':'0x'+'2'*40,'symbol':'H','quantity':'2','price':None,'value':None,'costBasis':None,'costBasisStatus':'unknown_cost_inventory','openEpisodeIds':[],'externalReceipt':None}]}
@pytest.fixture
def db():return mongomock.MongoClient(tz_aware=True).yieldr_edge_test

def execute(db,s=None,provider=None):
    s=s or scan();db.fomo_analysis_edge_scan_runs.insert_one(deepcopy(s));process_one(db,s,provider or Provider())
    return db.fomo_analysis_edge_scan_runs.find_one({'_id':s['_id']}),list(db.fomo_analysis_edge_scan_outputs.find({'scan_id':s['scan_id']}))
def payload(rows,kind):return next(r['payload'] for r in rows if r['kind']==kind)

def test_wallet_a_never_uses_b_summary(db):
    db.fomo_analysis_trader_pattern_summaries.insert_one({'trader_id':'wallet-b','summary_id':'B','realized_pnl':999999})
    row,out=execute(db);assert row['status']=='completed',row.get('failure')
    assert payload(out,'result')['identity']['evmWallet']==A
    assert payload(out,'result')['summaryId']==row['scan_id']
    assert payload(out,'result')['performance']['realizedPnl']=='5'

def test_top_traders_cannot_supply_main_output(db):
    db.fomo_analysis_traders.insert_one({'trader_id':'ranked','evm_wallet':B,'username':'Top'})
    row,out=execute(db);assert payload(out,'result')['identity']['evmWallet']==A
    assert db.fomo_analysis_traders.count_documents({})==1
    assert db.fomo_analysis_trader_pattern_summaries.count_documents({})==0

def test_no_prior_summary_is_required(db):
    row,out=execute(db);assert row['status']=='completed',row.get('failure')
    assert [s['key'] for s in row['completed_stages']]==STAGES

def test_stale_analysis_creates_new_timestamp_and_recomputation(db):
    db.fomo_analysis_trader_pattern_summaries.insert_one({'trader_id':'a','computed_at':'2020-01-01'})
    first,_=execute(db);second,_=execute(db,scan(end=END+timedelta(seconds=1)))
    assert first['scan_id']!=second['scan_id'] and first['window_end']!=second['window_end']

def test_low_history_is_observed_not_validated(db):
    row,out=execute(db);r=payload(out,'result')
    assert r['classification']=='insufficient_behavior_sample' and r['closedPositions']==1
    assert not any(f['status'].startswith('validated_') for f in r['findings'])
    assert any(f['status']=='observed_behavior' for f in r['findings'])

def test_unrecognized_wallet_fails_without_substitution(db):
    row,out=execute(db,provider=Provider(empty=True));assert row['failure']['code']=='non_fomo_or_unindexed' and not out

def test_missing_ohlc_keeps_ledger_but_not_price_path_claims(db):
    row,out=execute(db,provider=Provider(unpriced=True));assert row['status']=='completed',row.get('failure')
    p=payload(out,'positions');assert p['realizedPnlUsd'] is None and not p['includedInDollarTotals']
    assert payload(out,'result')['readiness']['status']!='ready'
    assert payload(out,'result')['performance']['realizedPnl'] is None

def test_current_holdings_belong_to_submitted_wallet(db):
    row,out=execute(db);assert payload(out,'holdings')['items'][0]['wallet']==A
    assert payload(out,'holdings')['observedAt']>=row['window_end']

def test_dots_are_wallet_and_window_scoped(db):
    row,out=execute(db)
    for doc in [d for d in out if d['kind']=='positions']:
        assert doc['normalized_wallet']==A and doc['scan_id']==row['scan_id'] and A in doc['payload']['episodeId']
        assert row['window_start']<=doc['payload']['closedAt']<=row['window_end']

def test_force_fresh_recomputes_even_with_existing_result(db):
    provider=Provider();first,_=execute(db,provider=provider);second,_=execute(db,scan(force=True),provider)
    assert provider.calls==[A,A] and second['force_fresh'] and first['scan_id']!=second['scan_id']

def test_missing_source_blocks_before_any_chain_request(db,monkeypatch):
    import bootstrap
    monkeypatch.setattr(bootstrap,"missing_source",lambda:["scripts/parse_solana_trades.py"])
    row,out=execute(db,provider=Inputs(db));assert row['failure']['code']=='extraction_source_missing' and not out
    assert [s['key'] for s in row['completed_stages']]==STAGES[:3]

def test_wrong_holdings_wallet_is_rejected(db):
    class Wrong(Provider):
        def holdings(self,*args):
            result=super().holdings(*args);result['items'][0]['wallet']=B;return result
    row,out=execute(db,provider=Wrong());assert row['failure']['code']=='holdings_ownership_mismatch' and not out

def test_known_empty_wallet_still_runs_full_pipeline(db):
    db.fomo_analysis_traders.insert_one({'trader_id':'known','evm_wallet':A})
    row,out=execute(db,provider=Provider(empty=True));assert row['status']=='completed',row.get('failure')
    assert payload(out,'result')['classification']=='insufficient_behavior_sample' and row['counts']['closed_positions']==0

def test_transaction_cache_is_idempotent_and_fetches_only_delta(db,monkeypatch):
    import inputs as module
    from types import SimpleNamespace
    calls=[]
    raw={'hash':'0xfeed','from':A,'to':B,'metadata':{'blockTimestamp':serial(END-timedelta(days=1))},'rawContract':{'address':'0x'+'1'*40}}
    def fetch(rpc,wallet,direction,cutoff):
        calls.append(cutoff);return [raw]
    monkeypatch.setattr(module.bootstrap,'missing_source',lambda:[])
    monkeypatch.setattr(module.importlib,'import_module',lambda name:SimpleNamespace(fetch_evm_direction=fetch))
    monkeypatch.setenv('ALCHEMY_BASE_RPC_URL','https://example.invalid/test-only')
    s=scan();s.update(chains_analyzed=['base'])
    Inputs(db).fetch(s);first_start=calls[0]
    Inputs(db).fetch(s)
    assert db.fomo_analysis_edge_transaction_evidence.count_documents({})==1
    assert calls[-1]>first_start

def test_complete_mongo_candles_are_reused_without_enqueue(db):
    from fomo_analysis.models import NormalizedTrade
    from fomo_analysis.market_data import required_price_windows
    from decimal import Decimal
    from bson.decimal128 import Decimal128
    trade=NormalizedTrade('a',A,'base','tx',0,END-timedelta(days=1),'BUY','token','T',Decimal(1),Decimal(1),Decimal(1),'quote','settlement')
    windows=required_price_windows([trade],END)
    for w in windows:
        at=w.start
        while at<=w.end:
            doc={'chain':w.chain,'token_address':w.token_address,'timestamp':at,'interval':'5m',**{k:Decimal128('1') for k in ['open','high','low','close']},'quality':'provider_native'}
            db.fomo_analysis_price_points_5m.insert_one(doc);at+=timedelta(minutes=5)
    first,coverage=Inputs(db).candles(scan(),[trade]);second,_=Inputs(db).candles(scan(force=True),[trade])
    assert first and len(first)==len(second) and coverage['provider_calls']==0
    assert db.fomo_analysis_edge_candle_jobs.count_documents({})==0

def test_submitted_wallet_scope_ignores_linked_companion_and_logs_result(db):
    sol='GkppTxihoHLNug82HFRyH4mC1ReECgmf2qu3UxufNM7B'
    db.fomo_analysis_traders.insert_one({'evm_wallet':A,'solana_wallet':sol,'username':'paired'})
    row,out=execute(db)
    assert row['linked_wallets']=={'evm':A,'solana':None}
    assert row['scope']=='submitted_wallet'
    log=db.fomo_analysis_edge_analysis_logs.find_one({'scan_id':row['scan_id']})
    assert log['generation']==row['result_generation'] and log['findings']
    assert log['performance']==payload(out,'result')['performance']
    assert row['preview']['positions'] and row['preview']['actionsProcessed']==2

def test_open_episodes_reconcile_transfers_and_current_balances(db):
    from concurrent.futures import Future
    from types import SimpleNamespace
    from decimal import Decimal
    p=Inputs(db);p.holdings_future=Future()
    p.holdings_future.set_result({'items':[{'chain':'base','tokenAddress':'a','quantity':'1','openEpisodeIds':[]}],'status':'available'})
    class Episode:
        chain='base';closed_at=None
        def __init__(self,token):self.token_address=token
        def as_document(self):return {'episode_id':self.token_address}
    ledger=SimpleNamespace(transfer_out_quantity=Decimal(10),known_cost_quantity=Decimal(0),unknown_cost_quantity=Decimal(0))
    h=p.final_holdings({},[Episode('a'),Episode('b')],{('base','b'):ledger})
    assert h['items'][0]['openEpisodeIds']==['a']
    assert [r['status'] for r in h['reconciliation']]==['current_balance','transferred_out']
