/**
 * Test Script for Monitoring Service
 *
 * Run this locally to test the monitoring service without waiting for cron.
 *
 * Usage:
 *   npm run test:monitor                    - Run full monitoring cycle
 *   npm run test:monitor -- username        - Monitor specific user
 */

import { runMonitoringCycle, runMonitoringForManager } from '../services/monitoring/orchestrator';

async function main() {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║  Yieldr Monitoring Service - Test Script          ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('\n');

  // Get username from command line args
  const args = process.argv.slice(2);
  const username = args[0];

  try {
    if (username) {
      // Test specific manager
      console.log(`🎯 Testing monitoring for manager: @${username}\n`);

      const result = await runMonitoringForManager(username);

      if (!result.success) {
        console.error(`\n❌ Error: ${result.error}`);
        process.exit(1);
      }

      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  Test Results                                      ║');
      console.log('╚════════════════════════════════════════════════════╝');
      console.log(`  ✓ Positions found: ${result.positions}`);
      console.log(`  ✓ Closed positions logged: ${result.closedPositions}`);
      console.log(`  ✓ Analytics updated: ${result.analyticsUpdated ? 'Yes' : 'No'}`);
      console.log(`  ✓ Duration: ${(result.duration / 1000).toFixed(2)}s`);
      console.log('\n');
    } else {
      // Test full monitoring cycle
      console.log('🔄 Running full monitoring cycle...\n');

      const result = await runMonitoringCycle();

      if (!result.success) {
        console.error('\n❌ Monitoring cycle failed');
        if (result.errors.length > 0) {
          console.error('Errors:');
          result.errors.forEach((err) => console.error(`  - ${err}`));
        }
        process.exit(1);
      }

      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  Monitoring Cycle Complete                         ║');
      console.log('╚════════════════════════════════════════════════════╝');
      console.log(`  ✓ Managers processed: ${result.managersProcessed}`);
      console.log(`  ✓ Total positions: ${result.totalPositions}`);
      console.log(`  ✓ Closed positions logged: ${result.closedPositions}`);
      console.log(`  ✓ Analytics updated: ${result.analyticsUpdated} managers`);
      console.log(`  ✓ Duration: ${(result.duration / 1000).toFixed(2)}s`);
      console.log(`  ✓ Errors: ${result.errors.length}`);
      console.log('\n');

      if (result.errors.length > 0) {
        console.log('⚠️  Errors occurred:');
        result.errors.forEach((err) => console.log(`  - ${err}`));
        console.log('\n');
      }
    }

    console.log('✅ Test completed successfully!\n');
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
