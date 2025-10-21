import { ethers } from 'ethers';
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
 * FAST + ACCURATE: Use eth_getLogs but filter to only transactions YOU initiated
 */
export async function fetchTransactionsViaLogs(
  walletAddress: string
): Promise<TransactionFetchResult> {
  console.log('⚡ FAST FETCH via eth_getLogs for:', walletAddress);
  
  const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL;
  
  if (!rpcUrl) {
    throw new Error('RPC URL not configured');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const currentBlock = await provider.getBlockNumber();
    console.log('📊 Current block:', currentBlock);

    // Last 30 days
    const BLOCKS_IN_30_DAYS = 43200 * 30;
    const fromBlock = Math.max(0, currentBlock - BLOCKS_IN_30_DAYS);
    
    console.log('📅 Scanning last 30 days:', fromBlock, 'to', currentBlock);

    // Fetch transactions
    const transactions = await fetchTransactionsOnly(
      provider,
      walletAddress,
      fromBlock,
      currentBlock
    );

    console.log(`✅ Found ${transactions.length} transactions initiated by you`);

    // Segment by platform
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
 * Fetch ONLY transactions where user is the initiator
 */
async function fetchTransactionsOnly(
  provider: ethers.JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number
): Promise<Transaction[]> {
  const transactions = new Map<string, Transaction>();
  const addressLower = address.toLowerCase();
  
  // Transfer event - we'll use this to find relevant transactions
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  
  console.log('📥 Fetching logs in parallel chunks...');

  const CHUNK_SIZE = 10000;
  const chunks: Array<{ start: number; end: number }> = [];
  
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    chunks.push({
      start,
      end: Math.min(start + CHUNK_SIZE - 1, toBlock),
    });
  }

  console.log(`   📦 ${chunks.length} chunks of 10k blocks`);

  // Process in batches of 3
  const PARALLEL_LIMIT = 3;
  
  for (let i = 0; i < chunks.length; i += PARALLEL_LIMIT) {
    const batch = chunks.slice(i, i + PARALLEL_LIMIT);
    
    console.log(`   ⚡ Chunks ${i + 1}-${Math.min(i + PARALLEL_LIMIT, chunks.length)}...`);
    
    const results = await Promise.all(
      batch.map(chunk => fetchChunk(provider, addressLower, chunk.start, chunk.end, transferTopic))
    );

    for (const chunkTxs of results) {
      for (const tx of chunkTxs) {
        // CRITICAL: Only include if wallet initiated the transaction
        if (tx.from.toLowerCase() === addressLower) {
          transactions.set(tx.hash, tx);
        }
      }
    }

    console.log(`      ✓ Total initiated by you: ${transactions.size}`);
    
    if (i + PARALLEL_LIMIT < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return Array.from(transactions.values());
}

/**
 * Fetch chunk
 */
async function fetchChunk(
  provider: ethers.JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number,
  transferTopic: string
): Promise<Transaction[]> {
  const transactions = new Map<string, Transaction>();
  
  try {
    // Get logs where address sent tokens
    const logs = await provider.getLogs({
      fromBlock,
      toBlock,
      topics: [
        transferTopic,
        ethers.zeroPadValue(address, 32), // from = our address
      ],
    });

    console.log(`      📄 ${fromBlock}-${toBlock}: ${logs.length} events`);

    // Get unique transaction hashes
    const txHashes = [...new Set(logs.map(log => log.transactionHash))];

    // Fetch transaction details
    for (const txHash of txHashes) {
      try {
        const tx = await provider.getTransaction(txHash);
        if (!tx) continue;

        const block = await provider.getBlock(tx.blockNumber || 0);

        transactions.set(tx.hash, {
          hash: tx.hash,
          from: tx.from,
          to: tx.to || null,
          value: tx.value.toString(),
          blockNumber: tx.blockNumber || 0,
          timestamp: block?.timestamp || 0,
          input: tx.data,
        });
      } catch (error) {
        continue;
      }
    }

    return Array.from(transactions.values());
  } catch (error) {
    console.error(`Error chunk ${fromBlock}-${toBlock}:`, error);
    return [];
  }
}

/**
 * Segment by platform - WITH ALL AERODROME CONTRACTS
 */
function segmentByPlatform(txs: Transaction[]) {
  const segmented = {
    uniswap: [] as Transaction[],
    aerodrome: [] as Transaction[],
    zora: [] as Transaction[],
    other: [] as Transaction[],
  };

  // ALL Aerodrome contracts
  const AERODROME_CONTRACTS = [
    BASE_CONTRACTS.AERODROME_ROUTER.toLowerCase(),
    BASE_CONTRACTS.AERODROME_FACTORY.toLowerCase(),
    BASE_CONTRACTS.AERODROME_VOTER.toLowerCase(),
    '0x827922686190790b37229fd06084350e74485b72', // SlipStream Position Manager ← YOUR TX
    '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a', // Pool Factory v1
  ];

  // Uniswap contracts
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

    if (AERODROME_CONTRACTS.includes(to)) {
      segmented.aerodrome.push(tx);
    } else if (UNISWAP_CONTRACTS.includes(to)) {
      segmented.uniswap.push(tx);
    } else {
      segmented.other.push(tx);
    }
  }

  return segmented;
}
