import Link from 'next/link';
export default async function Page({searchParams}:{searchParams:Promise<{scanId?:string}>}){
 const {scanId}=await searchParams;const valid=scanId&&/^[a-f0-9]{64}$/.test(scanId)?scanId:null;
 const back=valid?`/edge/result/${valid}`:'/edge';
 return <><div className="terminal-banner" role="status"><b>UI preview only.</b> We’re building the product. All Terminal data is illustrative; no agent jobs or trades run here. <Link href={back}>Back to My Edge →</Link></div><iframe title="Yieldr Terminal · illustrative UI preview" src={`/edge/terminal-preview/X4-Terminal.dc.html${valid?'?scanId='+valid:''}`} sandbox="allow-scripts allow-top-navigation-by-user-activation" className="terminal-reference"/></>}
