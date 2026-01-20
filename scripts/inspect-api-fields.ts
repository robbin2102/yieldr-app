/**
 * Inspect ALL fields returned by closed positions API
 * to see if there's a unique ID we can use
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';
const API_BASE = 'https://data-api.polymarket.com';

async function main() {
  console.log('\n🔍 INSPECTING API FIELDS FOR CLOSED POSITIONS\n');
  console.log('='.repeat(80) + '\n');

  // Fetch last 5 positions
  const url = `${API_BASE}/closed-positions?user=${TEST_WALLET}&limit=5&sortBy=TIMESTAMP&sortDirection=DESC`;

  console.log(`Fetching: ${url}\n`);
  console.log('='.repeat(80) + '\n');

  const response = await fetch(url);
  const positions = await response.json();

  if (positions.length === 0) {
    console.log('No positions returned\n');
    process.exit(0);
  }

  console.log(`✅ Fetched ${positions.length} positions\n`);
  console.log('='.repeat(80));
  console.log('ALL FIELDS IN FIRST POSITION:');
  console.log('='.repeat(80) + '\n');

  const firstPos = positions[0];
  const allKeys = Object.keys(firstPos);

  console.log(`Total fields: ${allKeys.length}\n`);

  allKeys.forEach(key => {
    const value = firstPos[key];
    const type = typeof value;
    console.log(`${key.padEnd(20)} (${type.padEnd(8)}): ${JSON.stringify(value)}`);
  });

  console.log('\n' + '='.repeat(80));
  console.log('CHECKING FOR UNIQUE IDENTIFIERS:');
  console.log('='.repeat(80) + '\n');

  // Check if there are any fields that could be unique IDs
  const possibleIdFields = allKeys.filter(key =>
    key.toLowerCase().includes('id') ||
    key.toLowerCase().includes('hash') ||
    key.toLowerCase().includes('transaction')
  );

  if (possibleIdFields.length > 0) {
    console.log('✅ Found potential unique ID fields:\n');
    possibleIdFields.forEach(field => {
      console.log(`  - ${field}: ${firstPos[field]}`);
    });
  } else {
    console.log('❌ No obvious unique ID fields found\n');
    console.log('Available fields for creating composite key:');
    console.log('  - conditionId (market)');
    console.log('  - asset (Up/Down)');
    console.log('  - timestamp (when closed)');
    console.log('  - proxyWallet (if available)');
  }

  console.log('\n' + '='.repeat(80));
  console.log('CHECKING FOR DUPLICATES IN SAMPLE:');
  console.log('='.repeat(80) + '\n');

  // Check if any of the 5 positions have duplicate keys
  const keys = positions.map((p: any) => `${p.conditionId}_${p.asset}_${p.timestamp}`);
  const uniqueKeys = new Set(keys);

  console.log(`Total positions: ${positions.length}`);
  console.log(`Unique keys (conditionId+asset+timestamp): ${uniqueKeys.size}`);

  if (keys.length > uniqueKeys.size) {
    console.log('\n❌ DUPLICATES FOUND in this sample!');
    console.log('This means even in the last 5 positions, there are partial closes.\n');
  } else {
    console.log('\n✅ No duplicates in this sample');
  }

  console.log('\n' + '='.repeat(80));
  console.log('CURL COMMAND TO TEST:');
  console.log('='.repeat(80) + '\n');
  console.log(`curl "${url}" | jq '.'`);
  console.log('\n' + '='.repeat(80) + '\n');

  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
