"""Mongo-first evidence adapters. Only verified complete ranges advance watermarks.

Extraction remains in the audited source. Missing parsers are a blocking dependency,
not permission to guess settlement architecture or replace the submitted wallet.
"""
import hashlib
import importlib
import json
import os
import re
from datetime import timedelta
from pymongo.errors import BulkWriteError
from pymongo import UpdateOne
from time import monotonic
from decimal import Decimal
import bootstrap
from token_cache import TokenCache, decorate, WSOL, canonical
from concurrent.futures import ThreadPoolExecutor, as_completed, wait, FIRST_COMPLETED
from threading import RLock, Event
from copy import deepcopy
from rpc_cache import encode_rpc, decode_rpc
from protocol import ScanFailure, now, time, serial
from scripts.rpc_utils import RpcClient, ChainConfig
from fomo_analysis.market_data import required_price_windows, split_window
from fomo_analysis.models import Candle
from fomo_analysis.coingecko import CoinGeckoOnchainClient, COINGECKO_NETWORKS, discover_network

INPUT_VERSION='wallet-evidence-v2-v33'
RPC_NAMES={'base':'ALCHEMY_BASE_RPC_URL','bnb':'ALCHEMY_BNB_RPC_URL','robinhood':'ALCHEMY_HOOD_RPC_URL','solana':'ALCHEMY_SOLANA_RPC_URL'}
def digest(value):return hashlib.sha256(json.dumps(serial(value),sort_keys=True).encode()).hexdigest()
def insert_evidence(collection,documents):
    for start in range(0,len(documents),250):
        try:collection.insert_many(documents[start:start+250],ordered=False)
        except BulkWriteError as error:
            if error.details.get('writeConcernErrors') or any(e.get('code')!=11000 for e in error.details.get('writeErrors',[])):raise


class Inputs:
    def __init__(self,db):self.db=db;self.raw={};self.rpcs={};self.audit=None;self.replays={};self.adjustments=[];self.token_cache=TokenCache(db);self.token_records={};self.balance_snapshot=None;self.enrichment=None;self.balances_ready=Event()
    def fetch(self,scan):
        missing=bootstrap.missing_source()
        if missing:raise ScanFailure('extraction_source_missing','The audited chain extraction source is incomplete. Restore its missing settlement and Solana parsers before retrying.')
        self.audit=importlib.import_module('scripts.audit_wallet_90d')
        missing_env=[RPC_NAMES[c] for c in scan['chains_analyzed'] if not os.getenv(RPC_NAMES[c])]
        if missing_env:raise ScanFailure('rpc_configuration_missing','Required chain RPC configuration is missing for this wallet. No fresh analysis has completed.')
        start,end=time(scan['window_start']),time(scan['window_end'])
        self.rpcs={c:RpcClient(ChainConfig(c,os.environ[RPC_NAMES[c]]),timeout=30) for c in scan['chains_analyzed']}
        if hasattr(self,'preview'):
            self.enrichment=ThreadPoolExecutor(max_workers=2)
            self.holdings_future=self.enrichment.submit(self.holdings,scan,[],{})
        activity={};lock=RLock()
        def fetch_chain(chain):
            wallet=scan['linked_wallets']['solana' if chain=='solana' else 'evm']
            rpc=self.rpcs[chain]
            key=digest([INPUT_VERSION,chain,wallet])
            coverage=self.db.fomo_analysis_edge_input_coverage.find_one({'_id':key})
            since=max(start,time(coverage['end'])-timedelta(minutes=5)) if coverage and time(coverage['start'])<=start else start
            parent=self
            class PageRpc:
                def call(self,method,params):
                    if method=='alchemy_getAssetTransfers':params=[{**params[0],'maxCount':'0x64'}]
                    response=rpc.call(method,params)
                    page=response.get('data' if chain=='solana' else 'transfers',[])
                    with lock:
                        for row in page:
                            at=parent.raw_time(chain,row)
                            if at and start<=at<=end:
                                identity=row.get('signature') or row.get('transaction',{}).get('signatures',[None])[0] if chain=='solana' else row.get('hash')
                                identity=identity or digest(row)
                                activity[chain+':'+identity]={'id':chain+':'+identity,'at':serial(at)}
                        if hasattr(parent,'preview'):parent.preview(activity=list(activity.values())[-1000:],liveProgress={'phase':'fetch','current':len(activity),'total':None,'unit':'transactions fetched'})
                    return response
            paged=PageRpc()
            fresh=self.audit.fetch_solana(paged,wallet,since) if chain=='solana' else self.audit.fetch_evm_direction(paged,wallet,'fromAddress',since)+self.audit.fetch_evm_direction(paged,wallet,'toAddress',since)
            documents=[]
            for raw in fresh:
                at=self.raw_time(chain,raw)
                if not at or not start<=at<=end:continue
                documents.append({'_id':digest([INPUT_VERSION,chain,wallet,raw]),'version':INPUT_VERSION,'chain':chain,'wallet':wallet,'at':at,'payload':encode_rpc(raw)})
            insert_evidence(self.db.fomo_analysis_edge_transaction_evidence,documents)
            self.raw[chain]=[decode_rpc(r['payload']) for r in self.db.fomo_analysis_edge_transaction_evidence.find({'version':INPUT_VERSION,'chain':chain,'wallet':wallet,'at':{'$gte':start,'$lte':end}})]
            if not coverage or time(coverage['end'])<end:self.db.fomo_analysis_edge_input_coverage.update_one({'_id':key},{'$set':{'start':iso_min(start,coverage),'end':end}},upsert=True)
        with ThreadPoolExecutor(max_workers=len(scan['chains_analyzed'])) as pool:
            for future in as_completed([pool.submit(fetch_chain,c) for c in scan['chains_analyzed']]):future.result()
        return sum(map(len,self.raw.values()))
    @staticmethod
    def raw_time(chain,row):
        if chain=='solana':
            from datetime import datetime,timezone
            return datetime.fromtimestamp(row['blockTime'],timezone.utc) if row.get('blockTime') else None
        return time(row['metadata']['blockTimestamp'])
    def extract(self,scan):
        rows=[];total_legs=0
        for chain,raw in self.raw.items():
            wallet=scan['linked_wallets']['solana' if chain=='solana' else 'evm']; rpc=self.rpcs[chain]; db=self.db; parent=self
            memo={}
            class ReplayRpc:
                def call(self,method,params=None):
                    if method=='alchemy_getAssetTransfers':
                        query=params[0];field='from' if 'fromAddress' in query else 'to'
                        return {'transfers':[r for r in raw if str(r.get(field,'')).lower()==wallet.lower()]}
                    if method=='getTransactionsForAddress':return {'data':raw}
                    return self.batch_call(method,[params])[0]
                def batch_call(self,method,params_list):
                    keys=[digest([chain,method,params]) for params in params_list]
                    immutable=method in {'eth_getTransactionReceipt','eth_getTransactionByHash','getTransaction'}
                    metadata=method in {'getMultipleAccounts','getAccountInfo'} or method=='eth_call'
                    absent=[key for key in keys if key not in memo]
                    if absent and (immutable or metadata):
                        for cached in db.fomo_analysis_edge_rpc_cache.find({'_id':{'$in':absent}}):
                            if metadata and (not cached.get('observed_at') or time(cached['observed_at'])<now()-timedelta(hours=24)):continue
                            memo[cached['_id']]=decode_rpc(cached['payload'])
                    todo=[(key,params) for key,params in zip(keys,params_list) if key not in memo]
                    for start in range(0,len(todo),25):
                        batch=todo[start:start+25]
                        values=rpc.batch_call(method,[params for key,params in batch]) if len(batch)>1 else [rpc.call(method,batch[0][1])]
                        documents=[]
                        for (key,params),value in zip(batch,values,strict=True):
                            memo[key]=value
                            if value is not None and immutable:documents.append({'_id':key,'payload':encode_rpc(value)})
                            elif value is not None and metadata:db.fomo_analysis_edge_rpc_cache.update_one({'_id':key},{'$set':{'payload':encode_rpc(value),'observed_at':now()}},upsert=True)
                        insert_evidence(db.fomo_analysis_edge_rpc_cache,documents)
                        if hasattr(parent,'preview') and method=='eth_getTransactionReceipt':parent.preview(liveProgress={'phase':'pricing','current':min(start+len(batch),len(todo)),'total':len(todo),'unit':'trade receipts checked'})
                    return [memo[key] for key in keys]
            replay=ReplayRpc();self.replays[chain]=replay
            result,_=self.audit.solana_trades(replay,wallet,time(scan['window_start'])) if chain=='solana' else self.audit.evm_trades(chain,replay,wallet,time(scan['window_start']))
            total_legs+=len(result)
            if hasattr(self,'preview'):self.preview(liveProgress={'phase':'pricing','current':len(rows),'total':total_legs,'unit':'trade legs priced'})
            # Preserve source atomic receipt/quote attribution for every extracted leg.
            from scripts.enrich_recent_amounts import enrich_evm,enrich_solana
            if chain!='solana':replay.batch_call('eth_getTransactionReceipt',[[tx] for tx in dict.fromkeys(r['transaction_id'] for r in result)])
            for row in result:
                if chain=='solana':rows.append(enrich_solana(row))
                else:
                    receipt=replay.call('eth_getTransactionReceipt',[row['transaction_id']])
                    if receipt is None:raise ScanFailure('receipt_unavailable','A trade receipt was unavailable. Retry the fresh scan.')
                    rows.append(enrich_evm(row,receipt,wallet))
                if hasattr(self,'preview') and (len(rows)%10==0 or row is result[-1]):self.preview(liveProgress={'phase':'pricing','current':len(rows),'total':total_legs,'unit':'trade legs priced'})
        return rows
    def external_inventory(self,scan,trades):
        from fomo_analysis.inventory import InventoryEvent
        from fomo_analysis.external_flows import extract_external_flows
        from scripts.fetch_wallet_transfers import unique_transfers
        raw={chain:(rows if chain=='solana' else unique_transfers(rows)) for chain,rows in self.raw.items()}
        self.adjustments=extract_external_flows(raw,scan['linked_wallets']['evm'] or '',scan['linked_wallets']['solana'] or '')
        events=[InventoryEvent(r.event_id,scan['analysis_trader_id'],r.chain,r.token_address,r.timestamp,
                'unknown_receipt' if r.direction=='IN' else 'transfer_out',r.quantity) for r in self.adjustments]
        return events,{(r.chain,r.token_address) for r in self.adjustments}
    def candles(self,scan,trades):
        windows=required_price_windows(trades,time(scan['window_end']));output={};jobs=0;missing=0;missing_candles=0
        client=None;networks=dict(COINGECKO_NETWORKS)
        if os.getenv('COINGECKO_API_KEY'):client=CoinGeckoOnchainClient(os.environ['COINGECKO_API_KEY'],plan=os.getenv('COINGECKO_API_PLAN','pro'),timeout=12,min_interval_seconds=1)
        budget=int(os.getenv('EDGE_MAX_OHLC_CALLS','50'));step=timedelta(minutes=5)
        complete_end=time(scan['window_end']).replace(second=0,microsecond=0)
        complete_end=complete_end.replace(minute=complete_end.minute-complete_end.minute%5)-step
        def add(row,chain,token):
            if row.get('quality')!='provider_native':return
            at=time(row.get('open_time') or row['timestamp'])
            if at>complete_end:return
            try:
                prices=[Decimal(str(row[k].to_decimal() if hasattr(row[k],'to_decimal') else row[k])) for k in ['open','high','low','close']]
                if any(not p.is_finite() or p<=0 for p in prices):return
                output[(chain,token,at)]=Candle(chain,token,at,'5m',*prices,row.get('sample_count',1),row.get('source','mongo'),'provider_native')
            except (KeyError,ValueError):return
        # Batch exact window queries. Avoid 2+ remote round trips per window.
        ranges=[]
        for window in windows:
            for start,end in split_window(window):
                end=min(end,complete_end)
                if end>=start:ranges.append((window,start,end))
        for offset in range(0,len(ranges),40):
            group=ranges[offset:offset+40]
            for collection,field in [(self.db.fomo_analysis_price_points_5m,'timestamp'),(self.db.fomo_analysis_edge_candles,'open_time')]:
                query={'$or':[{'chain':w.chain,'token_address':w.token_address,'interval':'5m',field:{'$gte':start,'$lte':end}} for w,start,end in group]}
                for row in collection.find(query):add(row,row['chain'],row['token_address'])
        records={}
        for chain in {w.chain for w in windows}:
            records.update({(chain,a):r for a,r in self.token_cache.read(chain,[w.token_address for w in windows if w.chain==chain]).items()})
        if any(w.chain=='robinhood' for w in windows) and client:
            cached=self.db.fomo_analysis_edge_networks.find_one({'_id':'robinhood'})
            if cached and cached.get('network_id'):networks['robinhood']=cached['network_id']
        plans={};pending=[]
        for window,start,end in ranges:
            gaps=[];at=start
            while at<=end:
                if (window.chain,window.token_address,at) not in output:
                    if gaps and gaps[-1][1]+step==at:gaps[-1]=(gaps[-1][0],at)
                    else:gaps.append((at,at))
                at+=step
            for gap_start,gap_end in gaps:
                pool=records.get((window.chain,window.token_address),{}).get('pool_address')
                key=digest(['geckoterminal_pool_v1',window.chain,window.token_address,pool,gap_start,gap_end,'5m'])
                job={'_id':key,'chain':window.chain,'token_address':window.token_address,'pool_address':pool,'provider':'geckoterminal_pool','interval':'5m','start':gap_start,'end':gap_end}
                plans.setdefault((window.chain,window.token_address),[]).append(job);pending.append(job)
        previous={};prior_ranges={}
        for chain in {w.chain for w in windows}:
            for row in self.db.fomo_analysis_edge_candle_jobs.find({'provider':'geckoterminal_pool','chain':chain,'token_address':{'$in':list({w.token_address for w in windows if w.chain==chain})}}):
                previous[row['_id']]=row;prior_ranges.setdefault((row['chain'],row['token_address'],row.get('pool_address')),[]).append(row)
        # Journal missing ranges once; keep the old token-endpoint failures intact.
        insert_evidence(self.db.fomo_analysis_edge_candle_jobs,[{**j,'status':'pending'} for j in pending if j['_id'] not in previous])
        checked_tokens=set();attempted=set();updates=[];last_publish=0;errors={};access_blocked=False
        # Reserve the budget before scheduling; duplicate windows must not spend twice.
        tasks=[];remaining={}
        concurrency=max(1,min(4,int(os.getenv('EDGE_OHLC_CONCURRENCY','4'))))
        for window in windows:
            token=(window.chain,window.token_address)
            for job in plans.get(token,[]):
                key=job['_id'];old=previous.get(key,{})
                if key in attempted:continue
                attempted.add(key)
                cooling=old.get('attempted_at') and time(old['attempted_at'])>now()-timedelta(hours=1)
                covered=any(r.get('status') in ('fetched','no_data') and r['start']<=job['start'] and r['end']>=job['end'] and r.get('attempted_at') and time(r['attempted_at'])>now()-timedelta(hours=1) for r in prior_ranges.get((window.chain,window.token_address,job.get('pool_address')),[]))
                if not client or window.chain not in networks or len(tasks)>=budget or cooling or covered:continue
                if not job['pool_address']:
                    updates.append((key,{'status':'pool_metadata_missing'}));continue
                tasks.append(job);remaining[token]=remaining.get(token,0)+1
        completed_windows=0
        def publish_ready():
            nonlocal completed_windows,last_publish
            for window in windows:
                token=(window.chain,window.token_address)
                if token in checked_tokens or remaining.get(token,0):continue
                checked_tokens.add(token)
                completed_windows=sum((w.chain,w.token_address) in checked_tokens for w in windows)
                stamp=monotonic()
                if hasattr(self,'preview') and (completed_windows==1 or completed_windows==len(windows) or stamp-last_publish>=1):
                    self.preview(positions=[p for p in getattr(self,'preview_positions',[]) if (p['chain'],p['tokenAddress']) in checked_tokens],liveProgress={'phase':'market','current':completed_windows,'total':len(windows),'unit':'coin price histories checked','providerCalls':jobs,'providerErrors':errors.copy(),'accessBlocked':access_blocked})
                    last_publish=monotonic()
        def fetch_job(job):
            expected=int((job['end']-job['start'])/step)+1
            try:
                fresh=client.pool_ohlcv_by_network_id(networks[job['chain']],job['chain'],job['pool_address'],job['token_address'],aggregate=5,limit=min(1000,expected),before_timestamp=int(job['end'].timestamp())+1)
                return fresh,200
            except Exception as exc:
                # Shared client metrics can contain another thread's response.
                # The source client includes the HTTP status in its exception.
                match=re.search(r'HTTP (\d{3})',str(exc))
                return [],int(match.group(1)) if match else None
        def consume(job,result):
            nonlocal access_blocked
            fresh,http_status=result;documents=[]
            if http_status==200:
                for candle in fresh:
                    if not job['start']<=candle.open_time<=job['end']:continue
                    row=serial(candle.__dict__);row['open_time']=candle.open_time;row['pool_address']=job['pool_address']
                    documents.append({'_id':digest([candle.chain,candle.token_address,candle.open_time,'5m']),**row});add(row,job['chain'],job['token_address'])
                insert_evidence(self.db.fomo_analysis_edge_candles,documents)
                status='fetched' if documents else 'no_data'
            else:
                status='provider_access_denied' if http_status in (401,403) else 'provider_unavailable'
                access_blocked=access_blocked or http_status in (401,403)
                errors[str(http_status or 'unknown')]=errors.get(str(http_status or 'unknown'),0)+1
            updates.append((job['_id'],{'status':status,'http_status':http_status,'attempted_at':now()}))
            token=(job['chain'],job['token_address']);remaining[token]-=1
            publish_ready()
        publish_ready()
        # Probe access once, so invalid credentials cannot fan out paid requests.
        if tasks:
            jobs+=1;consume(tasks[0],fetch_job(tasks[0]))
        if len(tasks)>1 and not access_blocked:
            # The shared source client's lock spaces *all* attempts (including
            # retries) one second apart, while network waits overlap.
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                queue=iter(tasks[1:]);active={}
                def fill():
                    nonlocal jobs
                    while not access_blocked and len(active)<concurrency:
                        job=next(queue,None)
                        if job is None:break
                        jobs+=1;active[pool.submit(fetch_job,job)]=job
                fill()
                while active:
                    done,_=wait(active,return_when=FIRST_COMPLETED)
                    for future in done:consume(active.pop(future),future.result())
                    fill()
        # Unscheduled work remains pending for a later scan; no invented prices.
        remaining.clear();publish_ready()
        for offset in range(0,len(updates),250):
            self.db.fomo_analysis_edge_candle_jobs.bulk_write([UpdateOne({'_id':key},{'$set':fields}) for key,fields in updates[offset:offset+250]],ordered=False)
        for window,start,end in ranges:
            absent=0;at=start
            while at<=end:
                absent+=int((window.chain,window.token_address,at) not in output);at+=step
            missing+=int(absent>0);missing_candles+=absent
        return list(output.values()),{'missing_windows':missing,'missing_candles':missing_candles,'provider_calls':jobs,'provider_call_budget':budget,
            'provider':'geckoterminal_pool','provider_errors':errors,'access_blocked':access_blocked,
            'budget_exhausted':jobs>=budget and missing>0,'cached_or_fetched_candles':len(output),'status':'partial' if missing else 'complete'}
    def holdings(self,scan,episodes,ledgers):
        from wallet_balances import solana_balances, evm_balances
        balances={};failed=[];finished=set();lock=RLock();observed=now()
        def publish():
            prices={k:Decimal(str(r['current_price_usd'])) for k,r in self.token_records.copy().items() if r.get('current_price_usd') is not None}
            items=[]
            for chain,rows in balances.items():
                for row in rows:
                    key=(chain,row['token_address']);ledger=ledgers.get(key);price=prices.get(key)
                    opens=[e for e in episodes if (e.chain,e.token_address)==key and not e.closed_at]
                    external=bool(ledger and ledger.unknown_cost_quantity>0)
                    # A changed live balance cannot inherit the frozen scan's entire lot basis.
                    same_quantity=bool(ledger and abs(ledger.known_cost_quantity+ledger.unknown_cost_quantity-row['quantity'])<=max(Decimal('1e-18'),row['quantity']*Decimal('0.000001')))
                    cost=sum((lot.known_cost_usd for lot in ledger.lots),Decimal(0)) if ledger and ledger.lots and same_quantity and all(lot.known_cost_usd is not None for lot in ledger.lots) else None
                    value=row['quantity']*price if price is not None else None
                    items.append({'wallet':scan['linked_wallets']['solana' if chain=='solana' else 'evm'],'chain':chain,'tokenAddress':row['token_address'],'symbol':row['symbol'],'name':row.get('name'),'assetType':row.get('assetType','token'),
                        'quantity':serial(row['quantity']),'price':serial(price),'value':serial(value),'costBasis':serial(cost),
                        'costBasisStatus':'externally_received_token' if external else 'verified_open_trading_position' if cost is not None and opens else 'unknown_cost_inventory',
                        'openEpisodeIds':[e.as_document()['episode_id'] for e in opens],'externalReceipt':external if ledger else None})
            snapshot={'status':'available' if not failed else 'unavailable','observedAt':serial(observed),'source':'live_wallet_rpc','stale':False,'items':decorate(items,self.token_records),'unavailableChains':list(failed)}
            self.pending_holdings=deepcopy(snapshot)
            if hasattr(self,'preview'):self.preview(holdings=snapshot)
            return snapshot
        def load_chain(chain):
            wallet=scan['linked_wallets']['solana' if chain=='solana' else 'evm']
            cache=TokenCache(self.db)
            def balance_batch(rows):
                with lock:
                    balances[chain]=rows
                    self.token_records.update({(chain,a):r for a,r in cache.read(chain,[r['token_address'] for r in rows]).items()})
                    publish()
            try:
                rows=solana_balances(self.rpcs[chain],wallet) if chain=='solana' else evm_balances(self.rpcs[chain],wallet,cache,chain,on_batch=balance_batch)
                with lock:
                    balances[chain]=rows
                    self.token_records.update({(chain,a):r for a,r in cache.read(chain,[r['token_address'] for r in rows]).items()})
                    publish()
                    finished.add(chain)
                    if len(finished)==len(scan['chains_analyzed']):self.balances_ready.set()
                def updated(records):
                    with lock:
                        self.token_records.update({(chain,a):r for a,r in records.items()})
                        publish()
                updated(cache.enrich(chain,[r['token_address'] for r in rows],on_batch=updated))
            except Exception:
                with lock:
                    failed.append(chain);publish();finished.add(chain)
                    if len(finished)==len(scan['chains_analyzed']):self.balances_ready.set()
        with ThreadPoolExecutor(max_workers=len(scan['chains_analyzed'])) as pool:
            for f in as_completed([pool.submit(load_chain,c) for c in scan['chains_analyzed']]):f.result()
        self.balance_snapshot=balances
        return publish()

    def final_holdings(self,scan,episodes,ledgers):
        # Join the early snapshot to the finished inventory. Never match by symbol.
        try:
            # Complete balances are required; optional price refresh must not stall analysis.
            if self.holdings_future.done():holdings=self.holdings_future.result()
            elif self.balances_ready.wait(timeout=120):holdings=deepcopy(self.pending_holdings)
            else:holdings=self.holdings_future.result(timeout=2)
        except TimeoutError:holdings={**deepcopy(getattr(self,'pending_holdings',{'items':[],'observedAt':None,'source':'live_wallet_rpc','stale':False})),'status':'unavailable'}
        except Exception:return {'status':'unavailable','items':[],'observedAt':None,'source':'live_wallet_rpc','stale':False}
        reconciliation=[]
        for ep in episodes:
            if ep.closed_at:continue
            key=(ep.chain,canonical(ep.chain,ep.token_address));matches=[h for h in holdings['items'] if (h['chain'],canonical(h['chain'],h['tokenAddress']))==key and h.get('assetType')!='native']
            eid=ep.as_document()['episode_id']
            for h in matches:
                if eid not in h['openEpisodeIds']:h['openEpisodeIds'].append(eid)
            ledger=ledgers.get(key)
            transferred=bool(not matches and ledger and ledger.transfer_out_quantity>0 and ledger.known_cost_quantity+ledger.unknown_cost_quantity==0)
            reconciliation.append({'episodeId':eid,'chain':ep.chain,'tokenAddress':ep.token_address,
                'status':'current_balance' if matches else 'transferred_out' if transferred else 'no_current_balance','quantity':str(sum((Decimal(h['quantity']) for h in matches),Decimal(0))),
                'note':None if matches else 'Transferred out of this wallet; not a trading sale.' if transferred else 'Open in analyzed Fomo history; no current token balance. A later sale or transfer is not attributed without evidence.'})
        for h in holdings['items']:
            if h.get('assetType')=='native':continue
            ledger=ledgers.get((h['chain'],canonical(h['chain'],h['tokenAddress'])))
            if not ledger:continue
            h['externalReceipt']=ledger.unknown_cost_quantity>0
            qty=Decimal(h['quantity']);same=abs(ledger.known_cost_quantity+ledger.unknown_cost_quantity-qty)<=max(Decimal('1e-18'),qty*Decimal('0.000001'))
            cost=sum((lot.known_cost_usd for lot in ledger.lots),Decimal(0)) if same and ledger.lots and all(lot.known_cost_usd is not None for lot in ledger.lots) else None
            h['costBasis']=serial(cost)
            h['costBasisStatus']='mixed_origin' if ledger.unknown_cost_quantity>0 and ledger.known_cost_quantity>0 else 'externally_received_token' if ledger.unknown_cost_quantity>0 else 'verified_open_trading_position' if cost is not None else 'unknown_cost_inventory'
        holdings['reconciliation']=reconciliation
        return holdings

    def enrich_positions(self,episodes):
        for chain in {e.chain for e in episodes}:
            rows=self.token_cache.enrich(chain,[e.token_address for e in episodes if e.chain==chain],need_price=False)
            self.token_records.update({(chain,a):r for a,r in rows.items()})


    def pnl_report(self,scan,trades,holdings,stories,candles):
        from fomo_analysis.portfolio_accounting import build_window_pnl_snapshot,build_fifo_period_metrics
        from fomo_analysis.pnl_reporting import build_v3_3_pnl_reporting
        if holdings['status']!='available':return None
        prices={(r['chain'],r['tokenAddress']):Decimal(r['price']) for r in holdings['items'] if r['price'] is not None}
        snapshot=build_window_pnl_snapshot(trades,time(scan['window_start']),prices,valuation_time=time(scan['window_end']),inventory_adjustments=self.adjustments)
        # Price only verified positions carried into the cutoff, as in the source runner.
        cutoff_prices={}
        for candle in sorted(candles,key=lambda c:c.open_time):
            if time(scan['window_start'])-timedelta(hours=6)<=candle.open_time<=time(scan['window_start']):cutoff_prices[(candle.chain,candle.token_address)]=candle.close
        period=build_fifo_period_metrics(snapshot,cutoff_prices)
        period['capital_deployed_at_cutoff_usd']=period['opening_verified_fifo_value_usd']
        period['capital_denominator_status']='verified_open_positions_at_cutoff_only'
        snapshot['period_metrics']=period
        payload={'window_days':90,'valuation_time':holdings['observedAt'],'pnl_window':snapshot,
                 'actual_wallet_portfolio':{'position_count':len(holdings['items']),'priced_token_value_usd':serial(sum((Decimal(r['value']) for r in holdings['items'] if r['value'] is not None),Decimal(0)))}}
        report=build_v3_3_pnl_reporting(payload,position_stories=stories)
        report['coverage']={'priced_holdings':sum(r['price'] is not None for r in holdings['items']),'total_holdings':len(holdings['items']),
                            'frozen_trade_ledger_through':scan['window_end'],'valuation_observed_at':holdings['observedAt'],
                            'warning':'Verified FIFO subset only. Unpriced and unknown-cost inventory is excluded; live balances may change after submission.'}
        return report

def iso_min(start,coverage):return min(start,time(coverage['start'])) if coverage else start
