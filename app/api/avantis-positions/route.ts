import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const address = searchParams.get('address');
    
    if (!address) {
      return NextResponse.json({ error: 'Wallet address is required' }, { status: 400 });
    }

    // Get QuickNode RPC URL from env
    const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL || 'https://mainnet.base.org';

    const scriptPath = path.join(process.cwd(), 'scripts/python/fetch_avantis.py');
    const venvPython = path.join(process.cwd(), 'venv/bin/python');
    
    const pythonCmd = require('fs').existsSync(venvPython) ? venvPython : 'python3';
    
    const result = await new Promise<any>((resolve, reject) => {
      const python = spawn(pythonCmd, [scriptPath, address, rpcUrl]);
      let output = '';
      let errorOutput = '';

      python.stdout.on('data', (data) => {
        output += data.toString();
      });

      python.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(errorOutput || `Python script exited with code ${code}`));
        } else {
          try {
            resolve(JSON.parse(output));
          } catch (e) {
            reject(new Error(`Failed to parse Python output: ${output}`));
          }
        }
      });

      setTimeout(() => {
        python.kill();
        reject(new Error('Python script timeout'));
      }, 30000);
    });

    return NextResponse.json(result);

  } catch (error: any) {
    console.error('Error fetching Avantis positions:', error);
    return NextResponse.json({ 
      success: false,
      error: 'Failed to fetch Avantis positions', 
      details: error.message 
    }, { status: 500 });
  }
}
