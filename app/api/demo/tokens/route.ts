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

// Wrapped native token addresses for price lookup per chain
const CHAINS = [
  { hex: '0x1', name: 'Ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }, // WETH on Ethereum
  { hex: '0x2105', name: 'Base', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0x4200000000000000000000000000000000000006' }, // WETH on Base
  { hex: '0xa4b1', name: 'Arbitrum', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' }, // WETH on Arbitrum
  { hex: '0xa', name: 'Optimism', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0x4200000000000000000000000000000000000006' }, // WETH on Optimism
  { hex: '0x89', name: 'Polygon', nativeSymbol: 'POL', nativeName: 'Polygon',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' }, // WPOL/WMATIC on Polygon
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

          if (nativeBalance > 0.00001) {
            // Get native price using the wrapped native token on the SAME chain
            let nativePrice: number | null = null;
            try {
              const priceRes = await Moralis.EvmApi.token.getTokenPrice({
                address: chain.wrappedNative,
                chain: chain.hex,
              });
              nativePrice = priceRes.result.usdPrice;
            } catch (e) {
              console.log(`[tokens] Native price fetch failed for ${chain.nativeSymbol} on ${chain.name}:`, (e as Error).message);
            }

            tokens.push({
              symbol: chain.nativeSymbol,
              name: chain.nativeName,
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
        } catch (e) {
          console.log(`[tokens] Native balance failed for ${chain.name}:`, (e as Error).message);
        }

        // Fetch ERC20 balances with prices
        try {
          const erc20Res = await Moralis.EvmApi.token.getWalletTokenBalancesPrice({
            address,
            chain: chain.hex,
          });

          for (const token of erc20Res.result) {
            const decimals = token.decimals || 18;
            const rawBalance = token.balanceFormatted;
            const balance = parseFloat(rawBalance);

            if (balance > 0 && !token.nativeToken) {
              tokens.push({
                symbol: token.symbol || 'UNKNOWN',
                name: token.name || token.symbol || 'Unknown Token',
                balance,
                balanceRaw: token.balance.toString(),
                decimals,
                usdPrice: token.usdPrice ?? null,
                usdValue: token.usdValue ?? null,
                chain: chain.name,
                chainHex: chain.hex,
                contractAddress: token.tokenAddress?.lowercase || null,
                logo: token.logo || token.thumbnail || null,
                isNative: false,
              });
            }
          }
        } catch (e) {
          console.log(`[tokens] ERC20 fetch failed for ${chain.name}:`, (e as Error).message);
          // Fallback: try the basic endpoint without prices
          try {
            const erc20Res = await Moralis.EvmApi.token.getWalletTokenBalances({
              address,
              chain: chain.hex,
            });

            for (const token of erc20Res.result) {
              const decimals = token.decimals || 18;
              // Manual decimal conversion for proper balance
              const rawBigInt = BigInt(token.balance.value.toString());
              const balance = Number(rawBigInt) / Math.pow(10, decimals);

              if (balance > 0) {
                // Try to get price individually
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
                  balanceRaw: token.balance.value.toString(),
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
          } catch (e2) {
            console.log(`[tokens] ERC20 fallback also failed for ${chain.name}:`, (e2 as Error).message);
          }
        }

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
