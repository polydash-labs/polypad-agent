/**
 * Typed arguments for the 21 `polypad_*` tools.
 *
 * Field names match the server exactly (the wire format does not change),
 * including `templateId` — which the site calls a Strategy id. Amounts in
 * wei are decimal strings; amounts in ETH are plain decimals like "0.01".
 * Nothing here is a private key: `from` is always a wallet *address*.
 * On prepare calls `from` is optional when a wallet token is bound — the
 * client passes `walletToken` instead and the server resolves the wallet.
 */

export type Address = `0x${string}`;

/** Read tools — they only read on-chain data and never move funds. */
export interface ReadArgs {
  polypad_what_can_i_do: Record<string, never>;
  polypad_intent: { text: string; from?: string; walletToken?: string; ref?: string };
  polypad_list_tokens: {
    sort?: 'trending' | 'new' | 'graduating' | 'volume' | 'graduated';
    q?: string;
    phase?: 'commit_window' | 'trading' | 'graduated';
    agentLaunched?: boolean;
    limit?: number;
  };
  polypad_get_token: { token: string };
  polypad_token_protections: { token: string };
  polypad_quote_trade: {
    token: string;
    side: 'buy' | 'sell';
    amount?: string;
    amountEth?: string;
    slippageBps?: number;
  };
  polypad_list_nfts: {
    q?: string;
    status?: 'commit_window' | 'public_mint' | 'sold_out';
    sort?: 'newest' | 'minted' | 'price';
    limit?: number;
  };
  polypad_list_nft_listings: { collection?: string; maxPriceEth?: string; maxPriceWei?: string; limit?: number };
  polypad_list_fund_templates: Record<string, never>;
  polypad_list_funds: {
    open?: boolean;
    status?: 'raising' | 'raise_closed' | 'investing' | 'failed';
    templateId?: number;
    asset?: string;
    manager?: string;
    factory?: 'phase6' | 'phase3' | 'phase2' | 'phase1a';
    q?: string;
    sort?: 'newest' | 'raise_progress' | 'deadline' | 'shares';
    limit?: number;
  };
  polypad_get_fund: { fund: string };
  polypad_portfolio: { address: string };
  polypad_get_tx_status: { hash: string };
  polypad_stats: Record<string, never>;
}

/** Prepare tools — they return an unsigned transaction, never sign it. */
export interface PrepareArgs {
  polypad_prepare_buy: {
    token: string;
    from?: string;
    walletToken?: string;
    amountEth?: string;
    amountWei?: string;
    slippageBps?: number;
    confirmLarge?: boolean;
    ref?: string;
    returnUrl?: string;
  };
  polypad_prepare_sell: {
    token: string;
    from?: string;
    walletToken?: string;
    amount?: string;
    percentOfBalance?: number;
    slippageBps?: number;
    ref?: string;
    returnUrl?: string;
  };
  polypad_prepare_nft_buy: {
    from?: string;
    walletToken?: string;
    listingId?: number;
    collection?: string;
    collectionName?: string;
    quantity?: number;
    confirmLarge?: boolean;
    ref?: string;
    returnUrl?: string;
  };
  polypad_prepare_fund_create: {
    from?: string;
    walletToken?: string;
    /** Strategy id from `listFundTemplates`. Omit to match by `assets` instead. */
    templateId?: number;
    /** Asset symbols the Tokenized Fund should hold, used to match a Strategy. */
    assets?: string[];
    name: string;
    symbol: string;
    mintPriceEth?: string;
    mintPriceWei?: string;
    raiseCapEth?: string;
    raiseCapWei?: string;
    entryFeeBps?: number;
    raiseDurationDays?: number;
    minSkinBps?: number;
    imageUri?: string;
    factory?: 'phase6' | 'phase3';
    ref?: string;
    returnUrl?: string;
  };
  polypad_prepare_fund_mint: {
    from?: string;
    walletToken?: string;
    fund: string;
    quantity?: number;
    confirmLarge?: boolean;
    ref?: string;
    returnUrl?: string;
  };
  polypad_prepare_fund_redeem: {
    from?: string;
    walletToken?: string;
    fund: string;
    quantity?: number;
    ids?: string[];
    ref?: string;
    returnUrl?: string;
  };
  polypad_prepare_token_launch: {
    from?: string;
    walletToken?: string;
    name: string;
    symbol: string;
    imageUri?: string;
    description?: string;
    socialLinks?: string[];
    /** Creator fee in basis points, 0 to 500. Required. 0 means 0%. */
    creatorFeeBps: number;
    devBuyEth?: string;
    launchDelay?: string;
    agentMark?: boolean;
    repository?: string;
    ref?: string;
    returnUrl?: string;
  };
}

export type ToolArgs = ReadArgs & PrepareArgs;
export type ToolName = keyof ToolArgs;

/** The 21 tools, in the order the server lists them. */
export const TOOL_NAMES: ToolName[] = [
  'polypad_what_can_i_do',
  'polypad_intent',
  'polypad_list_tokens',
  'polypad_get_token',
  'polypad_token_protections',
  'polypad_quote_trade',
  'polypad_prepare_buy',
  'polypad_prepare_sell',
  'polypad_list_nfts',
  'polypad_list_nft_listings',
  'polypad_prepare_nft_buy',
  'polypad_list_fund_templates',
  'polypad_list_funds',
  'polypad_get_fund',
  'polypad_prepare_fund_create',
  'polypad_prepare_fund_mint',
  'polypad_prepare_fund_redeem',
  'polypad_prepare_token_launch',
  'polypad_portfolio',
  'polypad_get_tx_status',
  'polypad_stats',
];

export const PREPARE_TOOLS: (keyof PrepareArgs)[] = [
  'polypad_prepare_buy',
  'polypad_prepare_sell',
  'polypad_prepare_nft_buy',
  'polypad_prepare_fund_create',
  'polypad_prepare_fund_mint',
  'polypad_prepare_fund_redeem',
  'polypad_prepare_token_launch',
];

export function isPrepareTool(name: string): name is keyof PrepareArgs {
  return (PREPARE_TOOLS as string[]).includes(name);
}

/** One step of a prepared action: an unsigned transaction. */
export interface UnsignedStep {
  step: number;
  kind: string;
  description: string;
  chainId: number;
  from: string;
  to: string;
  data: `0x${string}`;
  /** ETH value in wei, as a decimal string. */
  value: string;
  valueHex: `0x${string}`;
  gas: string | null;
  simulated: boolean;
}

/** The plain-language summary that comes with every prepared action. */
export interface PreparedSummary {
  headline: string;
  lines: string[];
  youPay?: string;
  youReceiveAtLeast?: string;
  fees?: Record<string, unknown>;
  slippageBps?: number;
  risks: string[];
  notAudited?: string;
}

/** What a `prepare_*` tool returns. Show the summary before the signing link. */
export interface PreparedAction {
  ok: true;
  api?: string;
  action: string;
  chainId: number;
  custody?: 'non-custodial';
  summary: PreparedSummary;
  transactions: UnsignedStep[];
  simulation?: { success: boolean | null; gas?: string | null; note?: string };
  signing: {
    /** One-tap link to the /sign page. It carries the intent, never calldata. */
    url: string;
    checksum: string;
    instructions?: string;
    /** Optional https:// link back to your agent flow, shown after confirmation. */
    returnUrl?: string | null;
    /** Seconds the prepared action stays valid to sign (1200 = 20 minutes). */
    expiresInSeconds: number;
  };
  attribution?: { ref: string; codes: string[]; standard: string } | null;
  warnings: string[];
  [k: string]: unknown;
}

/** What `polypad_get_tx_status` returns. */
export interface TxStatus {
  ok: true;
  chainId?: number;
  hash: string;
  status: 'pending' | 'confirmed' | 'failed';
  block?: string;
  confirmations?: string;
  from?: string;
  to?: string;
  gasUsed?: string;
  events?: string[];
  result?: string;
  newToken?: string;
  newFund?: string;
  next?: string;
  attribution?: { ref: string | null; codes: string[]; viaPolypadAgentApi: boolean } | null;
  explorer?: string;
  [k: string]: unknown;
}
