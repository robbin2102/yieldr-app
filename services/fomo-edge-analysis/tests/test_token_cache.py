from datetime import timedelta
from decimal import Decimal
import mongomock
from token_cache import TokenCache, due, decorate, WSOL
from protocol import now

class Client:
    def __init__(self,fail=False):self.calls=[];self.fail=fail
    def _get(self,path,params):
        self.calls.append((path,params))
        if self.fail:raise RuntimeError('private failure')
        return {'data':[{'id':a,'attributes':{'address':a,'name':'Name '+a,'symbol':'T','price_usd':'2','decimals':9},'relationships':{'top_pools':{'data':[{'id':'p'}]}}} for a in path.split('/')[-1].split(',')], 'included':[{'id':'p','attributes':{'address':'pool','name':'Pool','reserve_in_usd':'123'}}]}

def test_batch_persist_and_reuse():
    db=mongomock.MongoClient(tz_aware=True).test;c=Client();cache=TokenCache(db,c)
    rows=cache.enrich('solana',[str(i) for i in range(14)])
    assert len(c.calls)==1 and len(rows)==14 and rows['0']['pool_address']=='pool'
    assert c.calls[0][1]=={'include':'top_pools','include_inactive_source':'true'}
    cache.enrich('solana',[str(i) for i in range(14)])
    assert len(c.calls)==1
    cache.enrich('solana',[str(i) for i in range(75)])
    assert len(c.calls)==4 # 61 new tokens => 3 requests, all <=30
    assert all(len(p.split('/')[-1].split(','))<=30 for p,_ in c.calls)

def test_independent_ttls_error_backoff_and_lock():
    at=now();row={'metadata_observed_at':at-timedelta(days=29),'pool_observed_at':at-timedelta(hours=23),'price_observed_at':at-timedelta(minutes=4)}
    assert not due(row,at)
    assert not due({**row,'price_observed_at':at-timedelta(days=2)},at,need_price=False)
    for key,delta in [('metadata_observed_at',timedelta(days=30)),('pool_observed_at',timedelta(hours=24)),('price_observed_at',timedelta(minutes=5))]:assert due({**row,key:at-delta},at)
    db=mongomock.MongoClient(tz_aware=True).test;c=Client(True);cache=TokenCache(db,c)
    cache.enrich('solana',['a']);cache.enrich('solana',['a']);assert len(c.calls)==1
    db.fomo_analysis_token_locks.insert_one({'_id':'solana:b','owner':'other','until':at+timedelta(minutes=5)})
    cache.enrich('solana',['b']);assert len(c.calls)==1

def test_negative_cache_and_native_price():
    db=mongomock.MongoClient(tz_aware=True).test;c=Client();c._get=lambda *a:{'data':[]}
    cache=TokenCache(db,c);cache.enrich('solana',['missing']);row=cache.read('solana',['missing'])['missing']
    assert not due(row,now()) and row['market_data_status']=='not_found'
    items=[{'chain':'solana','tokenAddress':WSOL,'assetType':'native','quantity':'3'}]
    decorate(items,{('solana',WSOL):{'symbol':'WSOL','current_price_usd':'2'}})
    assert items[0]['symbol']=='SOL' and items[0]['value']=='6'

def test_robinhood_network_discovery_is_cached():
    db=mongomock.MongoClient(tz_aware=True).test;c=Client();calls=[]
    def networks():calls.append(1);return [{'id':'robinhood','attributes':{'name':'Robinhood Chain'}}]
    c.all_networks=networks
    cache=TokenCache(db,c);cache.enrich('robinhood',['0xabc']);cache.enrich('robinhood',['0xdef'])
    assert calls==[1] and len(c.calls)==2
