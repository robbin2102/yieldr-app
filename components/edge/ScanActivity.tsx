"use client";
import {useEffect,useState} from 'react';
/** Reveal only records already received. Never estimate unreturned work. */
export function useRevealedCount(target:number,enabled=true){
 const [shown,setShown]=useState(0);
 useEffect(()=>{
  if(!enabled){setShown(target);return;}
  if(shown>target){setShown(target);return;}
  if(shown===target)return;
  const timer=setTimeout(()=>setShown(n=>Math.min(target,n+Math.max(1,Math.ceil((target-n)/8)))),100);
  return()=>clearTimeout(timer);
 },[target,shown,enabled]);
 return Math.min(shown,target);
}
export default function ScanActivity({items,window}:{items:{id:string;at:string}[];window?:{start:string;end:string}}){
 const shown=useRevealedCount(items.length);
 const start=Date.parse(window?.start||items.at(-1)?.at||''),end=Date.parse(window?.end||items[0]?.at||'');
 return <section className="edge-card position-chart"><div className="section-heading"><h2 className="edge-label">Your last 90 days</h2><span className="small edge-muted">Each dot = fetched activity · matching trades next</span></div>
 <svg viewBox="0 0 800 150" role="img" aria-label={`${shown} fetched transactions; outcomes not yet verified`}><line x1="0" x2="800" y1="75" y2="75" stroke="#303648"/>{items.slice(0,shown).map((p,i)=><circle className="position-dot" key={p.id} cx={20+Math.max(0,Math.min(1,(Date.parse(p.at)-start)/Math.max(1,end-start)))*760} cy={65+(i%3)*10} r="4" fill="transparent" stroke="#8791AB"/>)}</svg>
 <p className="small edge-muted">{shown?`${shown} transactions fetched. Dots gain win/loss colors after buys and sells are verified.`:'Reading wallet activity. Your first batch will appear here.'}</p></section>;
}
