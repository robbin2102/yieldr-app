import { BASE_CONTRACTS } from '@/lib/contracts';

export interface Transaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: number;
  timestamp: number;
  input: string;
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
 * FAST: Fetch transactions using QuickNode's qn_getTransactionsByAddress
 * This is a PREMIUM QuickNode feature - much faster than scanning blocks!
 */
export async function fetchTransactionsQuickNode(
  walletAddress: string
): Promise<TransactionFetchResult> {
  console.log('⚡ QuickNode FAST FETCH for:', walletAddress);
  
  const quickNodeUrl = process.env.QUICKNODE_BASE_RPC_URL;
  
  if (!quickNodeUrl) {
    throw new Error('QUICKNODE_BASE_RPC_URL not configured in .env.local');
  }

  try {
    // Step 1: Fetch ALL transactions using QuickNode's enhanced API
    console.log('📥 Fetching transactions via QuickNode enhanced API...');
    const allTransactions = await fetchFromQuickNodeAPI(
      quickNodeUrl,
      walletAddress
    );
    console.log(`   ✓ Found ${allTransactions.length} total transactions`);

    // Step 2: Segment by platform
    console.log('🔀 Segmenting by platform...');
    const segmented = segmentByPlatform(allTransactions);
    
    const summary = {
      uniswap: segmented.uniswap.length,
      aerodrome: segmented.aerodrome.length,
      zora: segmented.zora.length,
      other: segmented.other.length,
    };

    console.log('📊 Segmentation:', summary);

    return {
      walletAddress: walletAddress.toLowerCase(),
      totalTransactions: allTransactions.length,
      transactions: allTransactions,
      fetchedAt: new Date(),
      segmented,
      summary,
    };
  } catch (error) {
    console.error('❌ Error in QuickNode fetch:', error);
    throw error;
  }
}

/**
 * Fetch using QuickNode's qn_getTransactionsByAddress
 * Docs: https://www.quicknode.com/docs/ethereum/qn_getTransactionsByAddress
 */
async function fetchFromQuickNodeAPI(
  quickNodeUrl: string,
  address: string
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];
  
  // QuickNode API call
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'qn_getTransactionsByAddress',
    params: [
      {
        address: address,
        page: 1,
        perPage: 100, // Max 100 per page
      },
    ],
  };

  try {
    let page = 1;
    let hasMore = true;

    // Paginate through results
    while (hasMore && page <= 10) { // Limit to 10 pages (1000 txs) for now
      console.log(`   📄 Fetching page ${page}...`);

      const response = await fetch(quickNodeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          params: [{ address, page, perPage: 100 }],
        }),
      });

      const data = await response.json();

      if (data.error) {
        console.error('QuickNode API Error:', data.error);
        break;
      }

      const result = data.result;
      
      if (!result || !result.transactions || result.transactions.length === 0) {
        hasMore = false;
        break;
      }

      // Convert QuickNode format to our format
      for (const tx of result.transactions) {
        transactions.push({
          hash: tx.hash,
          from: tx.from,
          to: tx.to || null,
          value: tx.value || '0',
          blockNumber: parseInt(tx.blockNumber, 16),
          timestamp: tx.timestamp ? parseInt(tx.timestamp, 16) : 0,
          input: tx.input || '0x',
        });
      }

      // Check if there are more pages
      if (result.transactions.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return transactions;
  } catch (error) {
    console.error('Error fetching from QuickNode:', error);
    throw error;
  }
}

/**
 * Segment transactions by DeFi platform
 */
function segmentByPlatform(txs: Transaction[]) {
  const segmented = {
    uniswap: [] as Transaction[],
    aerodrome: [] as Transaction[],
    zora: [] as Transaction[],
    other: [] as Transaction[],
  };

  for (const tx of txs) {
    const to = tx.to?.toLowerCase();

    if (!to) {
      segmented.other.push(tx);
      continue;
    }

    // Uniswap (includes Zora since they use same router)
    if (
      to === BASE_CONTRACTS.UNISWAP_UNIVERSAL_ROUTER.toLowerCase() ||
      to === BASE_CONTRACTS.UNISWAP_V3_SWAP_ROUTER.toLowerCase() ||
      to === BASE_CONTRACTS.UNISWAP_V3_POSITION_MANAGER.toLowerCase() ||
      to === BASE_CONTRACTS.UNISWAP_V3_FACTORY.toLowerCase()
    ) {
      segmented.uniswap.push(tx);
    }
    // Aerodrome
    else if (
      to === BASE_CONTRACTS.AERODROME_ROUTER.toLowerCase() ||
      to === BASE_CONTRACTS.AERODROME_FACTORY.toLowerCase() ||
      to === BASE_CONTRACTS.AERODROME_VOTER.toLowerCase()
    ) {
      segmented.aerodrome.push(tx);
    }
    // Other
    else {
      segmented.other.push(tx);
    }
  }

  return segmented;
}
