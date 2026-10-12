import { MODEL_VERSION, RULE_VERSION } from './domain';
export const SCAN_CACHE_REVISION = 'submitted-wallet-v2';
export const SCAN_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export function reusableScan(log:Record<string,any>, scan:Record<string,any>, wallet:string, now=new Date()) {
  const coverage=log.price_coverage||{};
  // Recompute scans affected by the old restricted token-history endpoint.
  if(coverage.access_blocked || (!coverage.provider && coverage.provider_calls>0 && coverage.missing_windows>0)) return false;
  const age=now.getTime()-Date.parse(log.completed_at);
  return age>=0 && age<SCAN_MAX_AGE_MS && log.normalized_wallet===wallet &&
    log.cache_revision===SCAN_CACHE_REVISION && log.model_version===MODEL_VERSION && log.rule_version===RULE_VERSION &&
    scan.status==='completed' && scan.kind==='fresh_scan' && scan.normalized_wallet===wallet &&
    scan.result_generation===log.generation && scan.result_summary_id===log.scan_id &&
    scan.scope==='submitted_wallet' && scan.scan_id===log.scan_id;
}
