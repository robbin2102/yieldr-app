"use client";
import { useEffect, useState } from 'react';
import type { Scan, EdgeResult, Holdings, Position } from '@/types/edge';
import { fetchJson } from './shared';
export function useScan(scanId:string) {
  const [scan,setScan]=useState<Scan|null>(null),[result,setResult]=useState<EdgeResult|null>(null);
  const [positions,setPositions]=useState<Position[]|null>(null),[holdings,setHoldings]=useState<Holdings|null>(null);
  const [error,setError]=useState(''),[positionError,setPositionError]=useState(''),[holdingsError,setHoldingsError]=useState('');
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
    setError('');setPositionError('');setHoldingsError('');setScan(null);setResult(null);setPositions(null);setHoldings(null);
    const base=`/api/edge/scans/${scanId}`;
    const get=<T,>(url:string)=>fetchJson<T>(url,{signal:controller.signal});
    async function poll(){
      try{
        const s=await get<Scan>(base);if(!alive)return;setScan(s);
        if(s.status==='queued'||s.status==='running') {if(s.preview?.positions)setPositions(s.preview.positions);if(s.preview?.holdings)setHoldings(s.preview.holdings);timer=setTimeout(poll,1500);return;}
        if(s.status!=='completed')return;
        await Promise.all([
          get<EdgeResult>(base+'/result').then(r=>{if(alive)setResult(r)}).catch(e=>{if(alive)setError(e.message)}),
          get<Position[]>(base+'/positions').then(p=>{if(alive)setPositions(p)}).catch(e=>{if(alive)setPositionError(e.message)}),
          get<Holdings>(base+'/holdings').then(h=>{if(alive)setHoldings(h)}).catch(e=>{if(alive)setHoldingsError(e.message)}),
        ]);
        if(alive)timer=setTimeout(poll,30000);
      }catch(e){if(alive)setError(e instanceof Error?e.message:'Unable to load scan.')}
    }
    void poll();return()=>{alive=false;clearTimeout(timer);controller.abort();};
  },[scanId,attempt]);
  return {scan,result,positions,holdings,error,positionError,holdingsError,retry:()=>setAttempt(x=>x+1)};
}
