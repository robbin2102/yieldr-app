import { ethers } from 'ethers';
import { BLOCKS_IN_30_DAYS } from '@/lib/contracts';

export interface Transaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: number;
  timestamp: number;
  gasUsed?: string;
  input: string;
}

export interface TransactionFetchResult {
  walletAddress: string;
  totalTransactions: number;
  transactions: Transaction[];
  startBlock: number;
  endBlock: number;
  fetchedAt: Date;
}

// Rate limiting helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch transactions for a wallet address from the last 30 days
 */
export async function fetchLast30DaysTransactions(
  walletAddress: string
): Promise<TransactionFetchResult> {
  console.log('🔍 Fetching transactions for:', walletAddress);
  
  const provider = new ethers.JsonRpcProvider(
    process.env.QUICKNODE_BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  );

  try {
    const currentBlock = await provider.getBlockNumber();
    console.log('📊 Current block:', currentBlock);

    const startBlock = Math.max(0, currentBlock - BLOCKS_IN_30_DAYS);
    console.log('📅 Fetching from block:', startBlock, 'to', currentBlock);

    // NEW: Smart sampling instead of full scan
    console.log('🎯 Using SMART SAMPLING (fast mode)');
    const transactions = await fetchTransactionsSampled(
      provider,
      walletAddress,
      startBlock,
      currentBlock
    );

    console.log('✅ Found', transactions.length, 'transactions');

    return {
      walletAddress: walletAddress.toLowerCase(),
      totalTransactions: transactions.length,
      transactions,
      startBlock,
      endBlock: currentBlock,
      fetchedAt: new Date(),
    };
  } catch (error) {
    console.error('❌ Error fetching transactions:', error);
    throw new Error(`Failed to fetch transactions: ${error}`);
  }
}

/**
 * SMART SAMPLING: Sample recent blocks heavily, older blocks lightly
 */
async function fetchTransactionsSampled(
  provider: ethers.JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];
  const addressLower = address.toLowerCase();

  console.log(`🔄 Smart sampling strategy:`);

  // Sample heavily from recent, lightly from old
  const ranges = [
    { 
      from: Math.max(fromBlock, toBlock - (43200 * 7)), 
      to: toBlock, 
      step: 1,
      label: 'Last 7 days (100% coverage)'
    },
    { 
      from: Math.max(fromBlock, toBlock - (43200 * 14)), 
      to: toBlock - (43200 * 7), 
      step: 10,
      label: 'Days 8-14 (10% sample)'
    },
    { 
      from: fromBlock, 
      to: toBlock - (43200 * 14), 
      step: 50,
      label: 'Days 15-30 (2% sample)'
    },
  ];

  for (const range of ranges) {
    console.log(`   📍 ${range.label}`);
    const rangeTxs = await scanBlockRangeWithRateLimit(
      provider,
      addressLower,
      range.from,
      range.to,
      range.step
    );
    transactions.push(...rangeTxs);
    console.log(`      ✓ Found ${rangeTxs.length} transactions`);
  }

  return transactions;
}

/**
 * Scan with rate limiting
 */
async function scanBlockRangeWithRateLimit(
  provider: ethers.JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number,
  step: number = 1
): Promise<Transaction[]> {
  const transactions: Transaction[] = [];
  
  let processedBlocks = 0;
  const totalBlocks = Math.floor((toBlock - fromBlock) / step);

  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum += step) {
    try {
      const block = await provider.getBlock(blockNum, true);
      
      if (!block || !block.transactions) continue;

      for (const txHash of block.transactions) {
        if (typeof txHash === 'string') {
          await delay(20); // 20ms delay
          
          const tx = await provider.getTransaction(txHash);
          
          if (!tx) continue;

          if (
            tx.from.toLowerCase() === address ||
            tx.to?.toLowerCase() === address
          ) {
            transactions.push({
              hash: tx.hash,
              from: tx.from,
              to: tx.to || null,
              value: tx.value.toString(),
              blockNumber: tx.blockNumber || blockNum,
              timestamp: block.timestamp,
              input: tx.data,
            });
          }
        }
      }

      processedBlocks++;
      
      if (processedBlocks % 100 === 0) {
        console.log(`         Progress: ${processedBlocks}/${totalBlocks} blocks`);
      }

      if (processedBlocks % 10 === 0) {
        await delay(250); // Batch delay
      }

    } catch (error: any) {
      if (error?.error?.code === -32007) {
        console.log(`   ⚠️ Rate limit, waiting 2s...`);
        await delay(2000);
        blockNum -= step;
        continue;
      }
      // Skip failed blocks
    }
  }

  return transactions;
}
