"use client";
import {useEffect,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
export function Orb(){return <div className="agent-orb" role="img" aria-label="Your agent"/>;}
export default function AgentDock({actions=0,scanId}:{actions?:number;scanId:string}) {
 const router=useRouter(),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [message,setMessage]=useState(''),[pending,setPending]=useState(false);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current)},[]);
 function preview(){if(pending)return;setPending(true);timer.current=setTimeout(()=>router.push(`/edge/terminal?scanId=${encodeURIComponent(scanId)}`),1600);}
 return <section className="agent-dock"><div className="orb-column"><Orb/><span className="edge-label positive">Preview</span></div><div className="agent-content">
 <div className="section-heading"><b>Your agent</b><span className="small edge-muted">Your {actions} actions, explained simply</span></div>
 <p className="agent-bubble">Your Edge Print is ready. Explore what helped, what hurt, and which habits need more history.</p>
 <div className="agent-presets">{['Watch my coins','Hunt my next setup'].map(x=><button className="agent-preset" key={x} onClick={preview} disabled={pending}><b>{x}</b><span className="small edge-muted">Preview this agent job →</span></button>)}</div>
 <form className="agent-input" onSubmit={e=>{e.preventDefault();if(message.trim())preview()}}><input aria-label="Message your agent" value={message} onChange={e=>setMessage(e.target.value)} placeholder="Describe a job, or ask me anything…"/><button type="submit" aria-label="Send message" disabled={pending||!message.trim()}>↑</button></form>
 {pending && <p className="positive" role="status">This feature is under development. Opening the Terminal preview…</p>}
 </div></section>;
}
