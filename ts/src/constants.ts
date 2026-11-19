/**
 * Shared constants for the Polypad agent API.
 *
 * Every value here is copied from the live server code
 * (lib/agents-api/v2/config.ts, lib/x402/constants.ts) or the published
 * plan appendix — nothing is invented. If the server changes a number,
 * this file is the one place to update.
 *
 * One exception to note: the signing path in the client (prepare →
 * sign → broadcast, and the examples) defaults to the DRPC endpoint
 * (`DEFAULT_RPC_URL` in client.ts). The RPC URL here is the server's
 * own default, used for read-only lookups (Permit2 nonces, SpendVault
 * reads). Both point at Robinhood Chain (4663).
 */

/** The MCP endpoint. POST-only, JSON-RPC 2.0, no login, no API key. */
export const MCP_ENDPOINT = 'https://polypad.family/api/mcp';
export const SITE_ORIGIN = 'https://polypad.family';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const CHAIN_ID = 4663;
export const CHAIN_NAME = 'Robinhood Chain';
export const SERVER_VERSION = '2.0.0';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Published rate limits (per client IP, per minute). */
export const RATE_LIMITS = {
  /** Plain reads: 120 calls a minute. */
  readPerMinute: 120,
  /** Prepared actions: 30 calls a minute. */
  preparePerMinute: 30,
  /** Prepared actions for one wallet: 12 calls a minute. */
  perWalletPreparePerMinute: 12,
  /** polypad_intent: 40 calls a minute. */
  intentPerMinute: 40,
  /** Largest request body the server accepts. */
  maxBodyBytes: 16_384,
  /** Largest JSON-RPC batch. */
  maxBatch: 10,
} as const;

/** Guardrails on prepared actions. */
export const ACTION_LIMITS = {
  /** One prepared action can move at most 25 ETH. */
  maxActionEth: 25,
  /** Above 1 ETH, the call needs `confirmLarge: true`. */
  confirmLargeAboveEth: 1,
  /** Default slippage limit, in basis points (100 = 1%). */
  defaultSlippageBps: 100,
  /** Largest slippage limit, in basis points (1000 = 10%). */
  maxSlippageBps: 1000,
  /** How long a prepared action stays valid to sign, in seconds (20 minutes). */
  signingExpiresInSeconds: 1200,
} as const;

/** x402 pay-per-call: the three priced reads, in US dollars. */
export const X402_PRODUCTS = [
  {
    id: 'token-report',
    name: 'Token report',
    priceUsd: 0.01,
    endpoint: '/api/x402/products/token-report',
    queryParam: 'address',
    delivers:
      'Price, market cap, volume, supply, bonding-curve progress, graduation state, creator, and launch details — read straight from Robinhood Chain.',
  },
  {
    id: 'fund-nav',
    name: 'Tokenized Fund NAV snapshot',
    priceUsd: 0.01,
    endpoint: '/api/x402/products/fund-nav',
    queryParam: 'fund',
    delivers:
      'Net asset value per share and total NAV, shares sold, amount raised, strategy, and the manager — read straight from the chain.',
  },
  {
    id: 'cto-report',
    name: 'CTO report',
    priceUsd: 0.05,
    endpoint: '/api/x402/products/cto-report',
    queryParam: 'launch',
    delivers:
      'Summary, risk, utility, momentum, holder distribution, narrative, sentiment, and conclusion — the same report the token page shows.',
  },
] as const;

export type X402ProductId = (typeof X402_PRODUCTS)[number]['id'];

export function x402Product(id: string) {
  return X402_PRODUCTS.find((p) => p.id === id) ?? null;
}

/** x402 payment facts (chain 4663). */
export const X402 = {
  version: 2,
  network: 'eip155:4663',
  chainId: 4663,
  /** How long a payment approval stays valid, in seconds. */
  maxTimeoutSeconds: 120,
  /** Where paid-call revenue settles — the Polypad fee wallet. */
  payTo: '0x9a21c75aC263cC43125E70200636f6397f8776d0',
  usdg: {
    address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    decimals: 6,
    symbol: 'USDG',
    method: 'eip3009',
    eip712: { name: 'Global Dollar', version: '1' },
  },
  polydash: {
    address: '0x319525528f42167eF7fC18b77b889958080568e4',
    decimals: 18,
    symbol: 'POLYDASH',
    method: 'permit2',
    eip712: { name: 'Polydash', version: '1' },
  },
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
} as const;

/** The SpendVault: where an agent's spending money lives. */
export const SPEND_VAULT_ADDRESS = '0xDb5544a977b0dF881268746F2C47F049da579486';

export const VAULT_TOKENS = [
  { key: 'USDG', address: X402.usdg.address, decimals: 6 },
  { key: 'POLYDASH', address: X402.polydash.address, decimals: 18 },
] as const;

/** Plain-language error meanings, copied from the server's tool reference. */
export const ERROR_MEANINGS: Record<string, string> = {
  amount_too_large: 'One action is above the 25 ETH cap. Split it into smaller actions.',
  confirm_large_required:
    'The amount is above 1 ETH. Confirm it with the user first, then resend with "confirmLarge": true.',
  invalid_json: 'The request body was not valid JSON, or was not a JSON object.',
  invalid_params:
    'A field was missing, the wrong type, or out of range (bad address, bad number, bad hash). The error names the field.',
  key_material_rejected:
    'The request contained a private key or seed phrase. Never send one — Polypad never needs it. Nothing was processed.',
  not_found: 'No token, tokenized fund, collection, listing, or endpoint matched.',
  tx_not_found: 'No transaction with that hash on Robinhood Chain yet — it may not have been sent.',
  unknown_template: 'No Strategy with that id. List the strategies first.',
  method_not_allowed: 'Wrong HTTP method for the endpoint (GET vs POST).',
  ambiguous_collection: 'More than one collection matches. Use the collection address.',
  ambiguous_fund: 'More than one tokenized fund matches. Use the fund address.',
  ambiguous_token: 'More than one token matches. Use the token address.',
  amount_exceeds_curve: 'More tokens than the bonding curve can buy back right now. Try a smaller amount.',
  choose_template: 'More than one Strategy fits the assets. Ask the user which one.',
  commit_window_open: 'The collection is still in its commitment window. Commit from the collection page.',
  insufficient_balance: 'The wallet holds less than the amount requested.',
  listing_not_valid: 'The listing is sold, cancelled, expired, or no longer backed by the seller.',
  no_shares: 'The wallet holds no shares of that tokenized fund.',
  not_holder: 'The wallet does not hold the share(s) being redeemed.',
  not_tradable: 'The token is in a phase that cannot be traded right now.',
  own_listing: 'This wallet is the seller of that listing.',
  raise_closed: 'The tokenized fund is not open for minting.',
  raise_open: 'The tokenized fund is still raising. Exit opens after the raise closes; a refund opens only if the raise fails.',
  skin_required: 'Only the fund manager can mint until the required manager shares are minted.',
  sold_out: 'Sold out (NFT collection, or no shares left).',
  unsupported_fund: 'Exits from this fund type are not prepared by the API yet. Open the fund page.',
  wallet_cap: 'The collection’s per-wallet mint limit is reached.',
  payload_too_large: 'Request body over 16 KB.',
  no_matching_template: 'No Strategy can hold the requested assets.',
  quote_failed: 'The pool could not quote that amount. Try a smaller amount.',
  simulation_reverted: 'The on-chain simulation reverted — the transaction as built would fail. Nothing was sent.',
  rate_limited: 'Too many requests from this IP. Wait a minute; the reply says how long (retry-after).',
  rate_limited_wallet: 'Too many prepared actions for this wallet. Wait a minute.',
  internal_error: 'Unexpected error. Nothing was signed or sent.',
  unsupported_collection_type: 'Buys from bonding-curve collections are not prepared by the API yet. Open the collection page.',
  rpc_unavailable: 'The chain data source could not be reached. Retry shortly.',
};
