"""Local-only launcher: read allowlisted server configuration without copying secrets."""
import argparse
import os
from pathlib import Path
from dotenv import dotenv_values

RPC_AND_PRICES=('ALCHEMY_BASE_RPC_URL','ALCHEMY_BNB_RPC_URL','ALCHEMY_HOOD_RPC_URL','ALCHEMY_SOLANA_RPC_URL','COINGECKO_API_KEY','COINGECKO_API_PLAN')
APP_VARIABLES=('MONGODB_URI','MONGODB_DATABASE','YIELDR_INTERNAL_SECRET')
def configure(source_env,app_env):
    source=dotenv_values(source_env);app=dotenv_values(app_env)
    for key in RPC_AND_PRICES:
        if source.get(key):os.environ[key]=source[key]
    for key in APP_VARIABLES:
        value=app.get(key) or source.get(key)
        if value:os.environ[key]=value
    # Ownership always comes from the queued scan, never TARGET_WALLET variables.
    return [key for key in (*RPC_AND_PRICES[:4],'MONGODB_URI','YIELDR_INTERNAL_SECRET') if not os.getenv(key)]
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source-env',type=Path,required=True);parser.add_argument('--port',type=int,default=8001);args=parser.parse_args()
    missing=configure(args.source_env,Path(__file__).resolve().parents[2]/'.env.local')
    if missing:raise SystemExit('Missing server variable names: '+', '.join(missing))
    import uvicorn
    uvicorn.run('main:app',host='127.0.0.1',port=args.port,log_level='warning')
