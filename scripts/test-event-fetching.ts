/**
 * Quick test script to verify MarketExecuted events can be fetched
 * Checks last 24 hours to see if we can find ANY events
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';

config({ path: resolve(process.cwd(), '.env.local') });

const CONTRACTS = {
  EVENTS: '0x0c16ff40065cc3ab4bc55b60e447504afb9c7970' as `0x${string}`,
};

async function main() {
  console.log('='.repeat(70));
  console.log('Avantis Event Verification Test');
  console.log('='.repeat(70));
  console.log('Testing if we can fetch MarketExecuted events...\n');

  try {
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL;
    if (!rpcUrl) {
      throw new Error('QUICKNODE_BASE_RPC_URL not set');
    }

    const client = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    console.log('🔌 Connected to Base RPC\n');

    // Get current block
    const latestBlock = await client.getBlockNumber();
    console.log(`Latest block: ${latestBlock}`);

    // Test 1: Check last hour (7200 blocks)
    console.log('\n' + '─'.repeat(70));
    console.log('Test 1: Last 1 hour (~7200 blocks)');
    console.log('─'.repeat(70));

    const fromBlock1h = latestBlock - BigInt(7200);
    console.log(`Block range: ${fromBlock1h} to ${latestBlock}`);

    const logs1h = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event MarketExecuted(uint256 indexed orderId, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), bool orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock: fromBlock1h,
      toBlock: latestBlock,
    });

    console.log(`✅ Found ${logs1h.length} MarketExecuted events in last hour`);

    if (logs1h.length > 0) {
      console.log(`   Sample blocks: ${logs1h.slice(0, 5).map(l => l.blockNumber).join(', ')}`);

      // Parse first event to show details
      const { parseMarketExecuted } = await import('../services/avantis-listener/EventParser');
      const first = parseMarketExecuted(logs1h[0]);
      if (first) {
        console.log(`   Sample event:`);
        console.log(`     OrderId: ${first.orderId}`);
        console.log(`     Trader: ${first.trader}`);
        console.log(`     Type: ${first.open ? 'OPEN' : 'CLOSE'}`);
        console.log(`     Block: ${first.executedBlockNumber}`);
      }
    }

    // Test 2: Check specific block range around user's trade
    console.log('\n' + '─'.repeat(70));
    console.log('Test 2: Around your trade (blocks 38595800-38596200)');
    console.log('─'.repeat(70));

    const logs2 = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event MarketExecuted(uint256 indexed orderId, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), bool orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock: BigInt(38595800),
      toBlock: BigInt(38596200),
    });

    console.log(`✅ Found ${logs2.length} MarketExecuted events around your trade`);

    if (logs2.length > 0) {
      const { parseMarketExecuted } = await import('../services/avantis-listener/EventParser');

      // Check if any are for test wallet
      const testWallet = '0x780bb763e1463d2236fec780b7bd6adb40aaa120';
      const userEvents = logs2.filter(log => {
        const parsed = parseMarketExecuted(log);
        return parsed && parsed.trader.toLowerCase() === testWallet;
      });

      console.log(`   Events for test wallet (${testWallet}): ${userEvents.length}`);

      if (userEvents.length > 0) {
        console.log(`   ✓ Found your trade!`);
        for (const log of userEvents) {
          const parsed = parseMarketExecuted(log);
          if (parsed) {
            console.log(`     - OrderId: ${parsed.orderId}, Type: ${parsed.open ? 'OPEN' : 'CLOSE'}, Block: ${parsed.executedBlockNumber}`);
          }
        }
      } else {
        console.log(`   ℹ️  No events for test wallet yet`);
      }
    }

    // Test 3: Check last 2 hours for test wallet specifically
    console.log('\n' + '─'.repeat(70));
    console.log('Test 3: Last 2 hours for test wallet');
    console.log('─'.repeat(70));

    const fromBlock2h = latestBlock - BigInt(14400); // 2 hours
    console.log(`Block range: ${fromBlock2h} to ${latestBlock}`);

    const logs3 = await client.getLogs({
      address: CONTRACTS.EVENTS,
      event: parseAbiItem('event MarketExecuted(uint256 indexed orderId, (address trader, uint256 pairIndex, uint256 index, bool open, uint256 initialPosToken, uint256 positionSizeUsdc, uint256 openPrice, bool buy, uint256 leverage, uint256 tp, uint256 sl, uint256 timestamp), (uint256 open, uint256 high, uint256 low, uint256 close), bool orderType, uint256 price, uint256 priceImpactP, int256 percentProfit, uint256 usdcSentToTrader, uint256 executionTxnFee)'),
      fromBlock: fromBlock2h,
      toBlock: latestBlock,
    });

    console.log(`Total events in 2h: ${logs3.length}`);

    const { parseMarketExecuted } = await import('../services/avantis-listener/EventParser');
    const testWallet = '0x780bb763e1463d2236fec780b7bd6adb40aaa120';
    const userEvents = logs3.filter(log => {
      const parsed = parseMarketExecuted(log);
      return parsed && parsed.trader.toLowerCase() === testWallet;
    });

    console.log(`Events for test wallet: ${userEvents.length}`);

    if (userEvents.length > 0) {
      console.log(`\n✅ Found events for test wallet:`);
      for (const log of userEvents) {
        const parsed = parseMarketExecuted(log);
        if (parsed) {
          console.log(`   - OrderId: ${parsed.orderId}, Type: ${parsed.open ? 'OPEN' : 'CLOSE'}, Block: ${parsed.executedBlockNumber}`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('Verification Complete');
    console.log('='.repeat(70) + '\n');

    process.exit(0);

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
