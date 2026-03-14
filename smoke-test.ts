import { classifyToolResult, validateBalanceForTrade, detectPostResponseHallucination } from './lib/toolResultInterpreter';

const c = (label: string, result: any) =>
  console.log(label, '->', result.status, result.txHash || result.errorDetail?.slice(0, 60) || '');

c('1. open_trade success', classifyToolResult('open_trade', JSON.stringify({ success: true, tx_hash: '0x624c' + 'a'.repeat(60) })));
c('2. insufficient USDC', classifyToolResult('open_trade', JSON.stringify({ success: false, error: 'Insufficient USDC: needs 50' })));
c('3. fetch failed',      classifyToolResult('withdraw_funds', 'fetch failed: ECONNREFUSED'));
c('4. suspicious',        classifyToolResult('open_trade', JSON.stringify({ success: true })));
c('5. revert',            classifyToolResult('close_trade', JSON.stringify({ success: false, error: 'execution reverted' })));

const g = validateBalanceForTrade(null, 10);
console.log('6. gate null balance ->', g.allowed, g.classifiedResult.status);

const classified = [{ toolName: 'open_trade', status: 'INSUFFICIENT_FUNDS' as const, classifiedMessage: '...', errorDetail: 'not enough' }];
const override = detectPostResponseHallucination(classified, 'Trade executed successfully!');
console.log('7. hallucination detected ->', !!override);
