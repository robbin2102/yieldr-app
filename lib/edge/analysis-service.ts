import 'server-only';
import { EdgeError } from './config';
export async function dispatchAnalysis(scanId:string) {
  const base=process.env.EDGE_ANALYSIS_SERVICE_URL,secret=process.env.YIELDR_INTERNAL_SECRET;
  if(!base||!secret) throw new EdgeError('configuration_unavailable');
  let url:URL;
  try {url=new URL('/internal/scans',base);}catch {throw new EdgeError('configuration_unavailable');}
  const local=['127.0.0.1','localhost'].includes(url.hostname) && process.env.EDGE_ALLOW_LOCAL_SERVICE==='true';
  if(url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&local))) throw new EdgeError('configuration_unavailable');
  const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},
    body:JSON.stringify({scan_id:scanId}),signal:AbortSignal.timeout(5000),cache:'no-store',redirect:'error'});
  if(!r.ok) throw new EdgeError('analysis_service_unavailable');
}
