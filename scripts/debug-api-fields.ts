import 'dotenv/config';

const wallet = '0xd0b4c4c020abdc88ad9a884f999f3d8cff8ffed6';
const API_BASE = 'https://data-api.polymarket.com';

async function main() {
  // Fetch closed positions
  const closedUrl = `${API_BASE}/positions?user=${wallet}&limit=5&offset=0&sortBy=LATEST_TRADE_TIMESTAMP&sortDirection=DESC&sizeThreshold=0&redeemed=true`;
  
  console.log('Fetching closed positions...\n');
  console.log('URL:', closedUrl, '\n');
  
  const closedRes = await fetch(closedUrl);
  const closedData = await closedRes.json();
  
  if (Array.isArray(closedData) && closedData.length > 0) {
    console.log('First closed position - ALL FIELDS:\n');
    console.log(JSON.stringify(closedData[0], null, 2));
    
    console.log('\n\nAll field names:');
    console.log(Object.keys(closedData[0]).join(', '));
    
    // Check timestamp fields specifically
    console.log('\n\nTimestamp-related values:');
    const first = closedData[0];
    console.log('  timestamp:', first.timestamp);
    console.log('  latestTradeTimestamp:', first.latestTradeTimestamp);
    console.log('  createdAt:', first.createdAt);
    console.log('  updatedAt:', first.updatedAt);
  } else {
    console.log('No closed positions returned or invalid response:', closedData);
  }
}

main().catch(console.error);
