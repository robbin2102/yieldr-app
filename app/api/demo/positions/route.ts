import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Position from '@/models/Position';

const BANKR_API_BASE = 'https://api.bankr.bot';
const BANKR_API_KEY = process.env.BANKR_API_KEY ?? '';
const BANKR_WALLET_ADDRESS = '0xcdc44ffda057aca49bb9c8b7d54de212742729c7';

/**
 * GET /api/demo/positions?wallet=0x...
 * Returns active agent positions from MongoDB.
 * Frontend polls this every 30s when positions are open.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get('wallet');
  if (!wallet) {
    return NextResponse.json({ error: 'wallet param required' }, { status: 400 });
  }

  await connectDB();
  const positions = await Position.find({
    walletAddress: wallet.toLowerCase(),
    agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
    status: 'active',
  }).sort({ createdAt: -1 }).lean();

  return NextResponse.json({ positions, agentWallet: BANKR_WALLET_ADDRESS });
}

/**
 * POST /api/demo/positions?wallet=0x...
 * Fetches live PnL from Bankr and updates MongoDB positions.
 * Called by frontend every 30s for active positions.
 */
export async function POST(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get('wallet');
  if (!wallet) {
    return NextResponse.json({ error: 'wallet param required' }, { status: 400 });
  }
  if (!BANKR_API_KEY) {
    return NextResponse.json({ error: 'BANKR_API_KEY not configured' }, { status: 500 });
  }

  try {
    // Fetch live positions from Bankr
    const submitRes = await fetch(`${BANKR_API_BASE}/agent/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': BANKR_API_KEY },
      body: JSON.stringify({ prompt: 'show my open Avantis positions with current pnl, entry price, current price, leverage, direction, and pair' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!submitRes.ok) {
      return NextResponse.json({ error: `Bankr API error: ${submitRes.status}` }, { status: 502 });
    }
    const { jobId } = await submitRes.json();

    // Poll for result (max 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(`${BANKR_API_BASE}/agent/job/${jobId}`, {
        headers: { 'X-API-Key': BANKR_API_KEY },
        signal: AbortSignal.timeout(10_000),
      });
      const job = await pollRes.json();
      if (job.status === 'pending' || job.status === 'processing') continue;

      if (job.status === 'completed' && job.response) {
        const responseText = job.response;

        // Check if Bankr says no positions
        if (/no\s+(open\s+)?positions|don't have any/i.test(responseText)) {
          await connectDB();
          await Position.updateMany(
            { agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(), platform: 'Avantis', status: 'active' },
            { $set: { status: 'closed', updatedAt: new Date() } }
          );
          return NextResponse.json({ positions: [], raw: responseText });
        }

        // Parse PnL and price data from Bankr response and update existing positions
        await connectDB();
        const activePositions = await Position.find({
          walletAddress: wallet.toLowerCase(),
          agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
          status: 'active',
        }).lean();

        // Try to extract numeric PnL from response
        const pnlMatch = responseText.match(/pnl[:\s]*\$?([-+]?[\d,]+\.?\d*)/i);
        const currentPriceMatch = responseText.match(/current[:\s]*\$?([\d,]+\.?\d*)/i);

        if (activePositions.length > 0 && (pnlMatch || currentPriceMatch)) {
          const pnl = pnlMatch ? parseFloat(pnlMatch[1].replace(/,/g, '')) : undefined;
          const currentPrice = currentPriceMatch ? parseFloat(currentPriceMatch[1].replace(/,/g, '')) : undefined;
          const updateFields: any = { updatedAt: new Date() };
          if (pnl !== undefined) updateFields.pnl = pnl;
          if (currentPrice !== undefined) updateFields.currentPrice = currentPrice;
          if (pnl !== undefined && activePositions[0].margin) {
            updateFields.roi = (pnl / activePositions[0].margin) * 100;
          }

          await Position.updateMany(
            { agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(), platform: 'Avantis', status: 'active' },
            { $set: updateFields }
          );
        }

        const updatedPositions = await Position.find({
          walletAddress: wallet.toLowerCase(),
          agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
          status: 'active',
        }).sort({ createdAt: -1 }).lean();

        return NextResponse.json({ positions: updatedPositions, raw: responseText, agentWallet: BANKR_WALLET_ADDRESS });
      }

      return NextResponse.json({ error: `Bankr job ended with status: ${job.status}` }, { status: 502 });
    }

    return NextResponse.json({ error: 'Bankr position fetch timed out' }, { status: 504 });
  } catch (err: any) {
    console.error(`[positions/refresh] Error: ${err.message}`);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
