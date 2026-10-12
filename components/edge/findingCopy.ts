import type {Finding} from '@/types/edge';
const names:Record<string,string>={moonshot_dependent_trader:'Don’t rely on one big winner',round_tripper:'Protect gains before they disappear',moonshot_dependency:'Don’t rely on one big winner',moonshot_dependent:'Don’t rely on one big winner',observed_activity:'Your trading so far',revenge_sizer:'Avoid sizing up after losses',overtrader:'Give each trade room',fast_loss_cutter:'Cut losses early',lets_winners_run:'Give winners room',chasing_reentry:'Avoid chasing your last exit',dip_buyer:'Buy the pullback'};
export const findingName=(f:Finding)=>names[f.id]||f.name;
export const usefulFindings=(items:Finding[])=>items.filter(f=>['validated_positive_edge','validated_risk_pattern','observed_behavior','observed_risk'].includes(f.status) && (f.n||0)>0);
export function findingCopy(f:Finding){
 if(f.id==='observed_activity')return `${f.positions??0} closed positions across ${f.tokens??0} coins. More history is needed to spot a repeatable edge.`;
 if(f.id.includes('round_trip'))return 'Some winning positions gave back their gains before you exited. Consider planning your exit earlier.';
 if(f.id.includes('moonshot')){
   const evidence=(f.evidence as any)?.historical_evidence;
   const best=evidence?.best_trade_profit_share,top=evidence?.top_3_profit_share;
   return typeof best==='number'&&typeof top==='number'?`Your best winner made ${(best*100).toFixed(1)}% of gross profits; your top three made ${(top*100).toFixed(1)}%. Check how your other trades perform.`:'A few big winners carry much of your profit. Check how your other trades perform.';
 }
 return f.description.split(/(?<=[.!?])\s/)[0]||'A pattern observed in your trading history.';
}
