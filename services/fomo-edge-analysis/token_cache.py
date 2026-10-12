"""Mongo-first, bounded bulk token enrichment. Provider failure never invalidates analysis."""
import os
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from pymongo.errors import DuplicateKeyError
from protocol import now, time, serial
from fomo_analysis.coingecko import CoinGeckoOnchainClient, COINGECKO_NETWORKS, discover_network

WSOL='So11111111111111111111111111111111111111112'
USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
def canonical(chain,address):return address if chain=='solana' else address.lower()
def fresh(value,seconds,at):
    try:return 0 <= (at-time(value)).total_seconds() < seconds
    except (ValueError,TypeError,AttributeError):return False
def due(row,at,need_price=True):
    if row and row.get('retry_after') and time(row['retry_after'])>at:return False
    return not row or not (fresh(row.get('metadata_observed_at'),30*86400,at) and fresh(row.get('pool_observed_at'),86400,at) and (not need_price or fresh(row.get('price_observed_at'),300,at)))
def number(value):
    try:
        n=Decimal(str(value));return n if n.is_finite() and n>=0 else None
    except (InvalidOperation,ValueError):return None

class TokenCache:
    def __init__(self,db,client=None):
        self.db=db;self.client=client;self.calls=0
    def read(self,chain,addresses):
        addresses=list(dict.fromkeys(canonical(chain,a) for a in addresses))
        return {r['token_address']:r for r in self.db.fomo_analysis_tokens.find({'chain':chain,'token_address':{'$in':addresses}})}
    def enrich(self,chain,addresses,need_price=True,on_batch=None):
        addresses=list(dict.fromkeys(canonical(chain,a) for a in addresses if a and a!='SOL'))
        records=self.read(chain,addresses);at=now();owned=[];owner=uuid.uuid4().hex
        if not self.client:
            if not os.getenv('COINGECKO_API_KEY'):return records
            self.client=CoinGeckoOnchainClient(os.environ['COINGECKO_API_KEY'],plan=os.getenv('COINGECKO_API_PLAN','pro'),timeout=12,min_interval_seconds=1)
        network=COINGECKO_NETWORKS.get(chain)
        if not network and chain=='robinhood':
            cached=self.db.fomo_analysis_edge_networks.find_one({'_id':chain})
            if cached and fresh(cached.get('observed_at'),cached.get('ttl',86400),at):network=cached.get('network_id')
            else:
                try:
                    lock=self.db.fomo_analysis_token_locks.update_one({'_id':'network:'+chain,'$or':[{'until':{'$lte':now()}},{'until':{'$exists':False}}]},{'$set':{'owner':owner,'until':now()+timedelta(minutes=5)}},upsert=True)
                    if lock.matched_count or lock.upserted_id:
                        found=discover_network(self.client.all_networks(),('robinhood','robinhood chain'))
                        network=found['id'] if found else None
                        self.db.fomo_analysis_edge_networks.update_one({'_id':chain},{'$set':{'network_id':network,'observed_at':now(),'ttl':86400}},upsert=True)
                except DuplicateKeyError:pass
                except Exception:self.db.fomo_analysis_edge_networks.update_one({'_id':chain},{'$set':{'network_id':None,'observed_at':now(),'ttl':1800}},upsert=True)
                finally:self.db.fomo_analysis_token_locks.update_one({'_id':'network:'+chain,'owner':owner},{'$set':{'until':now()}})
        if not network:return records
        candidates=[a for a in addresses if due(records.get(a),at,need_price)]
        for start in range(0,len(candidates),30):
            owned=[]
            for address in candidates[start:start+30]:
                try:
                    lock=self.db.fomo_analysis_token_locks.update_one({'_id':chain+':'+address,'$or':[{'until':{'$lte':now()}},{'until':{'$exists':False}}]}, {'$set':{'owner':owner,'until':now()+timedelta(minutes=5)}},upsert=True)
                    if lock.matched_count or lock.upserted_id:owned.append(address)
                except DuplicateKeyError:pass
            # Another worker may have finished between our initial read and lease acquisition.
            latest=self.read(chain,owned)
            group=[a for a in owned if due(latest.get(a),now(),need_price)]
            skipped=[a for a in owned if a not in group]
            if skipped:self.db.fomo_analysis_token_locks.update_many({'_id':{'$in':[chain+':'+a for a in skipped]},'owner':owner},{'$set':{'until':now()}})
            if not group:continue
            try:
                self.calls+=1
                body=self.client._get(f"networks/{network}/tokens/multi/{','.join(group)}",{'include':'top_pools','include_inactive_source':'true'})
                included={p['id']:p.get('attributes',{}) for p in body.get('included',[])}
                returned={canonical(chain,r.get('attributes',{}).get('address','')):r for r in body.get('data',[])}
                for address in group:
                    row=returned.get(address);old=records.get(address,{})
                    if row:
                        a=row['attributes'];pools=row.get('relationships',{}).get('top_pools',{}).get('data',[])
                        pool=included.get(pools[0]['id'],{}) if pools else {}
                        value=number(a.get('price_usd'));stamp=now()
                        fields={'token_id':row['id'],'chain':chain,'token_address':address,
                            'name':a.get('name') or old.get('name'),'symbol':a.get('symbol') or old.get('symbol'),
                            'decimals':a.get('decimals',old.get('decimals')),'image_url':a.get('image_url') or old.get('image_url'),
                            'metadata_observed_at':stamp,'pool_observed_at':stamp,
                            'current_price_usd':serial(value),'price_observed_at':stamp if value is not None else None,
                            'price_source':'coingecko_onchain','pool_address':pool.get('address'),
                            'pool_name':pool.get('name'),'pool_created_at':pool.get('pool_created_at'),
                            'pool_reserve_usd':pool.get('reserve_in_usd'),'market_data_status':'available' if value is not None else 'no_pool',
                            'updated_at':stamp,'retry_after':None if value is not None else stamp+timedelta(hours=24)}
                    else:fields={'chain':chain,'token_address':address,'market_data_status':'not_found','retry_after':now()+timedelta(hours=24),'updated_at':now()}
                    self.db.fomo_analysis_tokens.update_one({'chain':chain,'token_address':address},{'$set':fields},upsert=True)
            except Exception:
                for address in group:self.db.fomo_analysis_tokens.update_one({'chain':chain,'token_address':address},{'$set':{'chain':chain,'token_address':address,'market_data_status':'refresh_delayed','retry_after':now()+timedelta(minutes=30)}},upsert=True)
            finally:
                self.db.fomo_analysis_token_locks.update_many({'_id':{'$in':[chain+':'+a for a in group]},'owner':owner},{'$set':{'until':now()}})
            if on_batch:on_batch(self.read(chain,addresses))
        return self.read(chain,addresses)

def decorate(items,records):
    for h in items:
        r=records.get((h['chain'],h['tokenAddress']),{});price=number(r.get('current_price_usd'))
        h.update(symbol=r.get('symbol') or h.get('symbol') or 'Unknown token',name=r.get('name') or h.get('name'),imageUrl=r.get('image_url') or h.get('imageUrl'),
                 priceObservedAt=serial(r.get('price_observed_at')),marketDataStatus=r.get('market_data_status','pending'),
                 price=serial(price),value=serial(Decimal(h['quantity'])*price) if price is not None else None)
        if h.get('assetType')=='native':h.update(symbol='SOL',name='Solana')
        elif h['chain']=='solana' and h['tokenAddress']==USDC:h['assetType']='stablecoin'
        else:h['assetType']='token'
    return items
