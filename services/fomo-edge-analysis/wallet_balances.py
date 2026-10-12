"""Live balances, with native SOL distinct from wrapped SOL token inventory."""
from decimal import Decimal
from scripts.build_portfolio_snapshot import TOKEN_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT

def solana_balances(rpc,wallet):
    totals={}
    for program in (TOKEN_PROGRAM,TOKEN_2022_PROGRAM):
        response=rpc.call('getTokenAccountsByOwner',[wallet,{'programId':program},{'encoding':'jsonParsed'}])
        for account in response.get('value',[]):
            info=account['account']['data']['parsed']['info'];amount=info['tokenAmount'];mint=info['mint']
            row=totals.setdefault(mint,{'token_address':mint,'quantity':Decimal(0),'decimals':int(amount['decimals']),'symbol':None,'name':None,'assetType':'token'})
            row['quantity']+=Decimal(amount['uiAmountString'])
    rows=[r for r in totals.values() if r['quantity']>0]
    native=rpc.call('getBalance',[wallet]).get('value',0)
    if native:rows.append({'token_address':WSOL_MINT,'quantity':Decimal(native)/Decimal(10**9),'decimals':9,'symbol':'SOL','name':'Solana','assetType':'native'})
    return rows

def evm_balances(rpc,wallet,cache,chain,on_batch=None):
    """Reuse known decimals; batch only unknown metadata rather than rereading every coin."""
    raw=[];page=None
    while True:
        params=[wallet,'erc20']+([{'pageKey':page}] if page else [])
        result=rpc.call('alchemy_getTokenBalances',params)
        raw.extend(r for r in result.get('tokenBalances',[]) if not r.get('error') and int(r.get('tokenBalance') or '0x0',16)>0)
        page=result.get('pageKey')
        if not page:break
    known=cache.read(chain,[r['contractAddress'] for r in raw])
    def converted():
        rows=[]
        for r in raw:
            address=r['contractAddress'].lower();meta=known.get(address,{})
            if meta.get('decimals') is None:continue
            rows.append({'token_address':address,'quantity':Decimal(int(r['tokenBalance'],16))/Decimal(10)**int(meta['decimals']),'decimals':meta['decimals'],'symbol':meta.get('symbol'),'name':meta.get('name')})
        return rows
    def updated(records):
        known.update(records)
        if on_batch:on_batch(converted())
    missing=list(dict.fromkeys(r['contractAddress'].lower() for r in raw if known.get(r['contractAddress'].lower(),{}).get('decimals') is None))
    if on_batch:on_batch(converted())
    # A single bulk market request supplies names, decimals and prices for new coins.
    if missing:updated(cache.enrich(chain,missing,on_batch=updated))
    missing=[a for a in missing if known.get(a,{}).get('decimals') is None]
    # Unsupported pools can still have a verified balance via RPC metadata.
    for start in range(0,len(missing),50):
        group=missing[start:start+50]
        for address,details in zip(group,rpc.batch_call('alchemy_getTokenMetadata',[[a] for a in group]),strict=True):
            if details and details.get('decimals') is not None:
                known[address]=details
                cache.db.fomo_analysis_tokens.update_one({'chain':chain,'token_address':address},{'$set':{'decimals':details['decimals']},'$setOnInsert':{'name':details.get('name'),'symbol':details.get('symbol')}},upsert=True)
        if on_batch:on_batch(converted())
    return converted()
