import { Transaction } from './transaction-fetcher';
import { BASE_CONTRACTS } from '@/lib/contracts';

export interface SegmentedTransactions {
  uniswap: Transaction[];
  aerodrome: Transaction[];
  zora: Transaction[]; // Zora uses Uniswap Universal Router
  other: Transaction[];
}

export interface SegmentationSummary {
  total: number;
  byPlatform: {
    uniswap: number;
    aerodrome: number;
    zora: number;
    other: number;
  };
}

/**
 * Segment transactions by DeFi platform
 * 
 * IMPORTANT: Zora transactions on Base are routed through Uniswap Universal Router
 * We'll need to parse the transaction data to differentiate between:
 * - Direct Uniswap swaps
 * - Zora token purchases (also through Universal Router)
 */
export function segmentTransactionsByPlatform(
  transactions: Transaction[]
): SegmentedTransactions {
  console.log('🔀 Segmenting', transactions.length, 'transactions by platform...');

  const segmented: SegmentedTransactions = {
    uniswap: [],
    aerodrome: [],
    zora: [],
    other: [],
  };

  for (const tx of transactions) {
    const toAddress = tx.to?.toLowerCase();

    if (!toAddress) {
      segmented.other.push(tx);
      continue;
    }

    // Aerodrome - Check first since it has distinct addresses
    if (
      toAddress === BASE_CONTRACTS.AERODROME_ROUTER.toLowerCase() ||
      toAddress === BASE_CONTRACTS.AERODROME_FACTORY.toLowerCase() ||
      toAddress === BASE_CONTRACTS.AERODROME_VOTER.toLowerCase()
    ) {
      segmented.aerodrome.push(tx);
    }
    // Uniswap V3 & Zora - Both use Universal Router
    else if (
      toAddress === BASE_CONTRACTS.UNISWAP_UNIVERSAL_ROUTER.toLowerCase() ||
      toAddress === BASE_CONTRACTS.UNISWAP_V3_SWAP_ROUTER.toLowerCase() ||
      toAddress === BASE_CONTRACTS.UNISWAP_V3_POSITION_MANAGER.toLowerCase() ||
      toAddress === BASE_CONTRACTS.UNISWAP_V3_FACTORY.toLowerCase()
    ) {
      // For now, put all Universal Router transactions in uniswap
      // We'll differentiate Zora vs Uniswap in the parsing phase
      // by checking transaction input data or logs
      segmented.uniswap.push(tx);
      
      // TODO: In Phase 2, we can parse tx.input to distinguish Zora from Uniswap
      // For MVP, we'll classify them together since they use same infrastructure
    }
    // Other
    else {
      segmented.other.push(tx);
    }
  }

  // Log summary
  console.log('📊 Segmentation complete:');
  console.log('   Uniswap (includes Zora):', segmented.uniswap.length);
  console.log('   Aerodrome:', segmented.aerodrome.length);
  console.log('   Zora: (combined with Uniswap for MVP)');
  console.log('   Other:', segmented.other.length);

  return segmented;
}

/**
 * Get segmentation summary
 */
export function getSegmentationSummary(
  segmented: SegmentedTransactions
): SegmentationSummary {
  return {
    total:
      segmented.uniswap.length +
      segmented.aerodrome.length +
      segmented.zora.length +
      segmented.other.length,
    byPlatform: {
      uniswap: segmented.uniswap.length,
      aerodrome: segmented.aerodrome.length,
      zora: segmented.zora.length, // Will be 0 for MVP, combined with uniswap
      other: segmented.other.length,
    },
  };
}

/**
 * Helper function to check if transaction is likely a Zora transaction
 * This is a basic heuristic - can be improved in Phase 2
 */
export function isLikelyZoraTransaction(tx: Transaction): boolean {
  // Check transaction input data for Zora-specific patterns
  // For MVP, we'll implement basic detection
  // In Phase 2, we can parse the actual calldata
  
  const input = tx.input.toLowerCase();
  
  // Zora transactions might have specific patterns in their data
  // This is a placeholder - you'll need to analyze actual Zora transactions
  // to find distinguishing patterns
  
  return false; // For MVP, don't separate yet
}
