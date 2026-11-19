/**
 * polypad-agent — thin typed client for the Polypad agent API (MCP) on Robinhood Chain.
 *
 * The client talks JSON-RPC to https://polypad.family/api/mcp. Reads only fetch data. Prepare
 * calls return an unsigned transaction, a plain summary, and a signing link — nothing moves until
 * somebody signs.
 *
 * Wallet binding (persistent): connect once on /sign?connect=1, store the token, and pass it here.
 * The client attaches it to every prepare call instead of a wallet address; the server resolves the
 * wallet from the token. Per-call `from` still works as the fallback — pass it explicitly and the
 * client leaves the token out for that call.
 */
import { createPublicClient, createWalletClient, http, type Account, type Hex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { connectUrl, decodeWalletToken } from './binding.js';
import { PolypadError, isApiErrorBody, polypadErrorFromBody } from './errors.js';
import { isPrepareTool, type PreparedAction, type ToolName, type TxStatus, type UnsignedStep } from './tools.js';

export const MCP_URL = 'https://polypad.family/api/mcp';
export const SITE_ORIGIN = 'https://polypad.family';
export const CHAIN_ID = 4663;
export const DEFAULT_RPC_URL = 'https://robinhood.drpc.org';

export { connectUrl, decodeWalletToken };
export { PolypadError, PolypadConfirmTimeoutError, PolypadTxFailedError } from './errors.js';
export type { PreparedAction, TxStatus, UnsignedStep, ToolName } from './tools.js';
/** One step of a prepared action — the name the first version of this SDK used. */
export type PreparedTransaction = UnsignedStep;

const TOKEN_TOOLS = new Set<string>([
  'polypad_prepare_buy',
  'polypad_prepare_sell',
  'polypad_prepare_nft_buy',
  'polypad_prepare_fund_create',
  'polypad_prepare_fund_mint',
  'polypad_prepare_fund_redeem',
  'polypad_prepare_token_launch',
  'polypad_intent',
]);

const ROBINHOOD_CHAIN = {
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
} as const;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const KEY_LOOKALIKE = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The server refuses anything that looks like key material. Check first, so nothing sensitive is ever sent. */
function rejectKeyMaterial(args: unknown): void {
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && KEY_LOOKALIKE.test(v.trim())) {
      throw new PolypadError(
        'Do not send private keys or seed phrases. Polypad never needs them. Nothing was sent.',
        'key_material_rejected',
      );
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(args);
}

export type PolypadClientOptions = {
  /** MCP endpoint. Default https://polypad.family/api/mcp. */
  mcpUrl?: string;
  /** Wallet token from /sign?connect=1. Default: POLYPAD_WALLET_TOKEN. */
  walletToken?: string;
  /** Name sent as x-polypad-client. Default "polypad-agent". */
  clientName?: string;
  /** Attribution tag added to prepare calls when the call does not set `ref`. */
  ref?: string;
  /** Per-request timeout in milliseconds. Default 30,000. */
  timeoutMs?: number;
  fetch?: FetchFn;
};

type JsonRpcReply = {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export class PolypadClient {
  readonly mcpUrl: string;
  private walletToken: string | null;
  private readonly clientName: string;
  private readonly defaultRef?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private id = 0;

  constructor(options: PolypadClientOptions = {}) {
    this.mcpUrl = options.mcpUrl ?? MCP_URL;
    const envToken = typeof process !== 'undefined' ? process.env?.POLYPAD_WALLET_TOKEN : undefined;
    this.walletToken = options.walletToken ?? envToken ?? null;
    this.clientName = options.clientName ?? 'polypad-agent';
    this.defaultRef = options.ref;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** Store a wallet token (from /sign?connect=1). Later prepare calls resolve the wallet from it. */
  setWalletToken(token: string | null): void {
    this.walletToken = token && token !== '' ? token : null;
  }

  /** The wallet bound by the stored token, or null when no token is set. */
  walletAddress(): string | null {
    if (!this.walletToken) return null;
    return decodeWalletToken(this.walletToken)?.address ?? null;
  }

  /** The connect URL to show the user so they can bind a wallet and get a token. */
  connectUrl(options: { returnUrl?: string } = {}): string {
    return connectUrl({ origin: SITE_ORIGIN, returnUrl: options.returnUrl });
  }

  /** Low-level JSON-RPC call. Returns the `result` object, or throws PolypadError. */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const requestId = ++this.id;
    let res: Response;
    try {
      res = await this.fetchFn(this.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-polypad-client': this.clientName },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PolypadError(`Could not reach ${this.mcpUrl}: ${(e as Error).message ?? 'network error'}. Check your connection and try again.`, 'network_error');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PolypadError(`The Polypad API answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : '.'}`, 'http_error', res.status);
    }
    let reply: JsonRpcReply;
    try {
      reply = (await res.json()) as JsonRpcReply;
    } catch {
      throw new PolypadError('The Polypad API answered with something that was not JSON.', 'invalid_response');
    }
    if (reply.error) {
      throw new PolypadError(reply.error.message, `rpc_${reply.error.code}`, undefined, {
        jsonRpcCode: reply.error.code,
        ...(reply.error.data as Record<string, unknown> | undefined),
      });
    }
    return (reply.result ?? {}) as Record<string, unknown>;
  }

  /** The MCP handshake. Optional — the server is stateless and answers tools/call without it. */
  async initialize() {
    const result = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.clientName, version: '2.0.0' },
    });
    return result as { protocolVersion: string; serverInfo: { name: string; version: string }; instructions?: string };
  }

  async ping(): Promise<boolean> {
    await this.rpc('ping');
    return true;
  }

  /** The 21 tools, with names, descriptions, and input schemas, straight from the server. */
  async listTools() {
    const result = await this.rpc('tools/list');
    return (result.tools ?? []) as {
      name: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }[];
  }

  /** One MCP tools/call. Throws PolypadError when the tool answers with an error. */
  async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const finalArgs: Record<string, unknown> = { ...args };
    if (this.defaultRef && finalArgs.ref === undefined && (isPrepareTool(name) || name === 'polypad_intent')) {
      finalArgs.ref = this.defaultRef;
    }
    if (TOKEN_TOOLS.has(name)) {
      if (this.walletToken && !finalArgs.walletToken && !finalArgs.from) {
        finalArgs.walletToken = this.walletToken;
      }
      rejectKeyMaterial(finalArgs);
      const from = finalArgs.from;
      if (typeof from === 'string' && !ADDRESS_RE.test(from.trim())) {
        throw new PolypadError('`from` must be a 0x wallet address.', 'invalid_params', undefined, { field: 'from' });
      }
    }
    const result = await this.rpc('tools/call', { name, arguments: finalArgs });
    if (result.isError) {
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      if (isApiErrorBody(structured)) throw polypadErrorFromBody(structured);
      const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? '';
      try {
        const parsed = JSON.parse(text) as unknown;
        if (isApiErrorBody(parsed)) throw polypadErrorFromBody(parsed);
      } catch (e) {
        if (e instanceof PolypadError) throw e;
      }
      throw new PolypadError(text.slice(0, 400) || `The ${name} tool reported an error.`, 'tool_error');
    }
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    let out: unknown = structured !== undefined ? structured : null;
    if (out === null) {
      const text = (result.content as { text?: string }[] | undefined)?.[0]?.text;
      if (typeof text === 'string') {
        try {
          out = JSON.parse(text) as unknown;
        } catch {
          out = null;
        }
      }
    }
    if (!out || typeof out !== 'object') throw new PolypadError('MCP endpoint answered with no result.', 'bad_response');
    const body = out as { ok?: boolean; error?: { code?: string; message?: string } };
    if (body.ok === false) {
      throw new PolypadError(body.error?.message ?? 'The tool call failed.', body.error?.code ?? 'tool_error');
    }
    return out as T;
  }

  // ---- reads (no wallet, no signature) --------------------------------------

  whatCanIDo() {
    return this.callTool('polypad_what_can_i_do', {});
  }

  intent(args: { text: string; from?: string; ref?: string }) {
    return this.callTool('polypad_intent', args);
  }

  listTokens(args: { sort?: string; q?: string; limit?: number } = {}) {
    return this.callTool('polypad_list_tokens', args);
  }
  getToken(token: string) {
    return this.callTool('polypad_get_token', { token });
  }
  tokenProtections(token: string) {
    return this.callTool('polypad_token_protections', { token });
  }
  quoteTrade(args: { token: string; side: 'buy' | 'sell'; amount?: string; amountEth?: string; slippageBps?: number }) {
    return this.callTool('polypad_quote_trade', args);
  }
  listNfts(args: Record<string, unknown> = {}) {
    return this.callTool('polypad_list_nfts', args);
  }
  listNftListings(args: Record<string, unknown> = {}) {
    return this.callTool('polypad_list_nft_listings', args);
  }
  listFunds(args: Record<string, unknown> = {}) {
    return this.callTool('polypad_list_funds', args);
  }
  getFund(fund: string) {
    return this.callTool('polypad_get_fund', { fund });
  }
  listFundTemplates() {
    return this.callTool('polypad_list_fund_templates', {});
  }
  portfolio(address: string) {
    return this.callTool('polypad_portfolio', { address });
  }
  stats() {
    return this.callTool('polypad_stats', {});
  }

  /** One status check. Pending means the transaction is still travelling. */
  getTxStatus(hash: string): Promise<TxStatus> {
    return this.callTool<TxStatus>('polypad_get_tx_status', { hash });
  }

  // ---- prepares (wallet from the token, or an explicit `from`) --------------

  prepareBuy(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_buy', args);
  }
  prepareSell(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_sell', args);
  }
  prepareNftBuy(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_nft_buy', args);
  }
  prepareFundCreate(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_fund_create', args);
  }
  prepareFundMint(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_fund_mint', args);
  }
  prepareFundRedeem(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_fund_redeem', args);
  }
  prepareTokenLaunch(args: Record<string, unknown>) {
    return this.callTool<PreparedAction>('polypad_prepare_token_launch', args);
  }

  // ---- the loop: prepare → sign → confirm -----------------------------------

  /**
   * Poll get_tx_status until the transaction confirms or fails. Throws on timeout.
   * A hash the chain has not seen yet (`tx_not_found`) keeps polling until the timeout,
   * because a just-sent transaction can take a few seconds to appear.
   */
  async waitForConfirmation(
    txHash: string,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<TxStatus> {
    const intervalMs = options.intervalMs ?? 3000;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const started = Date.now();
    for (;;) {
      let status: TxStatus;
      try {
        status = await this.getTxStatus(txHash);
      } catch (e) {
        if (e instanceof PolypadError && e.code === 'tx_not_found') {
          if (Date.now() - started > timeoutMs) {
            throw new PolypadError(`No confirmation after ${Math.round(timeoutMs / 1000)}s for ${txHash}. Check the explorer.`, 'confirm_timeout');
          }
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        throw e;
      }
      if (status.status === 'confirmed' || status.status === 'failed') return status;
      if (Date.now() - started > timeoutMs) {
        throw new PolypadError(`No confirmation after ${Math.round(timeoutMs / 1000)}s for ${txHash}. Check the explorer.`, 'confirm_timeout');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Prepare → sign → confirm, for a chat agent. Prepares the action (wallet from the stored
   * token), hands the signing link to `onSigningLink` for the user to open, then waits for the
   * transaction hash — supplied by `getTxHash`, which resolves once the user has signed (for
   * example from the returnUrl callback, or the user pasting the hash back) — and polls until
   * the chain confirms it.
   */
  async prepareSignConfirm(options: {
    tool: string;
    arguments: Record<string, unknown>;
    returnUrl?: string;
    onSigningLink: (url: string, summary: PreparedAction['summary']) => void | Promise<void>;
    getTxHash: () => Promise<string>;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<{ status: 'confirmed' | 'failed'; txHash: string; result?: string; txStatus: TxStatus; prepared: PreparedAction }> {
    const args = { ...options.arguments };
    if (options.returnUrl) args.returnUrl = options.returnUrl;
    const prepared = await this.callTool<PreparedAction>(options.tool, args);
    await options.onSigningLink(prepared.signing.url, prepared.summary);
    const txHash = await options.getTxHash();
    const done = await this.waitForConfirmation(txHash, { intervalMs: options.pollIntervalMs, timeoutMs: options.timeoutMs });
    return { status: done.status as 'confirmed' | 'failed', txHash, result: done.result, txStatus: done, prepared };
  }

  /**
   * Prepare → sign → confirm, for a script with its own wallet (the Forge path). Prepares the
   * action, signs and sends each step with the script's own key, waits for each step's receipt
   * before the next, then polls get_tx_status for the final result. The signing key must be the
   * bound wallet — never the Polypad deployer wallet.
   */
  async prepareSignBroadcast(options: {
    tool: string;
    arguments: Record<string, unknown>;
    privateKey: Hex;
    rpcUrl?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<{ status: 'confirmed' | 'failed'; txHash: string; result?: string; txStatus: TxStatus; hashes: string[]; prepared: PreparedAction }> {
    const prepared = await this.callTool<PreparedAction>(options.tool, { ...options.arguments });
    const account: PrivateKeyAccount = privateKeyToAccount(options.privateKey);
    const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
    const chain = { ...ROBINHOOD_CHAIN, rpcUrls: { default: { http: [rpcUrl] } } };
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const bound = this.walletAddress();
    if (bound && bound.toLowerCase() !== account.address.toLowerCase()) {
      throw new PolypadError(`The signing key (${account.address}) is not the bound wallet (${bound}).`, 'wallet_mismatch');
    }
    for (const step of prepared.transactions) {
      if (step.from.toLowerCase() !== account.address.toLowerCase()) {
        throw new PolypadError(`Step ${step.step} was prepared for ${step.from}, not the signing wallet ${account.address}.`, 'wallet_mismatch');
      }
    }
    const hashes: string[] = [];
    for (let i = 0; i < prepared.transactions.length; i += 1) {
      const step = prepared.transactions[i];
      const hash = await walletClient.sendTransaction({
        account: account as Account,
        chain,
        to: step.to as Hex,
        data: step.data,
        value: BigInt(step.value),
        ...(step.gas ? { gas: BigInt(step.gas) } : {}),
      });
      hashes.push(hash);
      if (i < prepared.transactions.length - 1) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (receipt.status !== 'success') throw new PolypadError(`Step ${i + 1} failed on-chain. Nothing after it was sent.`, 'step_failed');
      }
    }
    const txHash = hashes[hashes.length - 1];
    const done = await this.waitForConfirmation(txHash, { intervalMs: options.pollIntervalMs, timeoutMs: options.timeoutMs });
    return { status: done.status as 'confirmed' | 'failed', txHash, result: done.result, txStatus: done, hashes, prepared };
  }
}
