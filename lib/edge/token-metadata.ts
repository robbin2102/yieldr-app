import 'server-only';
import {edgeDb} from './db';
import {json} from './domain';
function multiply(a:string,b:string):string|null {
  const parse=(s:string)=>{const m=/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);if(!m)return null;const scale=(m[2]?.length||0)-Number(m[3]||0);if(Math.abs(scale)>300)return null;return {n:BigInt(m[1]+(m[2]||'')),scale};};
  const x=parse(a),y=parse(b);if(!x||!y)return null;let digits=(x.n*y.n).toString(),scale=x.scale+y.scale;
  if(scale<=0)return digits+'0'.repeat(-scale);digits=digits.padStart(scale+1,'0');return digits.slice(0,-scale)+'.'+digits.slice(-scale);
}
export async function enrichOutput(kind:string,payload:any,scan:Record<string,any>) {
  const items=kind==='holdings'?payload.items:kind==='stories'?payload.items:payload;
  if(!Array.isArray(items)||!items.length)return payload;
  const db=await edgeDb();
  const pairs=items.filter((p:any)=>p.tokenAddress).map((p:any)=>({chain:p.chain,token_address:p.chain==='solana'?p.tokenAddress:p.tokenAddress.toLowerCase()}));
  if(!pairs.length)return payload;
  const records=await db.collection('fomo_analysis_tokens').find({$or:pairs},{maxTimeMS:5000}).toArray();
  const map=new Map(records.map(r=>[r.chain+':'+r.token_address,json(r) as any]));
  for(const item of items){const r=map.get(item.chain+':'+(item.chain==='solana'?item.tokenAddress:item.tokenAddress?.toLowerCase()));if(!r)continue;
    if(kind==='positions')item.tokenSymbol=r.symbol||item.tokenSymbol;
    else item.symbol=r.symbol||item.symbol;
    if(kind==='holdings'){
      const native=item.assetType==='native';Object.assign(item,{name:native?'Solana':r.name,imageUrl:r.image_url,priceObservedAt:r.price_observed_at,marketDataStatus:r.market_data_status});
      if(native)item.symbol='SOL';
      if(r.current_price_usd!==null && r.current_price_usd!==undefined){item.price=String(r.current_price_usd);item.value=multiply(String(item.quantity),item.price);}
    }
  }
  if(kind==='holdings') {
    payload.stale=!payload.observedAt || Date.now()-Date.parse(payload.observedAt)>300000;
    // Durable deduplicated request; a separate worker refreshes without blocking the response.
    const bucket=Math.floor(Date.now()/300000);
    await db.collection('fomo_analysis_edge_metadata_jobs').updateOne({_id:`${scan.scan_id}:${bucket}` as any},{$setOnInsert:{scan_id:scan.scan_id,generation:scan.result_generation,normalized_wallet:scan.normalized_wallet,status:'queued',created_at:new Date(),expires_at:new Date(Date.now()+86400000)}},{upsert:true});
  }
  return payload;
}
