import { ethers } from 'ethers';

export interface ParsedPosition {
  platform: 'uniswap' | 'aerodrome' | 'zora';
  type: 'lp' | 'swap';
  
  positionId?: string;
  hash: string;
  blockNumber: number;
  timestamp: number;
  
  token0?: string;
  token1?: string;
  token0Symbol?: string;
  token1Symbol?: string;
  
  liquidity?: string;
  amount0?: string;
  amount1?: string;
  
  amountIn?: string;
  amountOut?: string;
  tokenIn?: string;
  tokenOut?: string;
  
  action: 'open' | 'close' | 'swap';
  
  pnl?: number;
  roi?: number;
}

export interface PositionGroup {
  positionId: string;
  platform: string;
  token0: string;
  token1: string;
  opens: ParsedPosition[];
  closes: ParsedPosition[];
  isOpen: boolean;
  currentLiquidity?: string;
  totalPnl?: number;
  totalRoi?: number;
}

// Position Manager contract addresses
const POSITION_MANAGERS = {
  aerodrome: '0x827922686190790b37229fd06084350e74485b72',
  uniswap: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
};

// ABI for positions() function
const POSITION_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

/**
 * Check if a position is still open by querying on-chain liquidity
 */
async function checkPositionLiquidity(
  positionId: string,
  platform: 'uniswap' | 'aerodrome',
  provider: ethers.JsonRpcProvider
): Promise<{ isOpen: boolean; liquidity: string }> {
  try {
    const managerAddress = POSITION_MANAGERS[platform];
    const contract = new ethers.Contract(managerAddress, POSITION_ABI, provider);
    
    const position = await contract.positions(positionId);
    const liquidity = position.liquidity.toString();
    
    // Position is closed if liquidity is 0 or very close to 0
    const isOpen = BigInt(liquidity) > BigInt(100); // Allow for dust
    
    return { isOpen, liquidity };
  } catch (error) {
    console.error(`Error checking position ${positionId}:`, error);
    return { isOpen: false, liquidity: '0' };
  }
}

export async function parseTransaction(
  tx: any,
  platform: 'uniswap' | 'aerodrome' | 'zora',
  provider: ethers.JsonRpcProvider
): Promise<ParsedPosition | null> {
  const methodId = tx.methodId || tx.input?.slice(0, 10);
  
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(tx.hash);
  } catch (error) {
    console.error(`Failed to get receipt for ${tx.hash}`);
    return null;
  }

  if (!receipt) return null;

  if (platform === 'aerodrome') {
    return parseAerodromeTransaction(tx, receipt, methodId);
  } else if (platform === 'uniswap') {
    return parseUniswapTransaction(tx, receipt, methodId);
  } else if (platform === 'zora') {
    return parseZoraTransaction(tx, receipt);
  }

  return null;
}

function parseAerodromeTransaction(tx: any, receipt: any, methodId: string): ParsedPosition | null {
  const METHODS: Record<string, string> = {
    '0x88316456': 'mint',
    '0xb5007d1f': 'mint',
    '0x0c49ccbe': 'decreaseLiquidity',
    '0xfc6f7865': 'collect',
    '0x219f5d17': 'increaseLiquidity',
    '0xac9650d8': 'multicall', // Batch operations
  };

  const method = METHODS[methodId];
  const { tokens, amounts, positionId } = extractFromLogs(receipt.logs);

  if (method === 'mint' || method === 'increaseLiquidity' || method === 'multicall') {
    return {
      platform: 'aerodrome',
      type: 'lp',
      action: 'open',
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp || 0,
      positionId: positionId || tx.hash,
      token0: tokens[0],
      token1: tokens[1],
      amount0: amounts[0],
      amount1: amounts[1],
    };
  }

  if (method === 'decreaseLiquidity' || method === 'collect') {
    return {
      platform: 'aerodrome',
      type: 'lp',
      action: 'close',
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp || 0,
      positionId: positionId || 'unknown',
      token0: tokens[0],
      token1: tokens[1],
      amount0: amounts[0],
      amount1: amounts[1],
    };
  }

  console.log(`   ⚠️ Unknown Aerodrome method: ${methodId}`);
  return null;
}

function parseUniswapTransaction(tx: any, receipt: any, methodId: string): ParsedPosition | null {
  const METHODS: Record<string, string> = {
    '0x3593564c': 'execute',
    '0x88316456': 'mint',
    '0xfc6f7865': 'collect',
    '0x0c49ccbe': 'decreaseLiquidity',
    '0x219f5d17': 'increaseLiquidity',
    '0xac9650d8': 'multicall',
  };

  const method = METHODS[methodId];
  const { tokens, amounts, positionId } = extractFromLogs(receipt.logs);

  if (method === 'execute') {
    return {
      platform: 'uniswap',
      type: 'swap',
      action: 'swap',
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp || 0,
      tokenIn: tokens[0],
      tokenOut: tokens[1],
      amountIn: amounts[0],
      amountOut: amounts[1],
    };
  }

  if (method === 'mint' || method === 'increaseLiquidity' || method === 'multicall') {
    return {
      platform: 'uniswap',
      type: 'lp',
      action: 'open',
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp || 0,
      positionId: positionId || tx.hash,
      token0: tokens[0],
      token1: tokens[1],
      amount0: amounts[0],
      amount1: amounts[1],
    };
  }

  if (method === 'decreaseLiquidity' || method === 'collect') {
    return {
      platform: 'uniswap',
      type: 'lp',
      action: 'close',
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp || 0,
      positionId: positionId || 'unknown',
      token0: tokens[0],
      token1: tokens[1],
      amount0: amounts[0],
      amount1: amounts[1],
    };
  }

  return null;
}

function parseZoraTransaction(tx: any, receipt: any): ParsedPosition | null {
  const { tokens, amounts } = extractFromLogs(receipt.logs);

  if (tokens.length >= 2) {
    return {
      platform: 'zora',
      type: 'swap',
      action: 'swap',
      hash: tx.hash,
      blockNumber: tx.blockNumber,
      timestamp: tx.timestamp || 0,
      tokenIn: tokens[0],
      tokenOut: tokens[1],
      amountIn: amounts[0],
      amountOut: amounts[1],
    };
  }

  return null;
}

function extractFromLogs(logs: any[]): { tokens: string[], amounts: string[], positionId?: string } {
  const tokens: string[] = [];
  const amounts: string[] = [];
  let positionId: string | undefined;

  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

  for (const log of logs) {
    if (log.topics[0] === transferTopic && log.topics.length === 3) {
      const token = log.address;
      const amount = ethers.getBigInt(log.data).toString();
      
      tokens.push(token);
      amounts.push(amount);
    }

    if (log.topics[0] === transferTopic && log.topics.length === 4) {
      positionId = ethers.getBigInt(log.topics[3]).toString();
    }
  }

  return { tokens, amounts, positionId };
}

export async function parseAllTransactions(
  uniswap: any[],
  aerodrome: any[],
  zora: any[],
  provider: ethers.JsonRpcProvider
): Promise<ParsedPosition[]> {
  console.log('🔍 Parsing transactions with logs...');
  
  const positions: ParsedPosition[] = [];

  for (const tx of aerodrome) {
    const parsed = await parseTransaction(tx, 'aerodrome', provider);
    if (parsed) {
      positions.push(parsed);
      console.log(`   ✓ Aerodrome ${parsed.action}: ${tx.hash.slice(0, 10)}...`);
    }
  }

  for (const tx of uniswap) {
    const parsed = await parseTransaction(tx, 'uniswap', provider);
    if (parsed) {
      positions.push(parsed);
      console.log(`   ✓ Uniswap ${parsed.action}: ${tx.hash.slice(0, 10)}...`);
    }
  }

  for (const tx of zora) {
    const parsed = await parseTransaction(tx, 'zora', provider);
    if (parsed) {
      positions.push(parsed);
      console.log(`   ✓ Zora ${parsed.action}: ${tx.hash.slice(0, 10)}...`);
    }
  }

  console.log(`✅ Parsed ${positions.length} positions`);

  return positions;
}

/**
 * Group and check on-chain liquidity to determine if positions are truly open
 */
export async function groupAndCalculatePnL(
  positions: ParsedPosition[],
  provider: ethers.JsonRpcProvider
): Promise<PositionGroup[]> {
  console.log('💰 Checking on-chain liquidity & calculating PnL...');

  const lpPositions = positions.filter(p => p.type === 'lp');
  const grouped = new Map<string, PositionGroup>();

  for (const pos of lpPositions) {
    const key = pos.positionId || pos.hash;

    if (!grouped.has(key)) {
      grouped.set(key, {
        positionId: key,
        platform: pos.platform,
        token0: pos.token0 || '',
        token1: pos.token1 || '',
        opens: [],
        closes: [],
        isOpen: true,
      });
    }

    const group = grouped.get(key)!;

    if (pos.action === 'open') {
      group.opens.push(pos);
    } else if (pos.action === 'close') {
      group.closes.push(pos);
    }
  }

  const results: PositionGroup[] = [];

  // Check each position on-chain
  for (const [_, group] of grouped) {
    // Only check if we have a numeric position ID
    if (group.positionId && !group.positionId.startsWith('0x')) {
      const { isOpen, liquidity } = await checkPositionLiquidity(
        group.positionId,
        group.platform as 'uniswap' | 'aerodrome',
        provider
      );

      group.isOpen = isOpen;
      group.currentLiquidity = liquidity;

      console.log(`   📊 Position ${group.positionId}: ${isOpen ? '🟢 OPEN' : '🔴 CLOSED'} (liquidity: ${liquidity})`);
    } else {
      // If we can't check on-chain, assume closed if there are close transactions
      group.isOpen = group.closes.length === 0;
    }

    // Calculate PnL for closed positions
    if (!group.isOpen) {
      const totalDeposit0 = group.opens.reduce((sum, p) => 
        sum + BigInt(p.amount0 || '0'), BigInt(0)
      );
      const totalDeposit1 = group.opens.reduce((sum, p) => 
        sum + BigInt(p.amount1 || '0'), BigInt(0)
      );

      const totalWithdraw0 = group.closes.reduce((sum, p) => 
        sum + BigInt(p.amount0 || '0'), BigInt(0)
      );
      const totalWithdraw1 = group.closes.reduce((sum, p) => 
        sum + BigInt(p.amount1 || '0'), BigInt(0)
      );

      const pnl0 = Number(totalWithdraw0 - totalDeposit0) / 1e18;
      const pnl1 = Number(totalWithdraw1 - totalDeposit1) / 1e18;
      
      group.totalPnl = pnl0 + pnl1;
      group.totalRoi = totalDeposit0 > 0 
        ? ((Number(totalWithdraw0) - Number(totalDeposit0)) / Number(totalDeposit0)) * 100
        : 0;

      console.log(`   💰 Position ${group.positionId.slice(0, 10)}: PnL ${group.totalPnl.toFixed(4)}, ROI ${group.totalRoi.toFixed(2)}%`);
    }

    results.push(group);
  }

  return results;
}
