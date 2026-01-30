import { NextRequest, NextResponse } from 'next/server';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';

// Wrapped native token addresses for price lookup per chain
const CHAINS = [
  { hex: '0x1', name: 'Ethereum', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { hex: '0x2105', name: 'Base', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0x4200000000000000000000000000000000000006' },
  { hex: '0xa4b1', name: 'Arbitrum', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  { hex: '0xa', name: 'Optimism', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    wrappedNative: '0x4200000000000000000000000000000000000006' },
  { hex: '0x89', name: 'Polygon', nativeSymbol: 'POL', nativeName: 'Polygon',
    wrappedNative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },
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

async function moralisGet(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${MORALIS_BASE}${path}`, {
    headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Moralis ${res.status}: ${text}`);
  }
  return res.json();
}

function parseBalance(rawBalance: string, decimals: number): number {
  if (!rawBalance || rawBalance === '0') return 0;
  // Handle large numbers by splitting at decimal point position
  const len = rawBalance.length;
  if (len <= decimals) {
    const padded = rawBalance.padStart(decimals + 1, '0');
    return parseFloat(padded.slice(0, padded.length - decimals) + '.' + padded.slice(padded.length - decimals));
  }
  const intPart = rawBalance.slice(0, len - decimals);
  const decPart = rawBalance.slice(len - decimals);
  return parseFloat(intPart + '.' + decPart);
}

/**
 * GET /api/demo/tokens?address=0x...
 * Fetches token balances across multiple chains using Moralis REST API
 */
export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get('address');
    if (!address) {
      return NextResponse.json({ error: 'Address required' }, { status: 400 });
    }

    const apiKey = process.env.MORALIS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'MORALIS_API_KEY not configured' }, { status: 500 });
    }

    const allTokens: TokenBalance[] = [];

    const results = await Promise.allSettled(
      CHAINS.map(async (chain) => {
        const tokens: TokenBalance[] = [];

        // 1. Fetch native balance
        try {
          const nativeData = await moralisGet(
            `/${address}/balance?chain=${chain.hex}`,
            apiKey
          );
          const rawBalance = nativeData.balance || '0';
          const balance = parseBalance(rawBalance, 18);

          if (balance > 0.00001) {
            // Get native price via wrapped token
            let nativePrice: number | null = null;
            try {
              const priceData = await moralisGet(
                `/erc20/${chain.wrappedNative}/price?chain=${chain.hex}`,
                apiKey
              );
              nativePrice = priceData.usdPrice || null;
            } catch (e) {
              console.log(`[tokens] Native price failed ${chain.name}:`, (e as Error).message?.slice(0, 80));
            }

            tokens.push({
              symbol: chain.nativeSymbol,
              name: chain.nativeName,
              balance,
              balanceRaw: rawBalance,
              decimals: 18,
              usdPrice: nativePrice,
              usdValue: nativePrice ? balance * nativePrice : null,
              chain: chain.name,
              chainHex: chain.hex,
              contractAddress: null,
              logo: null,
              isNative: true,
            });
          }
        } catch (e) {
          console.log(`[tokens] Native balance failed ${chain.name}:`, (e as Error).message?.slice(0, 80));
        }

        // 2. Fetch ERC20 balances using REST API directly
        try {
          const erc20Data = await moralisGet(
            `/${address}/erc20?chain=${chain.hex}`,
            apiKey
          );

          console.log(`[tokens] ${chain.name} ERC20: ${Array.isArray(erc20Data) ? erc20Data.length : 0} tokens found`);

          if (Array.isArray(erc20Data)) {
            for (const token of erc20Data) {
              const decimals = token.decimals ?? 18;
              const rawBal = token.balance || '0';
              const balance = parseBalance(rawBal, decimals);

              if (balance > 0) {
                // Get token price
                let usdPrice: number | null = null;
                try {
                  const priceData = await moralisGet(
                    `/erc20/${token.token_address}/price?chain=${chain.hex}`,
                    apiKey
                  );
                  usdPrice = priceData.usdPrice || null;
                } catch {
                  // Price not available for this token - that's ok
                }

                tokens.push({
                  symbol: token.symbol || 'UNKNOWN',
                  name: token.name || token.symbol || 'Unknown Token',
                  balance,
                  balanceRaw: rawBal,
                  decimals,
                  usdPrice,
                  usdValue: usdPrice ? balance * usdPrice : null,
                  chain: chain.name,
                  chainHex: chain.hex,
                  contractAddress: token.token_address || null,
                  logo: token.logo || token.thumbnail || null,
                  isNative: false,
                });
              }
            }
          }
        } catch (e) {
          console.log(`[tokens] ERC20 fetch failed ${chain.name}:`, (e as Error).message?.slice(0, 120));
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
