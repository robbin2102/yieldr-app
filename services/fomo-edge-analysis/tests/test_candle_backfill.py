from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
import mongomock
import inputs
from inputs import Inputs
from protocol import now,serial
from fomo_analysis.models import Candle
from test_fresh_pipeline import scan

def setup(monkeypatch):
    db=mongomock.MongoClient(tz_aware=True).test;p=Inputs(db);at=(now()-timedelta(hours=1)).replace(second=0,microsecond=0);at=at.replace(minute=at.minute-at.minute%5)
    windows=[SimpleNamespace(chain='solana',token_address=t) for t in ['a','b']]
    monkeypatch.setattr(inputs,'required_price_windows',lambda *a:windows)
    monkeypatch.setattr(inputs,'split_window',lambda *a:[(at,at)])
    monkeypatch.setenv('COINGECKO_API_KEY','test-only')
    db.fomo_analysis_tokens.insert_many([{'chain':'solana','token_address':t,'pool_address':'pool-'+t} for t in ['a','b']])
    return db,p,at

def test_supported_pool_endpoint_indexes_and_reuses_history(monkeypatch):
    db,p,at=setup(monkeypatch);calls=[]
    class Client:
        def __init__(self,*a,**k):pass
        def pool_ohlcv_by_network_id(self,network,chain,pool,token,**kw):
            calls.append((pool,token));return [Candle(chain,token,at,'5m',*[Decimal(2)]*4,1,'geckoterminal_pool','provider_native')]
        def token_ohlcv_by_network_id(self,*a,**k):raise AssertionError('Restricted endpoint must not be used')
    monkeypatch.setattr(inputs,'CoinGeckoOnchainClient',Client)
    candles,coverage=p.candles(scan(end=now()),[])
    assert len(candles)==2 and coverage['missing_candles']==0 and coverage['provider_calls']==2
    assert db.fomo_analysis_edge_candles.count_documents({})==2
    assert db.fomo_analysis_edge_candle_jobs.count_documents({'status':'fetched','http_status':200})==2
    p.candles(scan(end=now()),[])
    assert len(calls)==2

def test_access_error_opens_circuit_and_is_recorded(monkeypatch):
    db,p,at=setup(monkeypatch)
    class Client:
        def __init__(self,*a,**k):self.metrics=[]
        def pool_ohlcv_by_network_id(self,*a,**kw):
            self.metrics.append(SimpleNamespace(status_code=401));raise RuntimeError('CoinGecko Onchain returned HTTP 401: private credentials must never be logged')
    monkeypatch.setattr(inputs,'CoinGeckoOnchainClient',Client)
    _,coverage=p.candles(scan(end=now()),[])
    assert coverage['provider_calls']==1 and coverage['access_blocked']
    assert coverage['provider_errors']=={'401':1}
    assert db.fomo_analysis_edge_candle_jobs.count_documents({'status':'provider_access_denied','http_status':401})==1
    assert 'private' not in str(list(db.fomo_analysis_edge_candle_jobs.find()))

def test_sparse_success_does_not_refetch_empty_subranges(monkeypatch):
    db,p,at=setup(monkeypatch);calls=[]
    monkeypatch.setattr(inputs,'split_window',lambda *a:[(at,at+timedelta(minutes=5))])
    class Client:
        def __init__(self,*a,**k):pass
        def pool_ohlcv_by_network_id(self,network,chain,pool,token,**kw):
            calls.append(token);return [Candle(chain,token,at,'5m',*[Decimal(2)]*4,1,'geckoterminal_pool','provider_native')]
    monkeypatch.setattr(inputs,'CoinGeckoOnchainClient',Client)
    _,first=p.candles(scan(end=now()),[])
    _,second=p.candles(scan(end=now()),[])
    assert first['missing_candles']==second['missing_candles']==2
    assert first['provider_calls']==2 and second['provider_calls']==0

def test_parallel_backfill_overlaps_requests_without_exceeding_budget(monkeypatch):
    from threading import Barrier, Lock
    db,p,at=setup(monkeypatch)
    tokens=list('abcdef')
    windows=[SimpleNamespace(chain='solana',token_address=t) for t in tokens]
    # Repeated windows must not consume another provider credit.
    monkeypatch.setattr(inputs,'required_price_windows',lambda *a:windows+windows)
    db.fomo_analysis_tokens.delete_many({})
    db.fomo_analysis_tokens.insert_many([{'chain':'solana','token_address':t,'pool_address':'pool-'+t} for t in tokens])
    monkeypatch.setenv('EDGE_MAX_OHLC_CALLS','4')
    monkeypatch.setenv('EDGE_OHLC_CONCURRENCY','3')
    barrier=Barrier(3);lock=Lock();calls=[];active=0;peak=0
    class Client:
        def __init__(self,*a,**kw):
            assert kw['min_interval_seconds']==1
        def pool_ohlcv_by_network_id(self,network,chain,pool,token,**kw):
            nonlocal active,peak
            with lock:
                calls.append(token);active+=1;peak=max(peak,active)
            if token!='a':barrier.wait(timeout=3)
            with lock:active-=1
            return [Candle(chain,token,at,'5m',*[Decimal(2)]*4,1,'geckoterminal_pool','provider_native')]
    monkeypatch.setattr(inputs,'CoinGeckoOnchainClient',Client)
    candles,coverage=p.candles(scan(end=now()),[])
    assert peak==3
    assert len(calls)==len(set(calls))==coverage['provider_calls']==4
    assert len(candles)==4 and coverage['budget_exhausted']
    assert db.fomo_analysis_edge_candle_jobs.count_documents({'status':'fetched'})==4
    # Repeat only the already covered subset: no requests, even with duplicates.
    monkeypatch.setattr(inputs,'required_price_windows',lambda *a:windows[:4]*2)
    _,repeat=p.candles(scan(end=now()),[])
    assert repeat['provider_calls']==0 and len(calls)==4


def test_parallel_access_error_stops_refilling_and_drains_inflight(monkeypatch):
    db,p,at=setup(monkeypatch);calls=[]
    tokens=list('abcdefghij')
    windows=[SimpleNamespace(chain='solana',token_address=t) for t in tokens]
    monkeypatch.setattr(inputs,'required_price_windows',lambda *a:windows)
    db.fomo_analysis_tokens.delete_many({})
    db.fomo_analysis_tokens.insert_many([{'chain':'solana','token_address':t,'pool_address':'pool-'+t} for t in tokens])
    monkeypatch.setenv('EDGE_OHLC_CONCURRENCY','2')
    class Client:
        def __init__(self,*a,**kw):pass
        def pool_ohlcv_by_network_id(self,network,chain,pool,token,**kw):
            calls.append(token)
            if token!='a':raise RuntimeError('CoinGecko Onchain returned HTTP 403: rejected')
            return []
    monkeypatch.setattr(inputs,'CoinGeckoOnchainClient',Client)
    _,coverage=p.candles(scan(end=now()),[])
    assert coverage['access_blocked'] and len(calls)<=3
    assert coverage['provider_errors']['403']==len(calls)-1
