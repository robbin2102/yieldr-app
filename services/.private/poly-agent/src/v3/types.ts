export interface PendingTrade {
  txHash:       string;
  wallet:       string;   // maker address (lowercase)
  label:        string;
  side:         'BUY' | 'SELL';
  tokenId:      string;   // hex
  usdcAmount:   number;   // estimated from fillAmount (6-decimal adjusted)
  tokenAmount:  number;
  impliedPrice: number;
  gasGwei:      number;
  confidence:   'HIGH' | 'MEDIUM' | 'LOW';
  detectedAtMs: number;
  exchange:     'CTF' | 'NEG_RISK' | 'CTF_V2' | 'NEG_RISK_V2';
}

export interface MatchedTrade {
  pending:      PendingTrade;
  confirmedAtMs: number;
  advanceMs:    number;  // confirmedAtMs - pending.detectedAtMs (positive = pending was earlier)
}
