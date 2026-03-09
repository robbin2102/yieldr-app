/**
 * Quick local test for get_coin_price tool.
 * Run: TAAPI_API_KEY=your_key npx tsx src/tools/market/test-get-coin-price.ts
 */
import { executeGetCoinPrice } from './get-coin-price.js';

async function main() {
  if (!process.env.TAAPI_API_KEY) {
    console.error('Set TAAPI_API_KEY env var first');
    process.exit(1);
  }

  console.log('\n── Single coin (1m) ──');
  const single = await executeGetCoinPrice({ symbols: 'BTC', timeframe: '1m' });
  console.log(JSON.stringify(single, null, 2));

  console.log('\n── Multi-coin (5m) ──');
  const multi = await executeGetCoinPrice({ symbols: ['ETH', 'SOL', 'BNB'], timeframe: '5m' });
  console.log(JSON.stringify(multi, null, 2));

  console.log('\n── Edge: unknown coin ──');
  const bad = await executeGetCoinPrice({ symbols: 'FAKECOIN999', timeframe: '1m' });
  console.log(JSON.stringify(bad, null, 2));
}

main().catch(console.error);
