import { BASE_CONTRACTS } from '@/lib/contracts';

export interface Transaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: number;
  timestamp: number;
  input: string;
  gasUsed: string;
}

export interface TransactionFetchResult {
  walletAddress: string;
  totalTransactions: number;
  transactions: Transaction[];
  fetchedAt: Date;
  segmented: {
    uniswap: Transaction[];
    aerodrome: Transaction[];
    zora: Transaction[];
    other: Transaction[];
  };
  summary: {
    uniswap: number;
    aerodrome: number;
    zora: number;
    other: number;
  };
}

/**
 * ACCURATE: Use Basescan API - returns actual transactions, not token transfers
 */
export async function fetchTransactionsBasescan(
  walletAddress: string
): Promise<TransactionFetchResult> {
  console.log('⚡ Fetching via Basescan API for:', walletAddress);
  
  const apiKey = process.env.BASESCAN_API_KEY;
  
  if (!apiKey) {
    throw new Error('BASESCAN_API_KEY not configured. Get one free at https://basescan.org/myapikey');
  }

  try {
    // Fetch normal transactions (what we need!)
    console.log('📥 Fetching transactions initiated by wallet...');
    const transactions = await fetchBasescanTransactions(
      walletAddress,
      apiKey
    );
    console.log(`   ✓ Found ${transactions.length} transactions`);

    // Segment by platform
    console.log('🔀 Segmenting by platform...');
    const segmented = segmentByPlatform(transactions);
    const summary = {
      uniswap: segmented.uniswap.length,
      aerodrome: segmented.aerodrome.length,
      zora: segmented.zora.length,
      other: segmented.other.length,
    };

    console.log('📊 Segmentation:', summary);

    return {
      walletAddress: walletAddress.toLowerCase(),
      totalTransactions: transactions.length,
      transactions,
      fetchedAt: new Date(),
      segmented,
      summary,
    };
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

/**
 * Fetch from Basescan API
 */
async function fetchBasescanTransactions(
  address: string,
  apiKey: string
): Promise<Transaction[]> {
  const baseUrl = 'https://api.basescan.org/api';
  
  // Build URL - only fetch normal transactions
  const params = new URLSearchParams({
    module: 'account',
    action: 'txlist', // Normal transactions only
    address: address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '10000', // Max 10000 per request
    sort: 'desc', // Most recent first
    apikey: apiKey,
  });

  const url = `${baseUrl}?${params}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== '1') {
      if (data.message === 'No transactions found') {
        return [];
      }
      throw new Error(data.message || 'Basescan API error');
    }

    // Convert Basescan format to our format
    return data.result.map((tx: any) => ({
      hash: tx.hash,
      from: tx.from,
      to: tx.to || null,
      value: tx.value,
      blockNumber: parseInt(tx.blockNumber),
      timestamp: parseInt(tx.timeStamp),
      input: tx.input || '0x',
      gasUsed: tx.gasUsed || '0',
    }));
  } catch (error) {
    console.error('Basescan API error:', error);
    throw error;
  }
}

/**
 * Segment by platform - FIXED with all Aerodrome contracts
 */
function segmentByPlatform(txs: Transaction[]) {
  const segmented = {
    uniswap: [] as Transaction[],
    aerodrome: [] as Transaction[],
    zora: [] as Transaction[],
    other: [] as Transaction[],
  };

  // Aerodrome contract addresses
  const AERODROME_CONTRACTS = [
    BASE_CONTRACTS.AERODROME_ROUTER.toLowerCase(),
    BASE_CONTRACTS.AERODROME_FACTORY.toLowerCase(),
    BASE_CONTRACTS.AERODROME_VOTER.toLowerCase(),
    '0x827922686190790b37229fd06084350e74485b72', // SlipStream Position Manager
    '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a', // Aerodrome Pool Factory (v1)
    '0x420dd381b31aef6683db6b902084cb0ffece40da', // Aerodrome Pool Factory (v2)
  ];

  // Uniswap contract addresses
  const UNISWAP_CONTRACTS = [
    BASE_CONTRACTS.UNISWAP_UNIVERSAL_ROUTER.toLowerCase(),
    BASE_CONTRACTS.UNISWAP_V3_SWAP_ROUTER.toLowerCase(),
    BASE_CONTRACTS.UNISWAP_V3_POSITION_MANAGER.toLowerCase(),
    BASE_CONTRACTS.UNISWAP_V3_FACTORY.toLowerCase(),
  ];

  for (const tx of txs) {
    const to = tx.to?.toLowerCase();
    if (!to) {
      segmented.other.push(tx);
      continue;
    }

    // Check Aerodrome
    if (AERODROME_CONTRACTS.includes(to)) {
      segmented.aerodrome.push(tx);
      console.log(`   ✓ Aerodrome tx: ${tx.hash.slice(0, 10)}... to ${to.slice(0, 10)}...`);
    }
    // Check Uniswap
    else if (UNISWAP_CONTRACTS.includes(to)) {
      segmented.uniswap.push(tx);
    }
    // Check Zora (uses Uniswap router)
    else if (to === BASE_CONTRACTS.ZORA_UNIVERSAL_ROUTER?.toLowerCase()) {
      segmented.zora.push(tx);
    }
    // Other
    else {
      segmented.other.push(tx);
    }
  }

  return segmented;
}
