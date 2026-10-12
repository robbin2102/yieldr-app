"""Authenticated enqueue acknowledgement; long analysis runs in a durable worker."""
from contextlib import asynccontextmanager
import hmac
import os
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from bootstrap import missing_source
from worker import Worker, database
from engine import MODEL_VERSION,RULE_VERSION,ANALYSIS_VERSION

worker=Worker()
@asynccontextmanager
async def lifespan(app):
    worker.start()
    yield
    worker.close()
app=FastAPI(title='Yieldr Edge Analysis',version='1.0.0',lifespan=lifespan)

def authenticate(authorization):
    secret=os.getenv('YIELDR_INTERNAL_SECRET')
    if not secret:raise HTTPException(503,detail='configuration_unavailable')
    if not authorization or not hmac.compare_digest(authorization,'Bearer '+secret):raise HTTPException(401,detail='unauthorized')

@app.get('/health')
def health():
    required=('MONGODB_URI','YIELDR_INTERNAL_SECRET','ALCHEMY_BASE_RPC_URL','ALCHEMY_BNB_RPC_URL','ALCHEMY_HOOD_RPC_URL','ALCHEMY_SOLANA_RPC_URL')
    complete=not bool(missing_source())
    return {'status':'ok','live_analysis_available':complete and all(os.getenv(k) for k in required),'source_complete':complete}

@app.get('/internal/capabilities')
def capabilities(authorization:str|None=Header(default=None)):
    authenticate(authorization)
    return {'contract_version':1,'analysis_version':ANALYSIS_VERSION,'model_version':MODEL_VERSION,'rule_version':RULE_VERSION,'missing_source':missing_source()}

class ScanRequest(BaseModel):scan_id:str=Field(pattern=r'^[a-f0-9]{64}$')
@app.post('/internal/scans',status_code=202)
def enqueue(request:ScanRequest,authorization:str|None=Header(default=None)):
    authenticate(authorization)
    client,db=database()
    try:
        row=db.fomo_analysis_edge_scan_runs.find_one({'_id':request.scan_id,'kind':'fresh_scan','contract_version':1},{'status':1})
        if not row:raise HTTPException(404,detail='scan_not_found')
        return {'scan_id':request.scan_id,'status':row['status']}
    finally:client.close()
