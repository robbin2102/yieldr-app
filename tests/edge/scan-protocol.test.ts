import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newScanRecord,ownedResultFilter,scanDto,STAGES} from '../../lib/edge/scan-protocol';
const wallet='0x085d22d9d77ac81ee8fa3472aa45a6e51676a9a0';
test('new scans retain the submitted wallet and freeze a complete current 90-day window',()=>{
  const now=new Date('2026-10-12T12:00:00Z');const a=newScanRecord(wallet,'a',now),b=newScanRecord(wallet,'b',new Date(now.getTime()+1000),true);
  assert.equal(a.normalized_wallet,wallet);assert.notEqual(a.scan_id,b.scan_id);assert.notEqual(a.window_end,b.window_end);
  assert.equal(Date.parse(a.window_end)-Date.parse(a.window_start),90*86400000);assert.equal(b.force_fresh,true);
  assert.equal(a.result_summary_id,null);assert.equal(scanDto(a).status,'queued');assert.equal(STAGES.length,20);
});
test('main outputs require exact scan, wallet and committed result generation',()=>{
  const a=newScanRecord(wallet,'a',new Date());assert.throws(()=>ownedResultFilter(a));
  assert.deepEqual(ownedResultFilter({...a,status:'completed',result_generation:'worker1',result_summary_id:'a'}),{scan_id:'a',normalized_wallet:wallet,generation:'worker1'});
  assert.throws(()=>ownedResultFilter({scanId:'old',summaryId:'ranked-trader',status:'completed'}));
});
test('legacy cached runs cannot continue to present a main wallet result',()=>{
  const dto=scanDto({scanId:'old',wallet,summaryId:'historical',status:'completed'});
  assert.equal(dto.status,'blocked');assert.equal(dto.summaryId,null);assert.match(dto.message!,/legacy/);
});
