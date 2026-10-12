"use client";
import type {Finding} from '@/types/edge';
import {money,pct} from './shared';
import {findingName,findingCopy} from './findingCopy';
export default function Findings({items,compact=false}:{items:Finding[];compact?:boolean}){return <div className="findings">{items.length?items.map(f=><article key={f.id} className={`edge-card finding ${f.status==='validated_positive_edge'?'validated':f.status.includes('risk')?'risk':''}`}>
 <div className="section-heading"><h3>{findingName(f)}</h3><span className="edge-chip">{f.status.startsWith('validated')?'Validated':'Observed'}</span></div>
 <p className="edge-muted">{findingCopy(f)}</p><div className="finding-metrics"><b>N={f.n??0}</b><span>{f.id==='observed_activity'?'observations':`${f.positions??0} positions`}</span>{f.winRate!==null && <span>{pct(f.winRate)} wins</span>}{f.pnl!==null && <span className={`mono ${Number(f.pnl)>=0?'positive':'negative'}`}>{money(f.pnl)}</span>}</div>
 {!compact&&<details><summary>What this means</summary><p className="small edge-muted">{f.status.startsWith('validated')?'This pattern passed the analysis checks.':'An observation from your history, not yet a proven edge.'} {f.tokens??0} coins contributed. Pattern results may overlap.</p></details>}
 </article>):<p className="empty-state">No repeatable setup confirmed yet.</p>}</div>}
