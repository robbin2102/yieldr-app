"""Durable Mongo queue with leases, bounded retries and atomic result publication."""
import os
import threading
import uuid
import traceback
from datetime import timedelta
from pymongo import MongoClient, ReturnDocument
from engine import run_pipeline
from inputs import Inputs, insert_evidence
from protocol import STAGES, ScanFailure, now, serial, time

COLLECTION='fomo_analysis_edge_scan_runs'
def database():
    uri=os.getenv('MONGODB_URI')
    if not uri:raise RuntimeError('configuration_unavailable')
    name=os.getenv('MONGODB_DATABASE','yieldr')
    client=MongoClient(uri,serverSelectionTimeoutMS=8000,tz_aware=True)
    return client,client[name]

def validate_output(scan,output):
    identity=output['result']['identity']
    if identity['evmWallet']!=scan['linked_wallets']['evm'] or identity['solanaWallet']!=scan['linked_wallets']['solana']:
        raise ScanFailure('wallet_mismatch','The computed result did not match the submitted wallet.')
    if identity['evmWallet']!=scan['normalized_wallet'] and identity['solanaWallet']!=scan['normalized_wallet']:
        raise ScanFailure('wallet_mismatch','The result does not contain the submitted wallet.')
    if output['result']['windowEnd']!=scan['window_end'] or output['result']['windowStart']!=scan['window_start']:
        raise ScanFailure('window_mismatch','The computed result did not match the requested window.')
    start,end=time(scan['window_start']),time(scan['window_end'])
    for p in output['positions']:
        if not start<=time(p['closedAt'])<=end or p['chain'] not in scan['chains_analyzed'] or not p['episodeId'].startswith(identity['id']+':'):
            raise ScanFailure('position_ownership_mismatch','Position attribution could not be verified.')
    if len(output['positions'])!=output['result']['closedPositions']:
        raise ScanFailure('position_count_mismatch','The position count could not be reconciled.')
    for h in output['holdings']['items']:
        if h['chain'] not in scan['chains_analyzed'] or h.get('wallet') != scan['linked_wallets']['solana' if h['chain']=='solana' else 'evm']:raise ScanFailure('holdings_ownership_mismatch','Holdings attribution could not be verified.')

def process_one(db,scan,inputs=None):
    runs=db[COLLECTION];owner=scan['lease_owner'];selector={'_id':scan['_id'],'lease_owner':owner,'status':'running'}
    stop=threading.Event()
    def heartbeat():
        while not stop.wait(15):
            try:
                if not runs.update_one(selector,{'$set':{'lease_until':now()+timedelta(seconds=90)}}).matched_count:return
            except Exception:return
    thread=threading.Thread(target=heartbeat,daemon=True);thread.start()
    def checkpoint(stage,**fields):
        row=runs.find_one(selector)
        if not row:raise ScanFailure('lease_lost','The analysis lease was lost. Please start another scan.')
        completed=[s for s in row.get('completed_stages',[]) if s['key']!=stage]
        completed.append({'key':stage,'completed_at':serial(now())})
        values={'completed_stages':completed,'active_stage':STAGES[STAGES.index(stage)+1] if stage!=STAGES[-1] else None,'updated_at':serial(now()),'lease_until':now()+timedelta(seconds=90)}
        for key,value in fields.items():
            if key=='counts':values.update({'counts.'+k:v for k,v in value.items()})
            else:values[key]=serial(value)
        if not runs.update_one(selector,{'$set':values}).matched_count:raise ScanFailure('lease_lost','The analysis lease was lost.')
    try:
        provider=inputs or Inputs(db)
        provider.preview=lambda **fields:runs.update_one(selector,{'$set':{**{'preview.'+k:serial(v) for k,v in fields.items()},'updated_at':serial(now())}})
        provider.progress=lambda **fields:runs.update_one(selector,{'$set':{'input_progress':serial(fields),'updated_at':serial(now())}})
        output=run_pipeline(scan,db,provider,checkpoint)
        current=runs.find_one(selector)
        if not current:raise ScanFailure('lease_lost','The analysis lease was lost.')
        validate_output(current,output)
        base={'scan_id':scan['scan_id'],'normalized_wallet':scan['normalized_wallet'],'generation':owner}
        for kind in ['result','holdings','positions','stories']:
            rows=output[kind] if kind in ['positions','stories'] else [output[kind]]
            documents=[{'_id':f"{scan['scan_id']}:{owner}:{kind}:{i}",**base,'kind':kind,'ordinal':i,'payload':serial(payload)} for i,payload in enumerate(rows)]
            insert_evidence(db.fomo_analysis_edge_scan_outputs,documents)
        # Evidence remains scan/generation scoped in bounded records.
        for kind,values in output['audit'].items():
            rows=values if isinstance(values,list) else [values]
            documents=[{'_id':f"{scan['scan_id']}:{owner}:{kind}:{i}",**base,'kind':kind,'payload':serial(payload)} for i,payload in enumerate(rows)]
            insert_evidence(db.fomo_analysis_edge_scan_evidence,documents)
        # Immutable completed-analysis log; outputs/evidence stay in bounded generation-owned records.
        completed_at=serial(now())
        db.fomo_analysis_edge_analysis_logs.update_one({'_id':scan['scan_id']+':'+owner},{'$set':{
            **base,'cache_revision':'submitted-wallet-v2','scope':'submitted_wallet',
            'model_version':output['result']['modelVersion'],'rule_version':output['result']['ruleVersion'],
            'analysis_version':output['result']['analysisVersion'],'completed_at':completed_at,
            'window_start':scan['window_start'],'window_end':scan['window_end'],
            'identity':output['result']['identity'],'performance':output['result']['performance'],
            'findings':output['result']['findings'],'counts':current.get('counts',{}),
            'price_coverage':current.get('price_coverage',{}),'holdings':output['holdings'],
            'outputs_collection':'fomo_analysis_edge_scan_outputs','evidence_collection':'fomo_analysis_edge_scan_evidence',
        }},upsert=True)
        completed=current['completed_stages']+[{'key':'persist_completed_scan','completed_at':serial(now())}]
        runs.update_one(selector,{'$set':{'status':'completed','completed_stages':completed,'active_stage':None,'completed_at':serial(now()),
             'result_summary_id':scan['scan_id'],'result_generation':owner,'failure':None,'updated_at':serial(now())},'$unset':{'lease_until':''}})
    except Exception as error:
        # Safe diagnostic location only: no exception text, provider response or secrets.
        frames=traceback.extract_tb(error.__traceback__)
        location={'type':type(error).__name__,'frames':[{'file':f.filename.rsplit('/',1)[-1],'line':f.lineno,'function':f.name} for f in frames[-4:]]}
        runs.update_one(selector,{'$set':{'failure_diagnostic':location}})
        safe=error if isinstance(error,ScanFailure) else ScanFailure('analysis_failed','Fresh analysis failed. No previous trader result has been substituted. Please retry or check worker configuration.')
        runs.update_one(selector,{'$set':{'status':'blocked' if safe.code.endswith(('missing','unindexed')) else 'failed',
            'classification':'non_fomo_or_unindexed' if safe.code=='non_fomo_or_unindexed' else scan.get('classification','known_fomo_analysis_pending'),
            'failure':{'code':safe.code,'message':safe.safe_message},'updated_at':serial(now())},'$unset':{'lease_until':''}})
    finally:stop.set();thread.join(timeout=1)

class Worker:
    def __init__(self):self.stop=threading.Event();self.thread=None
    def start(self):
        if not os.getenv('MONGODB_URI'):return
        self.thread=threading.Thread(target=self.loop,daemon=True);self.thread.start()
        threading.Thread(target=self.metadata_loop,daemon=True).start()
    def metadata_loop(self):
        from token_cache import TokenCache
        client,db=database()
        try:
            db.fomo_analysis_edge_metadata_jobs.create_index('expires_at',expireAfterSeconds=0)
            db.fomo_analysis_tokens.create_index([('chain',1),('token_address',1)],unique=True)
            while not self.stop.is_set():
                job=None
                try:
                    job=db.fomo_analysis_edge_metadata_jobs.find_one_and_update({'$or':[{'status':'queued'},{'status':'running','lease_until':{'$lt':now()}}]}, {'$set':{'status':'running','lease_until':now()+timedelta(minutes=10)}},return_document=ReturnDocument.AFTER)
                    if job:
                        scan=db[COLLECTION].find_one({'scan_id':job['scan_id'],'normalized_wallet':job['normalized_wallet'],'result_generation':job['generation'],'status':'completed'})
                        if scan:
                            tokens={};held={}
                            for row in db.fomo_analysis_edge_scan_outputs.find({'scan_id':job['scan_id'],'generation':job['generation'],'normalized_wallet':job['normalized_wallet'],'kind':{'$in':['holdings','positions','stories']}}):
                                values=row['payload']['items'] if row['kind']=='holdings' else [row['payload']]
                                for v in values:
                                    if v.get('tokenAddress'):
                                        tokens.setdefault(v['chain'],set()).add(v['tokenAddress'])
                                        if row['kind']=='holdings':held.setdefault(v['chain'],set()).add(v['tokenAddress'])
                            cache=TokenCache(db)
                            for chain,addresses in held.items():cache.enrich(chain,sorted(addresses))
                            for chain,addresses in tokens.items():cache.enrich(chain,sorted(addresses-held.get(chain,set())),need_price=False)
                        db.fomo_analysis_edge_metadata_jobs.update_one({'_id':job['_id']},{'$set':{'status':'completed','completed_at':now()}})
                except Exception:
                    if job:db.fomo_analysis_edge_metadata_jobs.update_one({'_id':job['_id']},{'$set':{'status':'failed'}})
                self.stop.wait(2)
        finally:client.close()

    def loop(self):
        client,db=database()
        db.fomo_analysis_edge_candle_jobs.create_index([('provider',1),('chain',1),('token_address',1)])
        db.fomo_analysis_edge_candles.create_index([('chain',1),('token_address',1),('interval',1),('open_time',1)])
        db.fomo_analysis_edge_analysis_logs.create_index([('normalized_wallet',1),('cache_revision',1),('completed_at',-1)])
        try:
            while not self.stop.is_set():
                try:
                    db[COLLECTION].update_many({'kind':'fresh_scan','status':'running','lease_until':{'$lt':now()},'attempts':{'$gte':3}},
                        {'$set':{'status':'failed','failure':{'code':'retry_limit','message':'The worker could not finish after recovery attempts. Please submit a new scan.'}}})
                    # One global worker lease bounds expensive provider calls across Railway replicas.
                    owner=uuid.uuid4().hex
                    try:
                        lock=db.fomo_analysis_edge_worker_locks.find_one_and_update({'_id':'pipeline','expires_at':{'$lt':now()}},{'$set':{'expires_at':now()+timedelta(seconds=120),'owner':owner}},upsert=True,return_document=ReturnDocument.AFTER)
                    except Exception:lock=None
                    if not lock:self.stop.wait(2);continue
                    scan=db[COLLECTION].find_one_and_update({'kind':'fresh_scan','contract_version':1,'$or':[{'status':'queued'},{'status':'running','lease_until':{'$lt':now()}}]},
                        {'$set':{'status':'running','lease_owner':owner,'lease_until':now()+timedelta(seconds=90),'active_stage':'resolve_fomo_identity','failure':None},'$inc':{'attempts':1}},sort=[('scan_started_at',1)],return_document=ReturnDocument.AFTER)
                    if scan:
                        lock_stop=threading.Event()
                        def refresh_lock():
                            while not lock_stop.wait(20):
                                try:db.fomo_analysis_edge_worker_locks.update_one({'_id':'pipeline','owner':owner},{'$set':{'expires_at':now()+timedelta(seconds=120)}})
                                except Exception:return
                        lock_thread=threading.Thread(target=refresh_lock,daemon=True);lock_thread.start()
                        try:process_one(db,scan)
                        finally:lock_stop.set();lock_thread.join(timeout=1)
                    db.fomo_analysis_edge_worker_locks.update_one({'_id':'pipeline','owner':owner},{'$set':{'expires_at':now()}})
                except Exception:pass # Never log exception bodies containing provider credentials.
                self.stop.wait(1)
        finally:client.close()
    def close(self):self.stop.set()
