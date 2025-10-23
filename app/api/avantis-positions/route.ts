import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('address');
    
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    const pythonServiceUrl = process.env.PYTHON_SERVICE_URL || 'https://yieldr-app-production.up.railway.app';
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || 'https://mainnet.base.org'; // FIXED!
    
    console.log('Fetching Avantis positions for:', walletAddress);
    console.log('Using Python service:', pythonServiceUrl);
    console.log('Using RPC:', rpcUrl.substring(0, 50) + '...');

    // Add 45 second timeout (Avantis can be slow)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const response = await fetch(`${pythonServiceUrl}/fetch-positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          rpcUrl
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Python service error: ${response.statusText}`);
      }

      const data = await response.json();
      
      console.log('Avantis response:', data.success ? `${data.data?.totalPositions || 0} positions` : 'failed');
      
      return NextResponse.json(data);
      
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      
      if (fetchError.name === 'AbortError') {
        console.error('⏱️ Avantis API timeout after 45s');
        return NextResponse.json({
          success: false,
          error: 'Request timeout - Avantis API taking too long',
          data: {
            totalPositions: 0,
            positions: [],
            summary: { totalPnL: 0, totalMargin: 0 }
          }
        });
      }
      
      throw fetchError;
    }
    
  } catch (error: any) {
    console.error('❌ Error fetching Avantis positions:', error);
    return NextResponse.json(
      { 
        success: false,
        error: error.message,
        data: {
          totalPositions: 0,
          positions: [],
          summary: { totalPnL: 0, totalMargin: 0 }
        }
      },
      { status: 500 }
    );
  }
}
