"""
Known CEX (Centralized Exchange) wallet addresses on Base chain.

Used to filter out non-retail wallets from trader discovery.
Sources: Arkham Intel, Etherscan labels, Dune dashboards

Last updated: 2025-12-25
"""

# Known CEX hot/cold wallets
CEX_WALLETS = {
    # Binance
    "0xf977814e90da44bfa03b6295a0616a897441acec": "binance",
    "0x28c6c06298d514db089934071355e5743bf21d60": "binance",
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "binance",
    "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8": "binance",
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "binance",
    "0x5a52e96bacdabb82fd05763e25335261b270efcb": "binance",
    "0x835678a611b28684005a5e2233695fb6cbbb0007": "binance",
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": "binance",
    "0xe2fc31f816a9b94326492132018c3aecc4a93ae1": "binance",
    "0x3c783c21a0383057d128bae431894a5c19f9cf06": "binance",
    "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "binance",

    # Coinbase
    "0x5041ed759dd4afc3a72b8192c143f72f4724081a": "coinbase",
    "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "coinbase",
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "coinbase",
    "0x503828976d22510aad0201ac7ec88293211d23da": "coinbase",
    "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": "coinbase",
    "0x3cd751e6b0078be393132286c442345e5dc49699": "coinbase",
    "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "coinbase",
    "0xeb2629a2734e272bcc07bda959863f316f4bd4cf": "coinbase",
    "0xa090e606e30bd747d4e6245a1517ebe430f0057e": "coinbase",
    "0x02466e547bfdab679fc49e96bbfc62b9747d997c": "coinbase",

    # Bybit
    "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "bybit",
    "0x1db92e2eebc8e0c075a02bea49a2935bcd2dfcf4": "bybit",
    "0xa7d977e5e81e94be0e3a75e4ce1a74dfb1b46e21": "bybit",

    # Kraken
    "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": "kraken",
    "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13": "kraken",
    "0xe853c56864a2ebe4576a807d26fdc4a0ada51919": "kraken",
    "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "kraken",
    "0xfa52274dd61e1643d2205169732f29114bc240b3": "kraken",

    # OKX
    "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "okx",
    "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": "okx",
    "0xa7efae728d2936e78bda97dc267687568dd593f3": "okx",
    "0x5c52cc7c96bde8594e5b77d5b76d042cb5fae5f2": "okx",

    # KuCoin
    "0xd6216fc19db775df9774a6e33526131da7d19a2c": "kucoin",
    "0xf16e9b0d03470827a95cdfd0cb8a8a3b46969b91": "kucoin",
    "0x88ff79eb2bc5850f27315415da8685282c7610f9": "kucoin",

    # Gate.io
    "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "gate",
    "0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c": "gate",

    # Huobi/HTX
    "0xab5c66752a9e8167967685f1450532fb96d5d24f": "htx",
    "0x6748f50f686bfbca6fe8ad62b22228b87f31ff2b": "htx",
    "0xfdb16996831753d5331ff813c29a93c76834a0ad": "htx",

    # Bitfinex
    "0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec": "bitfinex",
    "0x876eabf441b2ee5b5b0554fd502a8e0600950cfa": "bitfinex",

    # Gemini
    "0xd24400ae8bfebb18ca49be86258a3c749cf46853": "gemini",
    "0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8": "gemini",

    # Crypto.com
    "0x6262998ced04146fa42253a5c0af90ca02dfd2a3": "crypto.com",
    "0x46340b20830761efd32832a74d7169b29feb9758": "crypto.com",

    # Robinhood
    "0x40b38765696e3d5d8d9d834d8aad4bb6e418e489": "robinhood",
}


def is_cex_wallet(wallet_address: str) -> tuple[bool, str | None]:
    """
    Check if a wallet is a known CEX wallet.

    Args:
        wallet_address: Ethereum wallet address

    Returns:
        Tuple of (is_cex, exchange_name)
    """
    wallet_lower = wallet_address.lower()
    if wallet_lower in CEX_WALLETS:
        return (True, CEX_WALLETS[wallet_lower])
    return (False, None)
