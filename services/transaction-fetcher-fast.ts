import { ethers } from 'ethers';

export interface Transaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  blockNumber: number;
  timestamp: number;
  input: string;
  methodId: string;
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

export async function fetchTransactionsFast(
  walletAddress: string
): Promise<TransactionFetchResult> {
  console.log('⚡ FAST fetch for:', walletAddress);
  
  const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL;
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const currentBlock = await provider.getBlockNumber();
    console.log('📊 Current block:', currentBlock);

    const BLOCKS_IN_30_DAYS = 43200 * 30;
    const fromBlock = Math.max(0, currentBlock - BLOCKS_IN_30_DAYS);
    
    console.log('📅 Scanning 30 days:', fromBlock, 'to', currentBlock);

    const transactions = await fetchWithCorrectChunks(
      provider,
      walletAddress,
      fromBlock,
      currentBlock
    );

    console.log(`✅ Found ${transactions.length} transactions`);

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

async function fetchWithCorrectChunks(
  provider: ethers.JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number
): Promise<Transaction[]> {
  const transactions = new Map<string, Transaction>();
  const addressLower = address.toLowerCase();
  
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  
  console.log('📥 Fetching (10k chunks, QuickNode limit)...');

  // QuickNode limit: 10k blocks
  const CHUNK_SIZE = 10000;
  const chunks: Array<{ start: number; end: number }> = [];
  
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    chunks.push({
      start,
      end: Math.min(start + CHUNK_SIZE - 1, toBlock),
    });
  }

  console.log(`   📦 ${chunks.length} chunks (10k blocks each)`);

  // Process 5 in parallel for speed
  const PARALLEL = 5;
  
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const batch = chunks.slice(i, i + PARALLEL);
    
    const results = await Promise.all(
      batch.map(chunk => fetchChunk(provider, addressLower, chunk.start, chunk.end, transferTopic))
    );

    for (const chunkTxs of results) {
      for (const tx of chunkTxs) {
        if (tx.from.toLowerCase() === addressLower) {
          transactions.set(tx.hash, tx);
        }
      }
    }

    const progress = Math.min(i + PARALLEL, chunks.length);
    console.log(`   ⚡ ${progress}/${chunks.length} | ${transactions.size} txs`);
    
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return Array.from(transactions.values());
}

async function fetchChunk(
  provider: ethers.JsonRpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number,
  transferTopic: string
): Promise<Transaction[]> {
  try {
    const logs = await provider.getLogs({
      fromBlock,
      toBlock,
      topics: [
        transferTopic,
        ethers.zeroPadValue(address, 32),
      ],
    });

    if (logs.length === 0) return [];

    const txHashes = [...new Set(logs.map(log => log.transactionHash))];

    const txPromises = txHashes.map(hash => 
      provider.getTransaction(hash).catch(() => null)
    );
    
    const txs = await Promise.all(txPromises);
    
    const results: Transaction[] = [];
    
    for (const tx of txs) {
      if (!tx) continue;

      results.push({
        hash: tx.hash,
        from: tx.from,
        to: tx.to || null,
        value: tx.value.toString(),
        blockNumber: tx.blockNumber || 0,
        timestamp: 0,
        input: tx.data,
        methodId: tx.data.slice(0, 10),
      });
    }

    return results;
  } catch (error) {
    return [];
  }
}

function segmentByPlatform(txs: Transaction[]) {
  const segmented = {
    uniswap: [] as Transaction[],
    aerodrome: [] as Transaction[],
    zora: [] as Transaction[],
    other: [] as Transaction[],
  };

  const AERODROME = [
    '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    '0x420dd381b31aef6683db6b902084cb0ffece40da',
    '0x16613524e02ad97edef371bc883f2f5d6c480a5',
    '0x827922686190790b37229fd06084350e74485b72',
    '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',
  ];

  const UNISWAP = [
    '0x6ff5693b99212da76ad316178a184ab56d299b43',
    '0x2626664c2603336e57b271c5c0b26f421741e481',
    '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
    '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  ];

  for (const tx of txs) {
    const to = tx.to?.toLowerCase();
    if (!to) {
      segmented.other.push(tx);
      continue;
    }

    if (AERODROME.includes(to)) {
      segmented.aerodrome.push(tx);
    } else if (UNISWAP.includes(to)) {
      segmented.uniswap.push(tx);
    } else {
      segmented.other.push(tx);
    }
  }

  return segmented;
}
