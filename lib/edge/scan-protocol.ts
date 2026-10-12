import { walletInput } from './domain';
import type { Scan } from '@/types/edge';
export const STAGES = [
  'validate_wallet','resolve_fomo_identity','resolve_linked_wallets','fetch_90d_chain_activity',
  'extract_fomo_trade_legs','reconcile_trade_legs','deduplicate_economic_actions','classify_external_inventory',
  'reconstruct_fifo_inventory','build_position_episodes','load_or_backfill_ohlc','compute_action_features',
  'compute_episode_features','evaluate_pattern_catalog','apply_validation_and_readiness_gates',
  'build_action_assessments','build_position_stories','fetch_current_holdings','compute_edge_print','persist_completed_scan',
] as const;
export function newScanRecord(input: string, id: string, now: Date, forceFresh = false) {
  const normalized = walletInput(input);
  if (!normalized) throw new Error('invalid_wallet');
  return {
    _id:id,kind:'fresh_scan',contract_version:1,scope:'submitted_wallet',cache_revision:'submitted-wallet-v2',scan_id:id,input_wallet:input.trim(),
    normalized_wallet:normalized.wallet,wallet_type:normalized.type,linked_trader_id:null,
    linked_wallets:{evm:normalized.type==='evm'?normalized.wallet:null,solana:normalized.type==='solana'?normalized.wallet:null},
    chains_analyzed:[],window_start:new Date(now.getTime()-90*86400000).toISOString(),window_end:now.toISOString(),
    scan_started_at:now.toISOString(),created_at:now.toISOString(),updated_at:now.toISOString(),force_fresh:forceFresh,
    status:'queued',completed_stages:[{key:'validate_wallet',completed_at:now.toISOString()}],
    active_stage:null,counts:{},price_coverage:{},analysis_version:null,model_version:null,rule_version:null,
    result_summary_id:null,result_generation:null,classification:'known_fomo_analysis_pending',failure:null,
    coverage_disclosure:normalized.type==='solana'?'Solana wallet analysis':'EVM wallet analysis',
  };
}
export function scanDto(row: Record<string,any>): Scan {
  if(row.kind!=='fresh_scan') return {
    scanId:String(row.scanId||row._id),wallet:String(row.wallet||''),status:'blocked',classification:'known_fomo_analysis_pending',
    cached:false,analysisTimestamp:null,summaryId:null,createdAt:String(row.createdAt||''),stages:[],
    message:'This is a legacy saved-data scan. Submit your wallet again to start a fresh analysis.',
  };
  return {scanId:row.scan_id,wallet:row.normalized_wallet,inputWallet:row.input_wallet,walletType:row.wallet_type,
    linkedWallets:row.linked_wallets,identityName:row.identity_name||null,chains:row.chains_analyzed,
    windowStart:row.window_start,windowEnd:row.window_end,forceFresh:row.force_fresh,
    status:row.status,cached:row.cache_reused===true,classification:row.classification,
    analysisTimestamp:row.completed_at||null,summaryId:row.status==='completed'?row.result_summary_id:null,
    createdAt:row.scan_started_at,message:row.failure?.message||null,failureCode:row.failure?.code||null,
    stages:row.completed_stages.map((s:any)=>({key:s.key,label:s.key.replaceAll('_',' '),completedAt:s.completed_at})),
    totalStages:STAGES.length,activeStage:row.active_stage,counts:row.counts,coverageDisclosure:row.coverage_disclosure,
    preview:row.preview||null,modelVersion:row.model_version,ruleVersion:row.rule_version};
}
/** Never resolve a main result through a trader-summary collection. */
export function ownedResultFilter(scan: Record<string,any>) {
  if(scan.kind!=='fresh_scan'||scan.status!=='completed'||!scan.result_generation||!scan.result_summary_id)
    throw new Error('analysis_pending');
  return {scan_id:scan.scan_id,normalized_wallet:scan.normalized_wallet,generation:scan.result_generation};
}
