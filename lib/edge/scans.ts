import 'server-only';
import { reusableScan, SCAN_CACHE_REVISION, SCAN_MAX_AGE_MS } from './scan-cache';
import { randomBytes } from 'node:crypto';
import { edgeDb } from './db';
import { EdgeError } from './config';
import { walletInput } from './domain';
import { newScanRecord, scanDto } from './scan-protocol';
import { dispatchAnalysis } from './analysis-service';
export async function createScan(input: unknown, forceFresh=false) {
  if(!walletInput(input)) throw new EdgeError('invalid_wallet',400);
  if(forceFresh && process.env.NODE_ENV==='production' && process.env.EDGE_ALLOW_FORCE_FRESH!=='true')
    throw new EdgeError('force_fresh_disabled',403);
  const db=await edgeDb();
  if(!forceFresh) {
    const wallet=walletInput(input)!.wallet;
    const logs=await db.collection('fomo_analysis_edge_analysis_logs').find({normalized_wallet:wallet,cache_revision:SCAN_CACHE_REVISION,completed_at:{$gt:new Date(Date.now()-SCAN_MAX_AGE_MS).toISOString()}},{maxTimeMS:5000}).sort({completed_at:-1}).limit(5).toArray();
    for(const log of logs) {
      const saved=await db.collection('fomo_analysis_edge_scan_runs').findOne({_id:log.scan_id as any});
      if(saved && reusableScan(log,saved,wallet)) {
        const output=await db.collection('fomo_analysis_edge_scan_outputs').findOne({scan_id:log.scan_id,normalized_wallet:wallet,generation:log.generation,kind:'result'},{projection:{'payload.identity':1},maxTimeMS:5000});
        const identity=output?.payload?.identity;
        if(identity && (identity.evmWallet===wallet || identity.solanaWallet===wallet)) return {...scanDto(saved),cached:true};
      }
    }
  }
  const row=newScanRecord(input as string,randomBytes(32).toString('hex'),new Date(),forceFresh);
  await db.collection('fomo_analysis_edge_scan_runs').insertOne(row as any);
  try { await dispatchAnalysis(row.scan_id); }
  catch(error) {
    const code=error instanceof EdgeError?error.code:'analysis_service_unavailable';
    // A transport timeout is ambiguous: leave the durable queue for the worker to claim.
    if(code==='configuration_unavailable') await db.collection('fomo_analysis_edge_scan_runs').updateOne(
      {_id:row.scan_id as any,status:'queued'},{$set:{status:'blocked',failure:{code,message:'The analysis worker is not configured. This wallet has not been analyzed.'}}});
  }
  return getScan(row.scan_id);
}
export async function getScanRecord(id:string) {
  if(!/^[a-f0-9]{64}$/.test(id)) throw new EdgeError('invalid_scan',400);
  const row=await (await edgeDb()).collection('fomo_analysis_edge_scan_runs').findOne({_id:id as any},{maxTimeMS:5000});
  if(!row || row.kind==='rate_limit') throw new EdgeError('scan_not_found',404);
  return row;
}
export async function getScan(id:string) { return scanDto(await getScanRecord(id)); }
