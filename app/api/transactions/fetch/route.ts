import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { fetchTransactionsFast } from '@/services/transaction-fetcher-fast';
import { parseAllTransactions, groupAndCalculatePnL } from '@/services/transaction-parser';

export async function POST(request: NextRequest) {
  try {
    const { walletAddress } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    console.log('🚀 Fetching & parsing for:', walletAddress);

    // Step 1: Fetch transactions
    const result = await fetchTransactionsFast(walletAddress);

    // Step 2: Parse with provider
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    const parsed = await parseAllTransactions(
      result.segmented.uniswap,
      result.segmented.aerodrome,
      result.segmented.zora,
      provider
    );

    // Step 3: Group and CHECK ON-CHAIN LIQUIDITY
    const grouped = await groupAndCalculatePnL(parsed, provider);

    const livePositions = grouped.filter(g => g.isOpen);
    const closedPositions = grouped.filter(g => !g.isOpen);

    console.log(`✅ ${livePositions.length} live, ${closedPositions.length} closed`);

    return NextResponse.json({
      success: true,
      walletAddress: result.walletAddress,
      summary: result.summary,
      positions: {
        live: livePositions,
        closed: closedPositions,
        counts: {
          live: livePositions.length,
          closed: closedPositions.length,
        },
      },
      data: {
        totalTransactions: result.totalTransactions,
        fetchedAt: result.fetchedAt,
      },
    });
  } catch (error: any) {
    console.error('❌ Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch transactions: ' + error.message },
      { status: 500 }
    );
  }
}
