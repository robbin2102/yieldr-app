"use client";
import Link from 'next/link';
import {useScan} from './useScan';
import {Header,human} from './shared';
import PositionsChart from './PositionsChart';
import CoinHoldings,{shortAddress} from './CoinHoldings';
import Findings from './Findings';
import {usefulFindings} from './findingCopy';
import {Orb} from './AgentDock';
import ScanActivity,{useRevealedCount} from './ScanActivity';
export default function ScanView({scanId}:{scanId:string}){
 const {scan,result,positions,holdings,error,retry}=useScan(scanId);
 const complete=scan?.status==='completed',blocked=['failed','blocked'].includes(scan?.status||'');
 const stage=scan?.activeStage||'', settled=scan?.stages.length||0,total=scan?.totalStages||20;
 const live=scan?.preview?.liveProgress;
 const count=complete?(result?.economicActions??scan?.counts?.economic_actions??0):(live?.current??0);
 const displayedCount=useRevealedCount(count,!complete);
 const shownPositions=useRevealedCount(positions?.length||0,!complete);
 const findings=usefulFindings(result?.findings||scan?.preview?.findings||[]).slice(0,4);
 const phase=complete?'complete':settled<4?'fetch':settled<7?'pricing':settled<10?'grouping':settled<13?'market':'testing';
 const title=blocked?'Analysis could not finish':({fetch:'Pulling your Fomo trades',pricing:'Pricing every entry and exit',grouping:'Grouping how you trade',market:'Pricing every entry and exit',testing:'Testing against luck',complete:'Here is your Edge Print'}[phase]);
 const fraction=phase===live?.phase&&live?.total?Math.min(1,live.current/live.total):0;
 const progress=complete?100:phase==='market'?50+35*fraction:phase==='testing'?85+Math.max(0,settled-13)*2:Math.min(50,(settled+fraction)/total*100);
 return <><Header label={complete?'Analysis ready':blocked?'Scan paused':'Agent scanning'}/>
 <div className="scan-wallet-strip"><span>{scan?scan.walletType==='solana'?'Solana wallet analysis':'EVM wallet analysis':'Loading wallet…'}</span><code title={scan?.wallet}>{shortAddress(scan?.wallet||'')}</code><span>Analysis window · 90 days</span>{complete&&scan?.analysisTimestamp&&<span>Last scan · {new Date(scan.analysisTimestamp).toLocaleString()}</span>}</div>
 <main className="scan-grid"><aside className="scan-aside"><CoinHoldings holdings={holdings}/></aside>
 <section className="scan-main"><div className="scan-heading"><Orb/><div><p className="edge-label positive">Your agent</p><h1 className="section-title">{title}</h1></div><span className="mono scan-count">{displayedCount}{!complete&&live?.total!=null&&<span className="edge-muted"> / {live.total}</span>}<span className="edge-muted"> {complete?'actions analyzed':live?.unit||'transactions fetched'}</span></span></div>
 <div className={`scan-progress ${!complete&&!blocked?'is-scanning':''}`} role="progressbar" aria-label="Analysis progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${progress}%`}}/></div>
 <p className="scan-narration edge-muted" role="status">{error||scan?.message||(live?.accessBlocked?'Historical price access was denied. Finishing with cached history; price-dependent patterns may be unavailable.':complete?'Done. See what helped, what hurt, and what needs more history.':settled<4?'Finding your trades and reading your coins.':settled<10?'Matching buys and sells. Only verified outcomes appear in your chart.':settled<14?'Your positions are ready. Checking market prices and the context of each trade.':'Checking whether these patterns hold up across your trading history.')}</p>
 {error&&<button className="edge-button" onClick={retry}>Retry</button>}
 {blocked&&<Link className="edge-button" href="/edge">Try another scan →</Link>}
 {positions&&(positions.length>0||complete)?<PositionsChart compact positions={positions.slice(0,shownPositions)} window={scan?.windowStart&&scan?.windowEnd?{start:scan.windowStart,end:scan.windowEnd}:undefined}/>:<ScanActivity items={scan?.preview?.activity||[]} window={scan?.windowStart&&scan?.windowEnd?{start:scan.windowStart,end:scan.windowEnd}:undefined}/>}

 <div className="section-heading"><h2 className="edge-label">What I’m finding</h2><span className="small edge-muted">Observations stay labeled until proven</span></div><div className="scan-findings">{!complete&&!findings.length?<p className="small edge-muted">Your patterns will appear after the checks finish.</p>:<Findings compact items={findings}/>}</div>
 {complete&&<Link className="edge-button primary scan-result-link" href={`/edge/result/${scanId}`}>See your Edge Print →</Link>}
 <p className="small edge-muted">{complete?'Analysis complete':blocked?'Scan stopped':`${settled} of ${total} checks complete`}</p>
 </section></main></>;
}
