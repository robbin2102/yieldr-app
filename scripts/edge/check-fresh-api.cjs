// Live acceptance: real fresh job, fixed submission window, scan-owned V3.3 outputs.
const assert=require('node:assert/strict');
const base=process.env.EDGE_TEST_BASE_URL||'http://127.0.0.1:3100';
const wallet='0x085d22d9d77ac81ee8fa3472aa45a6e51676a9a0';
const solana='2w8StCWiNWvvqxcir3FmVzrG6Y4iHBT4bRp6eN814gJd';
async function read(path){const r=await fetch(base+path);assert.equal(r.status,200);return r.json()}
(async()=>{
 const before=Date.now();
 const response=await fetch(base+'/api/edge/scans',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({wallet,forceFresh:true})});
 assert.equal(response.status,200);const initial=await response.json();
 assert.ok(Date.parse(initial.windowEnd)>=before);assert.equal(initial.forceFresh,true);
 assert.equal(Date.parse(initial.windowEnd)-Date.parse(initial.windowStart),90*86400000);
 let scan=initial,last='';const deadline=Date.now()+25*60*1000;
 console.log(JSON.stringify({scanId:scan.scanId,windowEnd:scan.windowEnd}));
 while(['queued','running'].includes(scan.status)&&Date.now()<deadline){
  const stage=scan.activeStage||scan.status;if(stage!==last){console.log(JSON.stringify({stage,completed:scan.stages.length}));last=stage;}
  await new Promise(r=>setTimeout(r,2000));scan=await read('/api/edge/scans/'+scan.scanId);
 }
 assert.equal(scan.status,'completed',scan.message||'Scan did not complete before the test timeout');
 assert.equal(scan.identityName,'eyezenhour');assert.equal(scan.wallet,wallet);assert.equal(scan.linkedWallets.solana,null);assert.equal(scan.stages.length,20);
 const root='/api/edge/scans/'+scan.scanId;
 const [result,positions,holdings,stories,top]=await Promise.all([read(root+'/result'),read(root+'/positions'),read(root+'/holdings'),read(root+'/stories'),read('/api/edge/traders/validated?limit=3')]);
 assert.equal(result.identity.evmWallet,wallet);assert.equal(result.identity.solanaWallet,null);
 assert.equal(result.summaryId,scan.scanId);assert.equal(result.windowEnd,initial.windowEnd);
 assert.equal(result.modelVersion,'3.3.0');assert.equal(result.ruleVersion,'2026-09-09.2');
 assert.ok(result.sourceHashes['fomo_analysis/v3_3_pattern_engine.py']);
 assert.equal(positions.length,result.closedPositions);
 for(const p of positions){assert.ok(p.episodeId.startsWith(result.identity.id+':'));assert.ok(Date.parse(p.closedAt)>=Date.parse(result.windowStart)&&Date.parse(p.closedAt)<=Date.parse(result.windowEnd));}
 for(const h of holdings.items)assert.equal(h.wallet,h.chain==='solana'?solana:wallet);
 for(const s of stories.items)assert.ok(s.episodeId.startsWith(result.identity.id+':'));
 if(!result.economicActions){assert.equal(result.classification,'insufficient_behavior_sample');assert.ok(result.findings.some(f=>f.n===0));assert.ok(!result.findings.some(f=>f.status.startsWith('validated_')));}
 assert.ok(top.traders.length);
 const report={status:'passed',scanId:scan.scanId,identity:scan.identityName,windowStart:result.windowStart,windowEnd:result.windowEnd,model:result.modelVersion,rule:result.ruleVersion,stages:scan.stages.length,counts:scan.counts,classification:result.classification,holdingsStatus:holdings.status,topTraderCount:top.traders.length};
 require('fs').writeFileSync('/tmp/yieldr-v33-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error('Fresh API assertion failed:',e.message);process.exitCode=1});
