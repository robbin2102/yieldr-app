/**
 * Decodes Polymarket exchange contract calldata into Order structs.
 *
 * Handles fillOrder, fillOrders, matchOrders on both v1 (CTF/NEG_RISK)
 * and v2 (CTF_V2/NEG_RISK_V2) contracts — both use identical Order struct
 * and function signatures.
 *
 * Returns [] for any calldata that doesn't match a known function selector
 * or fails to decode (unknown function, malformed data, etc.).
 */

import { ethers } from 'ethers';

// Polymarket Order struct — identical across all 4 exchange contracts
const ORDER = '(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType)';

const IFACE = new ethers.utils.Interface([
  `function fillOrder(${ORDER} order, uint256 fillAmount)`,
  `function fillOrders(${ORDER}[] orders, uint256[] fillAmounts)`,
  `function matchOrders(${ORDER} makerOrder, ${ORDER}[] takerOrders, uint256 makerFillAmount, uint256[] takerFillAmounts)`,
]);

export interface DecodedOrder {
  maker:       string;            // lowercase address
  tokenId:     string;            // hex string
  makerAmount: ethers.BigNumber;  // what maker puts in (USDC if BUY, tokens if SELL)
  takerAmount: ethers.BigNumber;  // what maker expects out
  fillAmount:  ethers.BigNumber;  // portion of makerAmount being requested
  side:        number;            // 0 = BUY, 1 = SELL (from maker's perspective)
}

export function decodeCalldata(data: string): DecodedOrder[] {
  if (!data || data.length < 10) return [];
  try {
    const parsed = IFACE.parseTransaction({ data });

    if (parsed.name === 'fillOrder') {
      const o = parsed.args.order;
      return [{ maker: o.maker.toLowerCase(), tokenId: o.tokenId.toHexString(),
                makerAmount: o.makerAmount, takerAmount: o.takerAmount,
                fillAmount: parsed.args.fillAmount, side: o.side }];
    }

    if (parsed.name === 'fillOrders') {
      return (parsed.args.orders as any[]).map((o, i) => ({
        maker: o.maker.toLowerCase(), tokenId: o.tokenId.toHexString(),
        makerAmount: o.makerAmount,   takerAmount: o.takerAmount,
        fillAmount: parsed.args.fillAmounts[i], side: o.side,
      }));
    }

    if (parsed.name === 'matchOrders') {
      const results: DecodedOrder[] = [];
      const mo = parsed.args.makerOrder;
      results.push({ maker: mo.maker.toLowerCase(), tokenId: mo.tokenId.toHexString(),
                     makerAmount: mo.makerAmount, takerAmount: mo.takerAmount,
                     fillAmount: parsed.args.makerFillAmount, side: mo.side });
      (parsed.args.takerOrders as any[]).forEach((o, i) =>
        results.push({ maker: o.maker.toLowerCase(), tokenId: o.tokenId.toHexString(),
                       makerAmount: o.makerAmount, takerAmount: o.takerAmount,
                       fillAmount: parsed.args.takerFillAmounts[i], side: o.side }));
      return results;
    }
  } catch { /* unknown selector or malformed calldata — skip silently */ }
  return [];
}
