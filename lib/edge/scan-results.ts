import 'server-only';
import {enrichOutput} from './token-metadata';
import { edgeDb } from './db';
import { getScanRecord } from './scans';
import { ownedResultFilter } from './scan-protocol';
import { EdgeError } from './config';
import { json } from './domain';
export async function readScanOutput(id:string,kind:'result'|'positions'|'holdings'|'stories',offset=0) {
  const scan=await getScanRecord(id);
  let filter;
  try {filter=ownedResultFilter(scan);}catch{throw new EdgeError('analysis_pending',409);}
  const collection=(await edgeDb()).collection('fomo_analysis_edge_scan_outputs');
  if(kind==='result'||kind==='holdings') {
    const row=await collection.findOne({...filter,kind},{projection:{_id:0,payload:1},maxTimeMS:5000});
    if(!row) throw new EdgeError('result_unavailable',404);
    return kind==='holdings'?enrichOutput(kind,json(row.payload),scan):json(row.payload);
  }
  const rows=await collection.find({...filter,kind},{projection:{_id:0,payload:1},maxTimeMS:8000})
    .sort({ordinal:1}).skip(kind==='stories'?offset:0).limit(kind==='stories'?21:10001).toArray();
  if(kind==='positions'&&rows.length>10000)throw new EdgeError('result_too_large',413);
  if(kind==='stories') {
    const holdings=await collection.findOne({...filter,kind:'holdings'},{projection:{payload:1},maxTimeMS:5000});
    const states=new Map((holdings?.payload?.reconciliation||[]).map((r:any)=>[r.episodeId,r.status]));
    return enrichOutput(kind,{items:rows.slice(0,20).map(r=>({...json(r.payload) as object,currentBalanceStatus:states.get(r.payload.episodeId)||null})),nextOffset:rows.length>20?offset+20:null},scan);
  }
  return enrichOutput(kind,rows.map(r=>json(r.payload)),scan);
}
