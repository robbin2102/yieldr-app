/**
 * Avantis Contract Addresses on Base Mainnet
 */

export const CONTRACTS = {
  // Trading contract - emits MarketOrderInitiated
  TRADING: '0x44914408af82bC9983bbb330e3578E1105e11d4e' as `0x${string}`,

  // Events contract - emits MarketExecuted
  EVENTS: '0x0c16ff40065cc3ab4bc55b60e447504afb9c7970' as `0x${string}`,

  // USDC token on Base
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
} as const;

export const BASE_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
