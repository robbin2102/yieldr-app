"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClobClient = createClobClient;
const ethers_1 = require("ethers");
const clob_client_1 = require("@polymarket/clob-client");
const config_1 = require("../config");
/**
 * Create and initialize Polymarket CLOB client
 *
 * The CLOB (Central Limit Order Book) client handles:
 * - Order creation and signing
 * - Order submission to Polymarket
 * - Authentication with API credentials
 *
 * @returns Initialized ClobClient instance
 */
async function createClobClient() {
    console.log('[CLOB] Initializing client...');
    // Create wallet from private key
    const wallet = new ethers_1.ethers.Wallet(config_1.config.botPrivateKey);
    console.log(`[CLOB] Wallet address: ${wallet.address}`);
    // Initialize CLOB client with credentials
    const client = new clob_client_1.ClobClient(config_1.config.clobApiBase, config_1.config.chainId, wallet, {
        key: config_1.config.apiKey,
        secret: config_1.config.apiSecret,
        passphrase: config_1.config.passphrase,
    });
    console.log('[CLOB] ✅ Client ready');
    return client;
}
//# sourceMappingURL=client.js.map