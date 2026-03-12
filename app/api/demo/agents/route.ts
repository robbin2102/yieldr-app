import { NextRequest, NextResponse } from 'next/server';
import { createPrivateKey } from 'crypto';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';
import { CdpClient } from '@coinbase/cdp-sdk';

// Lazy CDP client — only instantiated if env vars are present
function getCdpClient(): CdpClient | null {
  const apiKeyId     = process.env.CDP_API_KEY_ID;
  const walletSecret = process.env.CDP_WALLET_SECRET;

  // Normalize escaped \n → real newlines (handles .env.local single-line PEM storage)
  let apiKeySecret = (process.env.CDP_API_KEY_SECRET || '').replace(/\\n/g, '\n');
  // CDP SDK requires PKCS#8 ("BEGIN PRIVATE KEY"). If we have SEC1 ("BEGIN EC PRIVATE KEY"),
  // convert it automatically using Node's crypto module.
  if (apiKeySecret.includes('BEGIN EC PRIVATE KEY')) {
    try {
      apiKeySecret = createPrivateKey(apiKeySecret).export({ type: 'pkcs8', format: 'pem' }) as string;
    } catch (err: any) {
      console.error('[CDP] SEC1→PKCS#8 conversion failed:', err.message);
    }
  }
  console.log('[CDP] env check — KEY_ID:', apiKeyId ? 'SET' : 'MISSING', '| KEY_SECRET:', apiKeySecret ? 'SET' : 'MISSING', '| WALLET_SECRET:', walletSecret ? 'SET' : 'MISSING');
  if (!apiKeyId || !apiKeySecret || !walletSecret) return null;
  try {
    return new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
  } catch (err: any) {
    console.error('[CDP] client init failed:', err.message);
    return null;
  }
}

// Creates a deterministic CDP wallet per owner wallet.
// Idempotent: same ownerWallet always produces same agent wallet address.
async function createAgentWallet(ownerWallet: string): Promise<{ address: string; cdpWalletId: string } | null> {
  const cdp = getCdpClient();
  if (!cdp) return null;
  try {
    const account = await cdp.evm.createAccount({
      name: `yieldr-agent-${ownerWallet.slice(2, 10).toLowerCase()}`,
      idempotencyKey: `yieldr-agent-${ownerWallet.toLowerCase()}`,
    });
    return { address: account.address, cdpWalletId: account.address };
  } catch (err: any) {
    console.error('[CDP] wallet creation failed:', err.message);
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = await request.json();
    const { name, ownerWallet, markets, positions, followedTraders, cachedTokenBalances, cachedTokensTotalUsd } = body;

    if (!name || !ownerWallet) {
      return NextResponse.json(
        { error: 'Name and ownerWallet are required' },
        { status: 400 }
      );
    }

    const existingAgent = await Agent.findOne({
      ownerWallet: ownerWallet.toLowerCase(),
    });

    const agentData: any = {
      name,
      markets: markets || ['perps'],
      status: 'active',
      portfolioSummary: {
        totalValue: positions?.totalValue || 0,
        totalPnl: 0,
        positionCount:
          (positions?.counts?.avantis || 0) +
          (positions?.counts?.hyperliquid || 0) +
          (positions?.counts?.lp || 0) +
          (positions?.counts?.polymarket || 0),
      },
      followedTraders: followedTraders || [],
    };

    // Add token cache if provided
    if (cachedTokenBalances !== undefined) {
      agentData.cachedTokenBalances = cachedTokenBalances;
    }
    if (cachedTokensTotalUsd !== undefined) {
      agentData.cachedTokensTotalUsd = cachedTokensTotalUsd;
    }

    if (existingAgent) {
      Object.assign(existingAgent, agentData);
      await existingAgent.save();
      return NextResponse.json({ success: true, agent: existingAgent, updated: true });
    }

    // New agent — provision a dedicated CDP agentic wallet
    const wallet = await createAgentWallet(ownerWallet);
    if (wallet) {
      agentData.agentWalletAddress = wallet.address;
      agentData.cdpWalletId        = wallet.cdpWalletId;
      agentData.agentWalletNetworkId = 'base-mainnet';
    }

    const agent = new Agent({
      ownerWallet: ownerWallet.toLowerCase(),
      ...agentData,
    });
    await agent.save();
    return NextResponse.json({
      success: true,
      agent,
      created: true,
      agentWalletAddress: wallet?.address ?? null,
    });
  } catch (error) {
    console.error('Error creating agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await connectDB();
    const { wallet, name } = await request.json();
    if (!wallet || !name) {
      return NextResponse.json({ error: 'wallet and name are required' }, { status: 400 });
    }
    const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    agent.name = name.trim().slice(0, 30);
    await agent.save();
    return NextResponse.json({ success: true, agent });
  } catch (error) {
    console.error('Error renaming agent:', error);
    return NextResponse.json({ error: 'Failed to rename agent' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, agent });
  } catch (error) {
    console.error('Error fetching agent:', error);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
}
