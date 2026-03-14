/**
 * toolResultInterpreter.ts
 *
 * Deterministic state classifier for execution tool results.
 * Every execution tool result is classified into exactly one state BEFORE
 * it enters Claude's context window. Claude never sees raw execution tool results.
 *
 * Architecture:
 *   Tool call → Backend response (raw JSON) → classifyToolResult() → Classified message → Claude's context
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ExecutionStatus =
  // Success
  | 'CONFIRMED'
  // Failure — tool responded but operation failed
  | 'INSUFFICIENT_FUNDS'
  | 'LOW_GAS'
  | 'CONTRACT_REVERT'
  | 'APPROVAL_REQUIRED'
  | 'SLIPPAGE_EXCEEDED'
  | 'POSITION_NOT_FOUND'
  | 'ALREADY_CLOSED'
  // Infrastructure — tool didn't respond properly
  | 'NETWORK_FAIL'
  | 'PARSE_FAIL'
  // Safety — suspicious response from backend
  | 'SUSPICIOUS'
  | 'UNKNOWN_ERROR';

export interface ClassifiedResult {
  toolName: string;
  status: ExecutionStatus;
  txHash?: string;
  /** Human-readable error extracted from the raw result */
  errorDetail?: string;
  /** The full message injected into Claude's context */
  classifiedMessage: string;
  /** Raw parsed result, if parsing succeeded */
  rawData?: Record<string, any>;
}

// Execution tools that must go through the classifier.
// Read tools (get_market_snapshot, get_top_perp_traders, etc.) pass through unchanged.
export const EXECUTION_TOOLS = new Set([
  'open_trade',
  'close_trade',
  'cancel_limit_order',
  'withdraw_funds',
  'fund_agent',
  'fund_agent_eth',
]);

// ─── tx_hash validation ───────────────────────────────────────────────────────

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

function extractTxHash(data: Record<string, any>): string | undefined {
  // Check multiple field names backends use
  const candidates = [
    data.tx_hash,
    data.txHash,
    data.transactionHash,
    data.hash,
    data.transaction?.hash,
    data.data?.tx_hash,
    data.data?.txHash,
    data.data?.transactionHash,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && TX_HASH_REGEX.test(c)) return c;
  }
  return undefined;
}

// ─── Error pattern matching ───────────────────────────────────────────────────

function classifyError(errorStr: string): ExecutionStatus {
  const e = errorStr.toLowerCase();

  if (/insufficient (usdc|collateral|balance|funds)|not enough (usdc|funds)|usdc.*required|collateral.*exceed/i.test(e))
    return 'INSUFFICIENT_FUNDS';

  if (/insufficient eth|not enough eth|low gas|gas.*insufficient|eth.*gas|gas.*limit/i.test(e))
    return 'LOW_GAS';

  if (/revert|execution reverted|vm exception|call_exception|transaction failed on.chain/i.test(e))
    return 'CONTRACT_REVERT';

  if (/approve|allowance|erc20.*transfer.*amount.*exceeds|not approved/i.test(e))
    return 'APPROVAL_REQUIRED';

  if (/slippage|price moved|price impact|acceptable price|max slippage/i.test(e))
    return 'SLIPPAGE_EXCEEDED';

  if (/position not found|no open position|invalid trade index|trade.*not.*exist/i.test(e))
    return 'POSITION_NOT_FOUND';

  if (/already closed|already cancelled|position.*closed|order.*cancelled/i.test(e))
    return 'ALREADY_CLOSED';

  if (/fetch failed|econnrefused|etimedout|enotfound|socket hang up|timeout|network.*error|service.*unavailable/i.test(e))
    return 'NETWORK_FAIL';

  return 'UNKNOWN_ERROR';
}

// ─── Per-status message builders ─────────────────────────────────────────────

function buildClassifiedMessage(
  toolName: string,
  status: ExecutionStatus,
  txHash?: string,
  errorDetail?: string,
  rawData?: Record<string, any>,
): string {
  const header = `[TOOL_RESULT_CLASSIFIED]\nTool: ${toolName}\nStatus: ${status}`;

  switch (status) {
    case 'CONFIRMED':
      return [
        header,
        `Transaction verified on-chain. Hash: ${txHash}`,
        `You MAY report success to the user. Use ONLY this exact hash: ${txHash}`,
        `Do NOT add any other hash, amount, or trade detail not present in the tool result below.`,
        rawData ? `Result: ${JSON.stringify(rawData)}` : '',
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].filter(Boolean).join('\n');

    case 'INSUFFICIENT_FUNDS': {
      const usdc = rawData?.usdc_balance ?? rawData?.available ?? 'unknown';
      const needed = rawData?.required ?? rawData?.collateral ?? 'unknown';
      const deficit = (typeof usdc === 'number' && typeof needed === 'number')
        ? (needed - usdc).toFixed(2) : 'unknown';
      return [
        header,
        `Agent wallet has insufficient USDC.`,
        `Available: $${usdc} USDC | Required: $${needed} USDC | Deficit: $${deficit} USDC`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user: the trade could not execute because the agent wallet needs $${deficit} more USDC. Provide the agent wallet address and ask them to deposit.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');
    }

    case 'LOW_GAS':
      return [
        header,
        `Agent wallet has insufficient ETH for gas.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user: the agent wallet needs at least 0.00005 ETH for gas on Base. Provide the agent wallet address and ask them to send ETH.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'CONTRACT_REVERT':
      return [
        header,
        `The on-chain transaction was reverted by the contract.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user the trade failed due to a contract revert. Suggest checking position size, leverage limits, or pair availability.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'APPROVAL_REQUIRED':
      return [
        header,
        `The agent wallet has not approved the protocol to spend USDC.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user the agent wallet needs to approve USDC spending on Avantis before this trade can execute.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'SLIPPAGE_EXCEEDED':
      return [
        header,
        `The trade failed because price moved beyond the acceptable slippage tolerance.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user the market moved too fast. They may retry with a wider slippage tolerance or a limit order.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'POSITION_NOT_FOUND':
      return [
        header,
        `No open position was found at the specified trade index.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user the position may have already been closed or the trade index is wrong. Call get_avantis_live_positions to refresh.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'ALREADY_CLOSED':
      return [
        header,
        `The position or order is already closed or cancelled.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user this position or order no longer exists.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'NETWORK_FAIL':
      return [
        header,
        `The execution service is unreachable. No on-chain action was taken.`,
        `Do NOT proceed. Do NOT use balance or position data from earlier in this conversation.`,
        `Do NOT fabricate a tx_hash or claim the operation succeeded.`,
        `Tell the user the service is temporarily unavailable and ask them to retry in a moment.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'PARSE_FAIL':
      return [
        header,
        `The execution service returned an unparseable response. The on-chain state is unknown.`,
        `Do NOT report success or failure with certainty. Do NOT fabricate a tx_hash.`,
        `Tell the user the service returned an unexpected response and they should check Basescan or their wallet to confirm whether any transaction went through.`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'SUSPICIOUS':
      return [
        header,
        `ALERT: The backend returned success:true but NO valid tx_hash was found. This is not a confirmed transaction.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user the execution service returned an ambiguous response — no transaction hash was provided. Ask them to check their wallet or Basescan before assuming the trade went through.`,
        `Raw response: ${rawData ? JSON.stringify(rawData) : 'unavailable'}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');

    case 'UNKNOWN_ERROR':
    default:
      return [
        header,
        `The execution tool returned an unrecognised error.`,
        `Do NOT report success. Do NOT fabricate a tx_hash.`,
        `Tell the user the operation failed and share the error below so they can decide next steps.`,
        `Error: ${errorDetail}`,
        `[/TOOL_RESULT_CLASSIFIED]`,
      ].join('\n');
  }
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export function classifyToolResult(toolName: string, rawResult: string): ClassifiedResult {
  // Non-execution tools pass through — caller should check EXECUTION_TOOLS first
  if (!EXECUTION_TOOLS.has(toolName)) {
    throw new Error(`classifyToolResult called on non-execution tool: ${toolName}`);
  }

  // fund_agent and fund_agent_eth use a different flow (emit deposit events to frontend).
  // They do not produce tx_hashes themselves — treat success responses as pass-through CONFIRMED.
  if (toolName === 'fund_agent' || toolName === 'fund_agent_eth') {
    let data: Record<string, any> = {};
    try { data = JSON.parse(rawResult); } catch {}
    const status = data.success === false ? 'UNKNOWN_ERROR' : 'CONFIRMED';
    const msg = buildClassifiedMessage(toolName, status, undefined, data.error, data);
    return { toolName, status, classifiedMessage: msg, rawData: data };
  }

  // 1. Try to parse JSON
  let data: Record<string, any>;
  try {
    data = JSON.parse(rawResult);
  } catch {
    console.warn(`[toolResultInterpreter] PARSE_FAIL for tool "${toolName}": raw="${rawResult.slice(0, 200)}"`);
    const msg = buildClassifiedMessage(toolName, 'PARSE_FAIL');
    return { toolName, status: 'PARSE_FAIL', classifiedMessage: msg };
  }

  // 2. Check for explicit failure
  if (data.success === false || data.error) {
    const errorStr = String(data.error || 'Unknown error');
    const status = classifyError(errorStr);

    // Attach balance info for INSUFFICIENT_FUNDS when available
    const enriched = status === 'INSUFFICIENT_FUNDS'
      ? { ...data, usdc_balance: data.usdc_balance, required: data.required }
      : data;

    console.warn(`[toolResultInterpreter] ${status} for tool "${toolName}": ${errorStr.slice(0, 200)}`);
    const msg = buildClassifiedMessage(toolName, status, undefined, errorStr, enriched);
    return { toolName, status, errorDetail: errorStr, classifiedMessage: msg, rawData: data };
  }

  // 3. Backend claims success — verify tx_hash
  if (data.success === true || (!data.error && !data.success)) {
    const txHash = extractTxHash(data);

    if (txHash) {
      // CONFIRMED — the only state where Claude can report success
      const msg = buildClassifiedMessage(toolName, 'CONFIRMED', txHash, undefined, data);
      return { toolName, status: 'CONFIRMED', txHash, classifiedMessage: msg, rawData: data };
    } else {
      // success:true but no valid tx_hash — suspicious
      console.warn(`[toolResultInterpreter] SUSPICIOUS for tool "${toolName}": success=true but no tx_hash. Raw: ${rawResult.slice(0, 300)}`);
      const msg = buildClassifiedMessage(toolName, 'SUSPICIOUS', undefined, undefined, data);
      return { toolName, status: 'SUSPICIOUS', classifiedMessage: msg, rawData: data };
    }
  }

  // 4. Fallthrough — unrecognised shape
  const status: ExecutionStatus = 'UNKNOWN_ERROR';
  const errorDetail = `Unrecognised response shape: ${rawResult.slice(0, 200)}`;
  console.warn(`[toolResultInterpreter] UNKNOWN_ERROR for tool "${toolName}": ${errorDetail}`);
  const msg = buildClassifiedMessage(toolName, status, undefined, errorDetail, data);
  return { toolName, status, errorDetail, classifiedMessage: msg, rawData: data };
}

// ─── Balance gate (replaces silent preflight bypass) ──────────────────────────

export interface BalanceGateResult {
  allowed: boolean;
  classifiedResult: ClassifiedResult;
}

export function validateBalanceForTrade(
  rawBalanceResponse: string | null,
  requiredUsdc: number,
  minEth: number = 0.00005,
  toolName: string = 'open_trade',
): BalanceGateResult {
  // If fetch failed entirely
  if (rawBalanceResponse === null) {
    const msg = buildClassifiedMessage(
      toolName,
      'NETWORK_FAIL',
      undefined,
      'Balance service unreachable — cannot verify funds before executing trade.',
    );
    return {
      allowed: false,
      classifiedResult: {
        toolName,
        status: 'NETWORK_FAIL',
        errorDetail: 'Balance service unreachable',
        classifiedMessage: msg,
      },
    };
  }

  let bal: Record<string, any>;
  try {
    bal = JSON.parse(rawBalanceResponse);
  } catch {
    const msg = buildClassifiedMessage(toolName, 'PARSE_FAIL');
    return {
      allowed: false,
      classifiedResult: { toolName, status: 'PARSE_FAIL', classifiedMessage: msg },
    };
  }

  const usdcAvail = bal.usdc_balance ?? 0;
  const ethAvail  = bal.eth_balance  ?? 0;

  if (ethAvail < minEth) {
    const msg = buildClassifiedMessage(
      toolName,
      'LOW_GAS',
      undefined,
      `Agent wallet has ${ethAvail.toFixed(6)} ETH but needs at least ${minEth} ETH for gas on Base.`,
      { eth_balance: ethAvail, required_eth: minEth, agent_wallet: bal.agent_wallet },
    );
    return {
      allowed: false,
      classifiedResult: {
        toolName,
        status: 'LOW_GAS',
        errorDetail: `ETH balance ${ethAvail} < required ${minEth}`,
        classifiedMessage: msg,
        rawData: bal,
      },
    };
  }

  if (usdcAvail < requiredUsdc) {
    const deficit = (requiredUsdc - usdcAvail).toFixed(2);
    const msg = buildClassifiedMessage(
      toolName,
      'INSUFFICIENT_FUNDS',
      undefined,
      `Agent wallet has ${usdcAvail.toFixed(2)} USDC but trade collateral is ${requiredUsdc} USDC. Deficit: ${deficit} USDC.`,
      { usdc_balance: usdcAvail, required: requiredUsdc, deficit: parseFloat(deficit), agent_wallet: bal.agent_wallet },
    );
    return {
      allowed: false,
      classifiedResult: {
        toolName,
        status: 'INSUFFICIENT_FUNDS',
        errorDetail: `USDC balance ${usdcAvail} < required ${requiredUsdc}`,
        classifiedMessage: msg,
        rawData: bal,
      },
    };
  }

  // All checks passed
  const msg = [
    `[TOOL_RESULT_CLASSIFIED]`,
    `Tool: ${toolName} (balance gate)`,
    `Status: CONFIRMED`,
    `Balance verified: ${usdcAvail.toFixed(2)} USDC available (need ${requiredUsdc}), ${ethAvail.toFixed(6)} ETH available (need ${minEth}).`,
    `Proceed with trade execution.`,
    `[/TOOL_RESULT_CLASSIFIED]`,
  ].join('\n');

  return {
    allowed: true,
    classifiedResult: {
      toolName,
      status: 'CONFIRMED',
      classifiedMessage: msg,
      rawData: bal,
    },
  };
}

// ─── Post-response hallucination detector ─────────────────────────────────────

const SUCCESS_PHRASES = [
  'trade executed',
  'position opened',
  'trade is live',
  'order placed',
  'order confirmed',
  'trade confirmed',
  'successfully executed',
  'successfully opened',
  'withdrawal complete',
  'funds withdrawn',
  'successfully withdrawn',
  'order cancelled',
  'cancelled successfully',
  'limit order cancelled',
  'position closed',
  'successfully closed',
  'close confirmed',
];

const ANY_TX_HASH_REGEX = /0x[a-fA-F0-9]{40,}/g;

export function detectPostResponseHallucination(
  classifiedResults: ClassifiedResult[],
  responseText: string,
): string | null {
  const responseLower = responseText.toLowerCase();

  for (const result of classifiedResults) {
    if (result.status === 'CONFIRMED') continue; // legitimate success — skip

    // Check if Claude asserted success despite a non-CONFIRMED result
    const assertedSuccess = SUCCESS_PHRASES.some(phrase => responseLower.includes(phrase));

    // Check if Claude invented a tx_hash not present in any CONFIRMED result
    const confirmedHashes = classifiedResults
      .filter(r => r.status === 'CONFIRMED' && r.txHash)
      .map(r => r.txHash!.toLowerCase());

    const mentionedHashes = (responseText.match(ANY_TX_HASH_REGEX) || [])
      .filter(h => TX_HASH_REGEX.test(h));

    const fabricatedHash = mentionedHashes.some(h => !confirmedHashes.includes(h.toLowerCase()));

    if (assertedSuccess || fabricatedHash) {
      console.warn(
        `[toolResultInterpreter] POST-RESPONSE HALLUCINATION DETECTED for tool "${result.toolName}" (status=${result.status}). ` +
        `assertedSuccess=${assertedSuccess}, fabricatedHash=${fabricatedHash}`,
      );

      return buildHallucinationOverride(result);
    }
  }

  return null; // no hallucination detected
}

function buildHallucinationOverride(result: ClassifiedResult): string {
  switch (result.status) {
    case 'INSUFFICIENT_FUNDS':
      return `The ${result.toolName} could not execute — the agent wallet has insufficient USDC. ${result.errorDetail || ''} Please deposit the required amount to the agent wallet address and try again.`;

    case 'LOW_GAS':
      return `The ${result.toolName} could not execute — the agent wallet needs more ETH for gas on Base. Please send at least 0.00005 ETH to the agent wallet address and try again.`;

    case 'CONTRACT_REVERT':
      return `The ${result.toolName} failed — the transaction was reverted on-chain. No funds were moved. ${result.errorDetail || ''} Please check position limits or try again.`;

    case 'NETWORK_FAIL':
      return `The execution service is currently unreachable. No on-chain action was taken. Please try again in a moment.`;

    case 'SUSPICIOUS':
      return `The execution service returned an ambiguous response — no transaction hash was confirmed. Please check your wallet or Basescan before assuming the operation completed.`;

    case 'APPROVAL_REQUIRED':
      return `The ${result.toolName} could not execute — the agent wallet needs to approve USDC spending on Avantis first. ${result.errorDetail || ''}`;

    case 'SLIPPAGE_EXCEEDED':
      return `The ${result.toolName} failed — price moved beyond the slippage tolerance. No position was opened. You may retry with a limit order or wider slippage setting.`;

    case 'POSITION_NOT_FOUND':
      return `The ${result.toolName} could not find the specified position. It may have already been closed. Call get_avantis_live_positions to check current open positions.`;

    case 'ALREADY_CLOSED':
      return `The position or order targeted by ${result.toolName} is already closed or cancelled.`;

    default:
      return `The ${result.toolName} returned an error and could not complete. ${result.errorDetail || 'No transaction was confirmed.'} Please try again or contact support.`;
  }
}
