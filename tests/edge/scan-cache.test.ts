import {test} from 'node:test';import assert from 'node:assert/strict';
import {reusableScan,SCAN_CACHE_REVISION,SCAN_MAX_AGE_MS} from '../../lib/edge/scan-cache';
import {MODEL_VERSION,RULE_VERSION} from '../../lib/edge/domain';
const now=new Date('2026-10-13T00:00:00Z');
const scan={status:'completed',kind:'fresh_scan',normalized_wallet:'wallet',result_generation:'g',result_summary_id:'id',scope:'submitted_wallet',scan_id:'id'};
const log={completed_at:new Date(now.getTime()-1000).toISOString(),normalized_wallet:'wallet',generation:'g',scan_id:'id',cache_revision:SCAN_CACHE_REVISION,model_version:MODEL_VERSION,rule_version:RULE_VERSION};
test('only completed compatible same-wallet generations younger than 72h can be reused',()=>{
 assert.ok(reusableScan(log,scan,'wallet',now));
 for(const changes of [{status:'failed'},{status:'running'},{scope:'linked_wallets'},{result_generation:'old'},{normalized_wallet:'other'}])assert.equal(reusableScan(log,{...scan,...changes},'wallet',now),false);
 for(const changes of [{completed_at:new Date(now.getTime()-SCAN_MAX_AGE_MS).toISOString()},{completed_at:new Date(now.getTime()+1).toISOString()},{model_version:'old'},{cache_revision:'old'},{normalized_wallet:'other'},{rule_version:'old'}])assert.equal(reusableScan({...log,...changes},scan,'wallet',now),false);
});

test('historical price access failures are not reused for three days',()=>{
 assert.equal(reusableScan({...log,price_coverage:{provider_calls:50,cached_or_fetched_candles:18518,missing_windows:272}},scan,'wallet',now),false);
 assert.equal(reusableScan({...log,price_coverage:{provider:'geckoterminal_pool',access_blocked:true}},scan,'wallet',now),false);
 assert.ok(reusableScan({...log,price_coverage:{provider:'geckoterminal_pool',provider_calls:1,cached_or_fetched_candles:0,missing_windows:1}},scan,'wallet',now));
});
