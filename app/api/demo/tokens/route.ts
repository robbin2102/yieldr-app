import { NextRequest, NextResponse } from 'next/server';
import Moralis from 'moralis';

let moralisInitialized = false;

async function initMoralis() {
  if (!moralisInitialized) {
    await Moralis.start({
      apiKey: process.env.MORALIS_API_KEY || '',
    });
    moralisInitialized = true;
  }
}

// Chain configs: id, name, nativeSymbol, nativeDecimals
const CHAINS = [
  { hex: '0x1', name: 'Ethereum', nativeSymbol: 'ETH' },
  { hex: '0x2105', name: 'Base', nativeSymbol: 'ETH' },
  { hex: '0xa4b1', name: 'Arbitrum', nativeSymbol: 'ETH' },
  { hex: '0xa', name: 'Optimism', nativeSymbol: 'ETH' },
  { hex: '0x89', name: 'Polygon', nativeSymbol: 'POL' },
];

interface TokenBalance {
  symbol: string;
  name: string;
  balance: number;
  balanceRaw: string;
  decimals: number;
  usdPrice: number | null;
  usdValue: number | null;
  chain: string;
  chainHex: string;
  contractAddress: string | null;
  logo: string | null;
  isNative: boolean;
}

/**
 * GET /api/demo/tokens?address=0x...
 * Fetches token balances across multiple chains using Moralis
 */
export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get('address');
    if (!address) {
      return NextResponse.json({ error: 'Address required' }, { status: 400 });
    }

    if (!process.env.MORALIS_API_KEY) {
      return NextResponse.json({ error: 'MORALIS_API_KEY not configured' }, { status: 500 });
    }

    await initMoralis();

    const allTokens: TokenBalance[] = [];

    // Fetch native + ERC20 balances across all chains in parallel
    const results = await Promise.allSettled(
      CHAINS.map(async (chain) => {
        const tokens: TokenBalance[] = [];

        // Fetch native balance
        try {
          const nativeRes = await Moralis.EvmApi.balance.getNativeBalance({
            address,
            chain: chain.hex,
          });
          const nativeRaw = nativeRes.result.balance.value.toString();
          const nativeBalance = parseFloat(nativeRes.result.balance.ether);

          if (nativeBalance > 0.0001) {
            // Get native price
            let nativePrice: number | null = null;
            try {
              const priceRes = await Moralis.EvmApi.token.getTokenPrice({
                address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
                chain: '0x1',
              });
              nativePrice = priceRes.result.usdPrice;
            } catch {}

            tokens.push({
              symbol: chain.nativeSymbol,
              name: chain.nativeSymbol === 'POL' ? 'Polygon' : 'Ethereum',
              balance: nativeBalance,
              balanceRaw: nativeRaw,
              decimals: 18,
              usdPrice: nativePrice,
              usdValue: nativePrice ? nativeBalance * nativePrice : null,
              chain: chain.name,
              chainHex: chain.hex,
              contractAddress: null,
              logo: null,
              isNative: true,
            });
          }
        } catch {}

        // Fetch ERC20 balances
        try {
          const erc20Res = await Moralis.EvmApi.token.getWalletTokenBalances({
            address,
            chain: chain.hex,
          });

          for (const token of erc20Res.result) {
            const decimals = token.decimals || 18;
            const rawBalance = token.balance.value.toString();
            const balance = parseFloat(token.balance.ether);

            if (balance > 0) {
              // Get token price
              let usdPrice: number | null = null;
              try {
                const priceRes = await Moralis.EvmApi.token.getTokenPrice({
                  address: token.contractAddress.lowercase,
                  chain: chain.hex,
                });
                usdPrice = priceRes.result.usdPrice;
              } catch {}

              tokens.push({
                symbol: token.symbol || 'UNKNOWN',
                name: token.name || token.symbol || 'Unknown Token',
                balance,
                balanceRaw: rawBalance,
                decimals,
                usdPrice,
                usdValue: usdPrice ? balance * usdPrice : null,
                chain: chain.name,
                chainHex: chain.hex,
                contractAddress: token.contractAddress.lowercase,
                logo: token.logo || null,
                isNative: false,
              });
            }
          }
        } catch {}

        return tokens;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTokens.push(...result.value);
      }
    }

    // Sort by USD value (highest first), tokens without price last
    allTokens.sort((a, b) => {
      if (a.usdValue !== null && b.usdValue !== null) return b.usdValue - a.usdValue;
      if (a.usdValue !== null) return -1;
      if (b.usdValue !== null) return 1;
      return b.balance - a.balance;
    });

    const totalUsdValue = allTokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);

    return NextResponse.json({
      success: true,
      data: {
        tokens: allTokens,
        totalUsdValue,
        chainsScanned: CHAINS.map(c => c.name),
        tokenCount: allTokens.length,
      },
    });
  } catch (error: any) {
    console.error('Token fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
