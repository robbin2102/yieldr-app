"""Fresh recomputation using the audited V3.3 implementation, with scan-scoped DTOs."""
from collections import defaultdict
from dataclasses import replace
from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import bootstrap
from protocol import ScanFailure, STAGES, time, now, serial, decimal, normalize_wallet
from fomo_analysis.normalization import load_normalized_trades
from fomo_analysis.inventory import InventoryEvent, replay_inventory
from fomo_analysis.positions import reconstruct_positions
from fomo_analysis.features import build_behavior_features
from fomo_analysis.price_features import build_entry_price_features, build_episode_price_features
from fomo_analysis.advanced_features import build_episode_feature_rows, build_entry_state_rows, build_trader_economics
from fomo_analysis.action_analysis import classify_economic_actions, build_action_feature_rows
from fomo_analysis.pattern_readiness import assess_pattern_readiness
from fomo_analysis.pattern_validation import validate_entry_patterns
from fomo_analysis.v3_3_pattern_engine import MODEL_VERSION,RULE_VERSION,run_v3_3_pattern_engine
from fomo_analysis.v3_3_economics import attribute_realized_action_economics, attach_realized_economics
from fomo_analysis import ANALYSIS_VERSION
from fomo_analysis.v3_3_stories import build_v3_3_action_assessments,build_v3_3_position_stories

SOURCE_MANIFEST=json.loads((bootstrap.ROOT/'manifest.json').read_text())
SOURCE_HASHES=SOURCE_MANIFEST['files']

def run_pipeline(scan,db,inputs,checkpoint):
    """Each callback follows actual work. No completed summary is ever consulted."""
    scan=dict(scan);wallet,kind=normalize_wallet(scan['normalized_wallet'])
    if wallet!=scan['normalized_wallet'] or kind!=scan['wallet_type']:raise ScanFailure('wallet_mismatch','The scan wallet could not be verified.')
    checkpoint('validate_wallet')
    profile=db.fomo_analysis_traders.find_one({'evm_wallet' if kind=='evm' else 'solana_wallet':wallet})
    scan['profile']=profile
    scan['linked_trader_id']=profile.get('trader_id') if profile else None
    scan['identity_name']=(profile.get('username') or profile.get('x_handle')) if profile else None
    checkpoint('resolve_fomo_identity',linked_trader_id=scan['linked_trader_id'],identity_name=scan['identity_name'])
    linked={'evm':wallet if kind=='evm' else None,'solana':wallet if kind=='solana' else None}
    scan['linked_wallets']=linked
    scan['analysis_trader_id']=f"evm:{linked['evm'] or ''}|solana:{linked['solana'] or ''}"
    scan['chains_analyzed']=(['base','bnb','robinhood'] if linked['evm'] else [])+(['solana'] if linked['solana'] else [])
    disclosure='Solana wallet analysis' if kind=='solana' else 'EVM wallet analysis'
    checkpoint('resolve_linked_wallets',linked_wallets=linked,chains_analyzed=scan['chains_analyzed'],coverage_disclosure=disclosure,
               scope='submitted_wallet',cache_revision='submitted-wallet-v2',analysis_version=ANALYSIS_VERSION,model_version=MODEL_VERSION,rule_version=RULE_VERSION,source_hashes=SOURCE_HASHES)
    raw_count=inputs.fetch(scan)
    checkpoint('fetch_90d_chain_activity',counts={'raw_activity':raw_count})
    rows=inputs.extract(scan)
    checkpoint('extract_fomo_trade_legs',counts={'extracted_trade_legs':len(rows)})
    start,end=time(scan['window_start']),time(scan['window_end'])
    rows=[r for r in rows if start<=time(r['timestamp'])<=end and r['chain'] in scan['chains_analyzed']]
    if not profile and not rows:raise ScanFailure('non_fomo_or_unindexed','This wallet is not currently recognized as a supported Fomo trading wallet. Edge Detection currently supports Fomo wallet activity on Base, BNB Chain, Robinhood Chain and Solana.')
    # Source parsers deduplicate raw transfer identities. Keep distinct equal-sized
    # legs within one transaction; normalization gives each its own leg index.
    payload={'evm_wallet':linked['evm'] or '', 'solana_wallet':linked['solana'] or '', 'trades':rows}
    with TemporaryDirectory(prefix='edge-normalize-') as directory:
        p=Path(directory)/'trades.json';p.write_text(json.dumps(serial(payload)))
        _,trades=load_normalized_trades(p)
    if any(t.wallet!=linked['solana' if t.chain=='solana' else 'evm'] for t in trades):raise ScanFailure('wallet_mismatch','Trade ownership could not be verified.')
    checkpoint('reconcile_trade_legs',counts={'unusable_trade_legs':len(rows)-len(trades),'atomically_priced_trade_legs':sum(t.usd_notional is not None for t in trades)})
    trades=list({t.trade_id:t for t in trades}.values())
    checkpoint('deduplicate_economic_actions',counts={'trade_legs':len(trades)})
    external,uncertain=inputs.external_inventory(scan,trades)
    checkpoint('classify_external_inventory',counts={'external_inventory_events':len(external)})
    events=defaultdict(list)
    for e in external:events[(e.chain,e.token_address)].append(e)
    for t in trades:events[(t.chain,t.token_address)].append(InventoryEvent(t.trade_id,t.trader_id,t.chain,t.token_address,t.timestamp,'verified_purchase' if t.side=='BUY' else 'verified_sale',t.token_amount,t.usd_notional))
    ledgers={key:replay_inventory(values) for key,values in events.items()}
    uncertain=set(uncertain)|{k for k,v in ledgers.items() if v.warnings or v.excluded_unknown_cost_quantity_sold>0}
    # The source's episode engine is trade-only. Transfer-contaminated token economics
    # must stay hollow rather than attributing receipts to purchased inventory.
    safe_trades=[replace(t,usd_notional=None,execution_price_usd=None) if (t.chain,t.token_address) in uncertain else t for t in trades]
    if hasattr(inputs,'preview'):inputs.preview(liveProgress={'phase':'grouping','current':len(trades),'total':len(trades),'unit':'trade legs matched'})
    checkpoint('reconstruct_fifo_inventory')
    reconstruction=reconstruct_positions(safe_trades);episodes=reconstruction.episodes
    closed=[e for e in episodes if e.closed_at];tokens={(e.chain,e.token_address) for e in closed}
    checkpoint('build_position_episodes',counts={'closed_positions':len(closed),'open_positions':len(episodes)-len(closed),'tokens_traded':len({(t.chain,t.token_address) for t in trades})})
    positions=[]
    for ep in sorted(closed,key=lambda e:e.closed_at):
        reliable=ep.realized_pnl_usd is not None and (ep.chain,ep.token_address) not in uncertain
        cost=ep.buy_notional_usd if reliable else None
        positions.append({'episodeId':ep.as_document()['episode_id'],'chain':ep.chain,'tokenAddress':ep.token_address,'tokenSymbol':ep.token_symbol,
            'openedAt':serial(ep.opened_at),'closedAt':serial(ep.closed_at),'realizedPnlUsd':decimal(ep.realized_pnl_usd) if reliable else None,
            'verifiedAcquisitionCostUsd':decimal(cost),'returnPct':decimal(ep.realized_pnl_usd/cost*100) if reliable and cost else None,
            'pricingStatus':'priced' if reliable else 'unavailable','includedInDollarTotals':reliable,'buyCount':ep.buy_count,'sellCount':ep.sell_count})
    inputs.preview_positions=positions[:1000]
    if hasattr(inputs,'preview'):inputs.preview(positions=[],actionsProcessed=len(trades),liveProgress={'phase':'market','current':0,'total':len(positions),'unit':'positions ready'})
    if getattr(inputs,'enrichment',None):inputs.enrichment.submit(inputs.enrich_positions,episodes)
    candles,coverage=inputs.candles(scan,safe_trades)
    if hasattr(inputs,'preview'):inputs.preview(positions=positions[:1000])
    checkpoint('load_or_backfill_ohlc',price_coverage=coverage)
    entry_prices=build_entry_price_features(safe_trades,candles)
    actions=classify_economic_actions(safe_trades,reconstruction)
    action_rows=build_action_feature_rows(actions,candles,entry_prices,as_of=end)
    checkpoint('compute_action_features',counts={'economic_actions':len(actions)})
    episode_prices=build_episode_price_features(episodes,candles)
    episode_rows=build_episode_feature_rows(safe_trades,episodes,episode_prices)
    entry_rows=build_entry_state_rows(safe_trades,reconstruction,entry_prices,episode_rows)
    behavior=build_behavior_features(safe_trades,reconstruction)
    readiness=assess_pattern_readiness(entry_prices,episode_prices)
    # Keep the source's thresholds and pattern definitions; only classification distinguishes
    # thin behavioral history from unavailable price coverage.
    low_sample=len(closed)<readiness['thresholds']['minimum_complete_episode_count'] or len(tokens)<readiness['thresholds']['minimum_complete_episode_token_count']
    classification='insufficient_behavior_sample' if low_sample else 'analyzed_fomo_wallet' if readiness['status']=='ready' else 'blocked_price_coverage'
    # Match the source runner: action features include enriched trader state.
    action_rows=attach_realized_economics(build_action_feature_rows(actions,candles,entry_rows,as_of=end),attribute_realized_action_economics(actions))
    economics=build_trader_economics(safe_trades,episode_rows)
    checkpoint('compute_episode_features')
    eligible_episodes=[r for r in episode_rows if (r['chain'],r['token_address']) not in uncertain]
    eligible_actions=[r for r in action_rows if (r['chain'],r['token_address']) not in uncertain]
    if hasattr(inputs,'preview'):inputs.preview(liveProgress={'phase':'testing','current':len(actions),'total':len(actions),'unit':'actions being tested'})
    engine=run_v3_3_pattern_engine(eligible_actions,eligible_episodes,economics)
    legacy_validation=validate_entry_patterns(entry_rows)
    checkpoint('evaluate_pattern_catalog')
    if hasattr(inputs,'preview'):inputs.preview(findings=[finding_dto(p) for p in engine['patterns'] if p['finding_status'] in ('validated_positive_edge','validated_risk_pattern','observed_behavior','observed_risk')])
    # V3.3's own per-pattern gates are authoritative; do not overwrite its findings.
    if any(p['publication']['is_validated_edge'] for p in engine['patterns']):
        classification='analyzed_fomo_wallet';low_sample=False
    checkpoint('apply_validation_and_readiness_gates',classification=classification)
    assessments=build_v3_3_action_assessments(scan['analysis_trader_id'],action_rows,engine['patterns'],assessed_at=now())
    checkpoint('build_action_assessments')
    stories=build_v3_3_position_stories(action_rows,assessments,episode_rows,engine['patterns'])
    checkpoint('build_position_stories')
    holdings=inputs.final_holdings(scan,episodes,ledgers) if hasattr(inputs,'final_holdings') else inputs.holdings(scan,episodes,ledgers)
    # Snapshots from previous runs cannot enter this adapter.
    if holdings['status']=='available' and (not holdings.get('observedAt') or time(holdings['observedAt'])<end):raise ScanFailure('stale_holdings','Current holdings could not be verified at scan time.')
    checkpoint('fetch_current_holdings',counts={'current_holdings':len(holdings['items'])})
    economics=build_trader_economics(safe_trades,episode_rows)
    findings=[finding_dto(p) for p in engine['patterns']]
    if low_sample:findings.append({'id':'observed_activity','name':'Observed trading activity' if actions else 'No verified Fomo trades','description':f'We found {len(closed)} completed positions across {len(tokens)} tokens. That is not enough independent evidence to validate a repeatable edge. These behaviors are observations, not validated patterns.',
        'status':'observed_behavior' if actions else 'insufficient_evidence','n':len(actions),'positions':len(closed),'tokens':len(tokens),'winRate':None,'averageReturn':None,'medianReturn':None,'pnl':None,'health':'insufficient_evidence','failedChecks':readiness['failed_checks'],'evidence':serial(behavior)})
    result={'identity':{'id':scan['analysis_trader_id'],'name':scan['identity_name'] or 'Submitted wallet','evmWallet':linked['evm'],'solanaWallet':linked['solana']},
        'summaryId':scan['scan_id'],'modelVersion':MODEL_VERSION,'ruleVersion':RULE_VERSION,'analysisVersion':ANALYSIS_VERSION,
        'sourceHashes':SOURCE_HASHES,'analyzedAt':serial(now()),'windowStart':scan['window_start'],'windowEnd':scan['window_end'],'windowDays':90,'classification':classification,
        'readiness':{'status':readiness['status'],'failedChecks':readiness['failed_checks'],'evidence':serial({**readiness,'input_coverage':coverage,'legacy_validation':legacy_validation})},
        'economicActions':len(actions),'closedPositions':len(closed),'openPositions':len(episodes)-len(closed),'findings':findings,
        'performance':{'realizedPnl':decimal(sum((Decimal(p['realizedPnlUsd']) for p in positions if p['includedInDollarTotals']),Decimal(0))) if any(p['includedInDollarTotals'] for p in positions) else None,
         'unrealizedPnl':None,'totalPnl':None,'capitalAtStart':None,'openCostBasis':None,
         'winRate':decimal(economics.get('win_rate_percent')),'averageReturn':decimal(economics.get('expectancy_pct')),'medianReturn':decimal(economics.get('median_trade_return_pct')),
         'averageWinner':decimal(economics.get('average_win_pct')),'averageLoser':decimal(economics.get('average_loss_pct')),'payoffRatio':decimal(economics.get('payoff_ratio')),
         'profitFactor':decimal(economics.get('profit_factor')),'provenance':'estimated'},
        'exclusions':{'unattributedDisposals':len(reconstruction.orphan_sells),'partiallyAttributedDisposals':None,'excludedProceeds':None}}
    # Current valuation uses the original V3.3 portfolio/FIFO reporting operations.
    if hasattr(inputs,'pnl_report'):
        report=inputs.pnl_report(scan,trades,holdings,stories,candles)
        result['pnlReporting']=report
        if report:
            verified=report['verified_trade_pnl']
            result['performance'].update(realizedPnl=verified['realized_pnl_usd'],unrealizedPnl=verified['unrealized_pnl_usd'],totalPnl=verified['total_trade_pnl_usd'],provenance='verified_fifo_partial_coverage')
            result['exclusions'].update(unattributedDisposals=report['unattributed_disposals']['event_count'],excludedProceeds=report['unattributed_disposals']['sale_proceeds_excluded_from_trade_pnl_usd'])
    checkpoint('compute_edge_print',counts={'processed_closed_positions':len(positions),'priced_positions':sum(p['includedInDollarTotals'] for p in positions)})
    metadata=getattr(inputs,'token_records',{})
    for p in positions:p['tokenSymbol']=metadata.get((p['chain'],p['tokenAddress']),{}).get('symbol') or p['tokenSymbol']
    story_rows=[story_dto(s,episodes) for s in stories]
    for story in story_rows:story['symbol']=metadata.get((story['chain'],story['tokenAddress']),{}).get('symbol') or story['symbol']
    return {'result':serial(result),'positions':positions,'holdings':serial(holdings),'stories':story_rows,
        'audit':serial({'source_manifest':SOURCE_MANIFEST,'actions':action_rows,'assessments':assessments,'behavior':behavior,'inventory':{str(k):v.as_document() for k,v in ledgers.items()}})}

def finding_dto(p):
    e=p['historical_evidence']
    return {'id':p['key'],'name':p['name'],'description':p.get('description',''),'status':p['finding_status'],
        'n':e['completed_observation_count'],'positions':e.get('independent_position_count',e.get('completed_observation_count',0)),'tokens':e.get('independent_token_count',0),
        'winRate':decimal(e.get('win_rate_percent')),'averageReturn':decimal(e.get('realized_expectancy_pct')),
        'medianReturn':decimal(e.get('median_realized_return_pct')),'pnl':decimal(e.get('realized_pnl_usd')),
        'health':p.get('scores',{}).get('recent_health','insufficient_evidence'),'failedChecks':p['failed_checks'],'evidence':serial(p)}

def story_dto(s,episodes):
    return {'id':s['story_id'],'episodeId':s['position_id'],'tokenAddress':s['token_address'],'symbol':s.get('token_symbol') or 'Unknown token','chain':s['chain'],
        'state':s['position_state'],'narrative':s['plain_english_story'],
        'chapters':[{'id':c['chapter_id'],'at':serial(c['occurred_at']),'action':c['action_type'],
            'description':c['action_type'].replace('_',' ').capitalize(),
            'outcome':c['actual_progress']['plain_english'],
            'pattern':(c.get('primary_pattern_context') or {}).get('pattern_name'),
            'status':(c.get('primary_pattern_context') or {}).get('finding_status','observed_behavior'),
            'priorEvidence':serial(c.get('primary_pattern_context')),'correction':None} for c in s['chapters']]}
