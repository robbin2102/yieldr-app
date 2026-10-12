"use client";
import {useState} from 'react';
import type {Holding,Holdings} from '@/types/edge';
import {holdingQuantity,holdingReturn} from '@/lib/edge/holding-display';
import {money} from './shared';
export const shortAddress=(value:string)=>value.length>16?`${value.slice(0,4)}…${value.slice(-4)}`:value;
export function tokenLabel(symbol:string|null|undefined,address:string){return symbol && symbol!==address && symbol.length<30 ? symbol : `Token ${shortAddress(address)}`;}
function CoinRow({coin:h}:{coin:Holding}) {
  const [copyState,setCopyState]=useState('Copy');
  const label=tokenLabel(h.symbol,h.tokenAddress);
  const pnl=holdingReturn(h.value,h.costBasis);
  const tone=pnl ? pnl.dollars<0?'negative':'positive' : 'edge-muted';
  return <article className="holding compact-holding">
    <div className="holding-top"><div className="holding-identity">{h.imageUrl&&<img src={h.imageUrl} width={20} height={20} alt="" loading="lazy" onError={e=>{e.currentTarget.style.display='none'}}/>}<b title={h.name||label}>{label}</b></div><span className="holding-value mono">{h.value!==null&&Number.isFinite(Number(h.value))?money(h.value):'—'}</span></div>
    <div className="holding-middle"><span title={h.quantity||undefined}>{holdingQuantity(h.quantity)} tokens</span><span className={`holding-return mono ${tone}`} title={pnl?'Unrealized return on the remaining position':'Entry cost unavailable'}>{pnl?`${pnl.percent>0?'+':''}${pnl.percent.toFixed(1)}%`:'P&L —'}</span></div>
    <div className="holding-bottom"><button className="coin-address" title={h.tokenAddress} aria-label={`Copy ${label} address`} onClick={async()=>{try{await navigator.clipboard.writeText(h.tokenAddress);setCopyState('Copied')}catch{setCopyState('Try again')}}}><span className="mono">{shortAddress(h.tokenAddress)}</span><span aria-live="polite">{copyState}</span></button><span className={`holding-profit mono ${tone}`}>{pnl?`${pnl.dollars>0?'+':''}${money(String(pnl.dollars))}`:h.chain}</span></div>
  </article>;
}
export default function CoinHoldings({holdings}:{holdings:Holdings|null}) {
  const priced=holdings?.items.filter(h=>h.value!==null&&Number.isFinite(Number(h.value)))||[];
  const total=priced.reduce((sum,h)=>sum+Number(h.value),0);
  const visible=holdings?.items.filter(h=>h.value===null||!Number.isFinite(Number(h.value))||Number(h.value)>=10).sort((a,b)=>Number(b.value||0)-Number(a.value||0))||[];
  const hidden=(holdings?.items.length||0)-visible.length;
  return <><div className="aside-heading holdings-heading"><div><h2 className="edge-label">Your coins</h2><span className="mono" title="Total value of priced holdings">{priced.length?money(String(total)):'—'}</span></div><p>Current value · Unrealized P&L</p></div>{!holdings?<p className="empty-state">Reading your coins…</p>:<>{visible.map(h=><CoinRow key={`${h.chain}:${h.tokenAddress}`} coin={h}/>)}<div className="holdings-footnote">{hidden>0&&<p>* {hidden} holdings under $10 hidden.</p>}<p>P&L shown when entry cost is known.</p></div>{holdings.items.length===0&&<p className="empty-state">{holdings.status==='available'?'No current balances found.':'Balances could not be verified.'}</p>}</>}</>;
}
