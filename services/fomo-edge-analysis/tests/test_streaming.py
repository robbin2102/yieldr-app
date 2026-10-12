from copy import deepcopy
from decimal import Decimal
from threading import Event
from concurrent.futures import ThreadPoolExecutor
import mongomock
from inputs import Inputs
from token_cache import TokenCache
from wallet_balances import evm_balances
from test_token_cache import Client
from test_fresh_pipeline import scan,END


def test_bulk_metadata_yields_balances_before_rpc_fallback():
    db=mongomock.MongoClient(tz_aware=True).test;client=Client();cache=TokenCache(db,client);seen=[]
    class Rpc:
        def call(self,method,params):return {'tokenBalances':[{'contractAddress':str(i),'tokenBalance':hex(10**9)} for i in range(35)]}
        def batch_call(self,*a):raise AssertionError('Bulk provider already supplied decimals')
    rows=evm_balances(Rpc(),'wallet',cache,'base',on_batch=lambda rows:seen.append(len(rows)))
    assert len(rows)==35 and 30 in seen and seen[-1]==35
    assert len(client.calls)==2 and all(r['quantity']==1 for r in rows)


def test_one_slow_chain_does_not_hold_other_coins(monkeypatch):
    import wallet_balances
    db=mongomock.MongoClient(tz_aware=True).test;p=Inputs(db);p.rpcs={'base':object(),'bnb':object()}
    first=Event();release=Event();snapshots=[]
    def balances(rpc,wallet,cache,chain,**kwargs):
        if chain=='bnb':assert release.wait(3)
        return [{'token_address':chain,'symbol':chain,'quantity':Decimal(20)}]
    monkeypatch.setattr(wallet_balances,'evm_balances',balances)
    monkeypatch.setattr(TokenCache,'enrich',lambda self,chain,addresses,**kw:{chain:{'current_price_usd':'2','symbol':chain}})
    def preview(**kw):
        snapshots.append(deepcopy(kw['holdings']))
        if any(h['chain']=='base' and h['value']=='40' for h in kw['holdings']['items']):first.set()
    p.preview=preview;s=scan();s['chains_analyzed']=['base','bnb']
    with ThreadPoolExecutor() as pool:
        f=pool.submit(p.holdings,s,[],{})
        try:assert first.wait(2);assert not f.done()
        finally:release.set()
        assert len(f.result()['items'])==2
    assert any(len(x['items'])==1 for x in snapshots)


def test_history_publishes_pages_before_fetch_finishes(monkeypatch):
    import inputs
    from protocol import serial
    calls=[];previews=[]
    class Rpc:
        def __init__(self,*a,**k):pass
        def call(self,method,params):
            calls.append(params)
            if len(calls)==2:assert previews and previews[0]['liveProgress']['current']==1
            return {'transfers':[{'hash':str(len(calls)),'metadata':{'blockTimestamp':serial(END)}}],**({'pageKey':'next'} if len(calls)==1 else {})}
    monkeypatch.setattr(inputs,'RpcClient',Rpc);monkeypatch.setenv('ALCHEMY_BASE_RPC_URL','test')
    p=Inputs(mongomock.MongoClient(tz_aware=True).test)
    # Avoid balance I/O in this history-only test.
    p.holdings=lambda *a:None;p.preview=lambda **kw:previews.append(kw)
    s=scan();s['chains_analyzed']=['base']
    assert p.fetch(s)==3
    assert all(q[0]['maxCount']=='0x64' for q in calls)
    assert previews[-1]['liveProgress']['current']==3
    p.enrichment.shutdown()


def test_positions_stream_as_each_market_window_finishes(monkeypatch):
    import inputs
    from types import SimpleNamespace
    from datetime import timedelta
    from protocol import now
    p=Inputs(mongomock.MongoClient(tz_aware=True).test);seen=[]
    p.preview_positions=[{'chain':'base','tokenAddress':a} for a in ['a','b']]
    p.preview=lambda **fields:seen.append(fields)
    at=now()-timedelta(hours=1)
    windows=[SimpleNamespace(chain='base',token_address=a) for a in ['a','b']]
    monkeypatch.setattr(inputs,'required_price_windows',lambda *a:windows)
    monkeypatch.setattr(inputs,'split_window',lambda *a:[(at,at)])
    monkeypatch.delenv('COINGECKO_API_KEY',raising=False)
    p.candles(scan(end=now()),[])
    batches=[s['positions'] for s in seen if 'positions' in s]
    assert [len(b) for b in batches]==[1,2]
    assert seen[-1]['liveProgress']['current']==2


def test_completed_balances_do_not_wait_for_optional_prices():
    from concurrent.futures import Future
    p=Inputs(mongomock.MongoClient(tz_aware=True).test)
    p.holdings_future=Future() # market refresh is still running
    p.pending_holdings={'status':'available','items':[]}
    p.balances_ready.set()
    assert p.final_holdings({},[],{})['status']=='available'
    assert not p.holdings_future.done()
