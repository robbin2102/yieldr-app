"""Contracts at the production adapters; source math tests live in vendor/tests."""
import hashlib
import json
from pathlib import Path
from decimal import Decimal
from datetime import timedelta
import mongomock
from test_fresh_pipeline import Provider,scan,END,A,execute,payload
from engine import run_pipeline,SOURCE_HASHES
from inputs import Inputs
from protocol import serial

def test_vendor_is_exact_authoritative_source_and_import_closure():
    root=Path(__file__).resolve().parents[1]/'vendor'
    manifest=json.loads((root/'manifest.json').read_text())
    assert '/fomo-traders-analysis/' in manifest['source_path']
    assert (manifest['model_version'],manifest['rule_version'],manifest['analysis_version'])==('3.3.0','2026-09-09.2','0.1.0')
    for path,expected in manifest['files'].items():
        assert hashlib.sha256((root/path).read_bytes()).hexdigest()==expected
        assert path.endswith('.py')
    assert all(path in manifest['files'] for path in manifest['extraction_dependencies'])

def test_actual_v33_fifo_outcomes_and_source_provenance():
    out=run_pipeline(scan(),mongomock.MongoClient().test,Provider(),lambda *a,**k:None)
    assert out['result']['modelVersion']=='3.3.0'
    assert out['result']['sourceHashes']==SOURCE_HASHES
    buy=next(a for a in out['audit']['actions'] if a['side']=='BUY')
    assert buy['realized_economic_outcome']['realization_status']=='completed'
    assert Decimal(buy['realized_economic_outcome']['realized_return_pct'])==50
    assert out['stories'][0]['narrative']

def test_receipt_enrichment_and_solana_batch_parser(monkeypatch):
    import inputs as module
    from types import SimpleNamespace
    from scripts import enrich_recent_amounts as enrich
    db=mongomock.MongoClient(tz_aware=True).test
    provider=Inputs(db);provider.raw={'base':[],'solana':[]}
    calls=[]
    class Rpc:
        def call(self,method,params):calls.append(method);return {'logs':[]}
        def batch_call(self,method,params):return [self.call(method,p) for p in params]
    provider.rpcs={'base':Rpc(),'solana':Rpc()}
    base=Provider().extract(scan())[0]
    sol={**base,'chain':'solana','token_address_or_mint':'SolToken','quote_amount':'12'}
    def parse(rpc,wallet,cutoff):
        assert rpc.batch_call('getAccountInfo',[['metadata']])==[{'logs':[]}]
        return [sol],[]
    provider.audit=SimpleNamespace(evm_trades=lambda *a:([base],[]),solana_trades=parse)
    monkeypatch.setattr(enrich,'enrich_evm',lambda row,receipt,wallet:{**row,'atomic_usd':'20','amount_source':'test_receipt'})
    s=scan();s['linked_wallets']['solana']='linked-sol'
    rows=provider.extract(s)
    assert [r['atomic_usd'] for r in rows]==['20','12']
    assert 'eth_getTransactionReceipt' in calls and 'getAccountInfo' in calls

def test_holdings_use_queried_wallet_and_real_fifo_pnl(monkeypatch):
    import wallet_balances as source
    from fomo_analysis.inventory import InventoryEvent,replay_inventory
    db=mongomock.MongoClient(tz_aware=True).test;p=Inputs(db)
    p.rpcs={'base':object()};queried=[];token='0x'+'1'*40
    def balances(rpc,wallet,*args,**kwargs):queried.append(wallet);return [{'token_address':token,'quantity':Decimal(10),'symbol':'T'}]
    monkeypatch.setattr(source,'evm_balances',balances)
    monkeypatch.setattr(type(p.token_cache),'enrich',lambda *a,**k:{token:{'current_price_usd':'2','symbol':'T','market_data_status':'available'}})
    monkeypatch.setenv('COINGECKO_API_KEY','test-only')
    s=scan();s.update(chains_analyzed=['base'],analysis_trader_id='a')
    ledger=replay_inventory([InventoryEvent('buy','a','base',token,END-timedelta(days=1),'verified_purchase',Decimal(10),Decimal(10))])
    h=p.holdings(s,[],{('base',token):ledger})
    assert queried==[A] and h['items'][0]['wallet']==A and h['items'][0]['value']=='20'
    out=run_pipeline(scan(),db,Provider(),lambda *a,**k:None)
    # No matching trade rows yields no invented profit, even with a valued live balance.
    report=p.pnl_report(s,[],h,[],[])
    assert report['verified_trade_pnl']['total_trade_pnl_usd']=='0'
    assert report['coverage']['frozen_trade_ledger_through']==s['window_end']

def test_only_allowlisted_local_env_loaded(tmp_path,monkeypatch):
    from run_local import configure
    source=tmp_path/'source';app=tmp_path/'app'
    source.write_text('ALCHEMY_BASE_RPC_URL=test-only\nNEXT_PUBLIC_SECRET=never\nTARGET_WALLET=wrong\nUNRELATED=test\n')
    app.write_text('YIELDR_INTERNAL_SECRET=test-only\nMONGODB_URI=test-only\n')
    for name in ['NEXT_PUBLIC_SECRET','TARGET_WALLET','UNRELATED']:monkeypatch.delenv(name,raising=False)
    import os
    for name in ['ALCHEMY_BASE_RPC_URL','YIELDR_INTERNAL_SECRET','MONGODB_URI']:monkeypatch.setenv(name,'')
    configure(source,app)
    assert all(name not in os.environ for name in ['NEXT_PUBLIC_SECRET','TARGET_WALLET','UNRELATED'])
    # Undo mutations to avoid influencing other isolated tests.
    for name in ['ALCHEMY_BASE_RPC_URL','YIELDR_INTERNAL_SECRET','MONGODB_URI']:monkeypatch.delenv(name,raising=False)

def test_distinct_identical_amount_legs_are_not_dropped():
    class Multiple(Provider):
        def extract(self,scan):
            buy,sell=super().extract(scan)
            return [buy,dict(buy),{**sell,'token_amount':'20','quote_amount':'30'}]
    out=run_pipeline(scan(),mongomock.MongoClient().test,Multiple(),lambda *a,**k:None)
    assert out['positions'][0]['verifiedAcquisitionCostUsd']=='20'
    assert out['positions'][0]['realizedPnlUsd']=='10'

def test_candle_backfill_requests_only_missing_span(monkeypatch):
    import inputs as module
    from fomo_analysis.market_data import MarketWindow
    from fomo_analysis.models import Candle
    db=mongomock.MongoClient(tz_aware=True).test;start=END-timedelta(hours=1);calls=[]
    db.fomo_analysis_tokens.insert_one({'chain':'base','token_address':'token','pool_address':'pool'})
    def candle(at):return Candle('base','token',at,'5m',*[Decimal(1)]*4,1,'test','provider_native')
    for i in [0,3,4]:
        c=candle(start+timedelta(minutes=5*i));db.fomo_analysis_price_points_5m.insert_one({**serial(c.__dict__),'timestamp':c.open_time})
    class Client:
        def __init__(self,*a,**k):pass
        def pool_ohlcv_by_network_id(self,*args,**kw):
            calls.append(kw);return [candle(start+timedelta(minutes=i)) for i in [5,10]]
    monkeypatch.setenv('COINGECKO_API_KEY','test-only')
    monkeypatch.setattr(module,'CoinGeckoOnchainClient',Client)
    monkeypatch.setattr(module,'required_price_windows',lambda *a:[MarketWindow('base','token',start,start+timedelta(minutes=20))])
    rows,coverage=Inputs(db).candles(scan(),[])
    assert len(rows)==5 and coverage['missing_candles']==0
    assert len(calls)==1 and calls[0]['limit']==2
    assert calls[0]['before_timestamp']==int((start+timedelta(minutes=10)).timestamp())+1
    _,again=Inputs(db).candles(scan(),[])
    assert again['provider_calls']==0 and len(calls)==1
