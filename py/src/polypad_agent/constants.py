"""Shared constants for the Polypad agent API.

Every value here is copied from the live server code
(lib/agents-api/v2/config.ts, lib/x402/constants.ts) or the published
plan appendix — nothing is invented. If the server changes a number,
this file is the one place to update.
"""

MCP_ENDPOINT = "https://polypad.family/api/mcp"
SITE_ORIGIN = "https://polypad.family"
EXPLORER = "https://robinhoodchain.blockscout.com"
CHAIN_ID = 4663
CHAIN_NAME = "Robinhood Chain"
SERVER_VERSION = "2.0.0"
MCP_PROTOCOL_VERSION = "2025-06-18"

# Published rate limits (per client IP, per minute).
RATE_LIMITS = {
    "read_per_minute": 120,
    "prepare_per_minute": 30,
    "per_wallet_prepare_per_minute": 12,
    "intent_per_minute": 40,
    "max_body_bytes": 16384,
    "max_batch": 10,
}

# Guardrails on prepared actions.
ACTION_LIMITS = {
    "max_action_eth": 25,  # One prepared action can move at most 25 ETH.
    "confirm_large_above_eth": 1,  # Above 1 ETH, the call needs confirmLarge=True.
    "default_slippage_bps": 100,
    "max_slippage_bps": 1000,
    "signing_expires_in_seconds": 1200,  # A prepared action stays valid to sign for 20 minutes.
}

# x402 pay-per-call: the three priced reads, in US dollars.
X402_PRODUCTS = [
    {
        "id": "token-report",
        "name": "Token report",
        "price_usd": 0.01,
        "endpoint": "/api/x402/products/token-report",
        "query_param": "address",
        "delivers": "Price, market cap, volume, supply, bonding-curve progress, graduation state, creator, and launch details — read straight from Robinhood Chain.",
    },
    {
        "id": "fund-nav",
        "name": "Tokenized Fund NAV snapshot",
        "price_usd": 0.01,
        "endpoint": "/api/x402/products/fund-nav",
        "query_param": "fund",
        "delivers": "Net asset value per share and total NAV, shares sold, amount raised, strategy, and the manager — read straight from the chain.",
    },
    {
        "id": "cto-report",
        "name": "CTO report",
        "price_usd": 0.05,
        "endpoint": "/api/x402/products/cto-report",
        "query_param": "launch",
        "delivers": "Summary, risk, utility, momentum, holder distribution, narrative, sentiment, and conclusion — the same report the token page shows.",
    },
]


def x402_product(product_id):
    for product in X402_PRODUCTS:
        if product["id"] == product_id:
            return product
    return None


# x402 payment facts (chain 4663).
X402 = {
    "version": 2,
    "network": "eip155:4663",
    "chain_id": 4663,
    "max_timeout_seconds": 120,  # How long a payment approval stays valid.
    "pay_to": "0x9a21c75aC263cC43125E70200636f6397f8776d0",  # Where paid-call revenue settles.
    "usdg": {
        "address": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        "decimals": 6,
        "symbol": "USDG",
        "method": "eip3009",
        "eip712": {"name": "Global Dollar", "version": "1"},
    },
    "polydash": {
        "address": "0x319525528f42167eF7fC18b77b889958080568e4",
        "decimals": 18,
        "symbol": "POLYDASH",
        "method": "permit2",
        "eip712": {"name": "Polydash", "version": "1"},
    },
    "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "permit2_proxy": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
    "rpc_url": "https://rpc.mainnet.chain.robinhood.com",
}

# The SpendVault: where an agent's spending money lives.
SPEND_VAULT_ADDRESS = "0xDb5544a977b0dF881268746F2C47F049da579486"

VAULT_TOKENS = [
    {"key": "USDG", "address": X402["usdg"]["address"], "decimals": 6},
    {"key": "POLYDASH", "address": X402["polydash"]["address"], "decimals": 18},
]

# Plain-language error meanings, copied from the server's tool reference.
ERROR_MEANINGS = {
    "amount_too_large": "One action is above the 25 ETH cap. Split it into smaller actions.",
    "confirm_large_required": 'The amount is above 1 ETH. Confirm it with the user first, then resend with "confirmLarge": true.',
    "invalid_json": "The request body was not valid JSON, or was not a JSON object.",
    "invalid_params": "A field was missing, the wrong type, or out of range (bad address, bad number, bad hash). The error names the field.",
    "key_material_rejected": "The request contained a private key or seed phrase. Never send one — Polypad never needs it. Nothing was processed.",
    "not_found": "No token, tokenized fund, collection, listing, or endpoint matched.",
    "tx_not_found": "No transaction with that hash on Robinhood Chain yet — it may not have been sent.",
    "unknown_template": "No Strategy with that id. List the strategies first.",
    "method_not_allowed": "Wrong HTTP method for the endpoint (GET vs POST).",
    "ambiguous_collection": "More than one collection matches. Use the collection address.",
    "ambiguous_fund": "More than one tokenized fund matches. Use the fund address.",
    "ambiguous_token": "More than one token matches. Use the token address.",
    "amount_exceeds_curve": "More tokens than the bonding curve can buy back right now. Try a smaller amount.",
    "choose_template": "More than one Strategy fits the assets. Ask the user which one.",
    "commit_window_open": "The collection is still in its commitment window. Commit from the collection page.",
    "insufficient_balance": "The wallet holds less than the amount requested.",
    "listing_not_valid": "The listing is sold, cancelled, expired, or no longer backed by the seller.",
    "no_shares": "The wallet holds no shares of that tokenized fund.",
    "not_holder": "The wallet does not hold the share(s) being redeemed.",
    "not_tradable": "The token is in a phase that cannot be traded right now.",
    "own_listing": "This wallet is the seller of that listing.",
    "raise_closed": "The tokenized fund is not open for minting.",
    "raise_open": "The tokenized fund is still raising. Exit opens after the raise closes; a refund opens only if the raise fails.",
    "skin_required": "Only the fund manager can mint until the required manager shares are minted.",
    "sold_out": "Sold out (NFT collection, or no shares left).",
    "unsupported_fund": "Exits from this fund type are not prepared by the API yet. Open the fund page.",
    "wallet_cap": "The collection’s per-wallet mint limit is reached.",
    "payload_too_large": "Request body over 16 KB.",
    "no_matching_template": "No Strategy can hold the requested assets.",
    "quote_failed": "The pool could not quote that amount. Try a smaller amount.",
    "simulation_reverted": "The on-chain simulation reverted — the transaction as built would fail. Nothing was sent.",
    "rate_limited": "Too many requests from this IP. Wait a minute; the reply says how long (retry-after).",
    "rate_limited_wallet": "Too many prepared actions for this wallet. Wait a minute.",
    "internal_error": "Unexpected error. Nothing was signed or sent.",
    "unsupported_collection_type": "Buys from bonding-curve collections are not prepared by the API yet. Open the collection page.",
    "rpc_unavailable": "The chain data source could not be reached. Retry shortly.",
}
