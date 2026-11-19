/**
 * The sign loop: prepare → sign → confirm.
 *
 * Polypad is non-custodial, so signing always happens outside the API:
 *
 * 1. **Prepare** — a `prepare_*` tool returns unsigned transactions plus a
 *    one-tap `/sign` link. Show the summary first, then the link.
 * 2. **Sign** — either a person opens the link and signs in their own
 *    wallet on polypad.family/sign, or a script signs the steps itself
 *    with its own wallet (the Forge path — see `signAndSend`).
 * 3. **Confirm** — `confirm()` polls `polypad_get_tx_status` until the
 *    transaction confirms or fails. The /sign page polls the same way:
 *    every 3 seconds, for 2 minutes.
 *
 * Wallet model — persistent binding: the agent connects once on
 * /sign?connect=1 and gets a token; prepare calls pass `walletToken`
 * instead of a per-call `from` (see binding.ts). The per-call `from`
 * address is the underlying transport and the fallback: an explicit
 * `from` always wins over the binding, and the /sign page rebuilds the
 * action for whichever wallet connects there.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { robinhoodChain } from './chain.js';
import { EXPLORER } from './constants.js';
import { PolypadConfirmTimeoutError, PolypadError, PolypadTxFailedError } from './errors.js';
import type { PolypadClient } from './client.js';
import type { PreparedAction, TxStatus } from './tools.js';

export interface ConfirmOptions {
  /** Give up after this long. Default 120,000 ms (2 minutes, like the /sign page). */
  timeoutMs?: number;
  /** Wait this long between status checks. Default 3,000 ms (like the /sign page). */
  intervalMs?: number;
  /** Abort early when this fires. */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `polypad_get_tx_status` until the transaction confirms or fails.
 *
 * - `pending` → keep polling.
 * - `tx_not_found` (404) → the chain has not seen the hash yet; keep
 *   polling until the timeout, because a just-sent transaction can take a
 *   few seconds to appear.
 * - `confirmed` → returns the status, with its plain-language `result`.
 * - `failed` → throws PolypadTxFailedError.
 * - Nothing final before `timeoutMs` → throws PolypadConfirmTimeoutError.
 *   A timeout does NOT mean the transaction failed — check the explorer
 *   link in the error before sending anything again.
 */
export async function confirm(client: PolypadClient, txHash: string, opts: ConfirmOptions = {}): Promise<TxStatus> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const started = Date.now();
  const explorerUrl = `${EXPLORER}/tx/${txHash}`;
  for (;;) {
    if (opts.signal?.aborted) throw new PolypadError('Confirmation polling was cancelled.', 'aborted');
    let status: TxStatus;
    try {
      status = await client.getTxStatus(txHash);
    } catch (e) {
      if (e instanceof PolypadError && e.code === 'tx_not_found') {
        // Not seen on-chain yet. Keep waiting until the timeout.
        if (Date.now() - started > timeoutMs) {
          throw new PolypadConfirmTimeoutError(txHash, timeoutMs, explorerUrl);
        }
        await sleep(intervalMs);
        continue;
      }
      throw e;
    }
    if (status.status === 'confirmed') return status;
    if (status.status === 'failed') {
      throw new PolypadTxFailedError(txHash, status.result ?? 'The transaction was mined but failed. No state changed except gas spent.');
    }
    if (Date.now() - started > timeoutMs) {
      throw new PolypadConfirmTimeoutError(txHash, timeoutMs, explorerUrl);
    }
    await sleep(intervalMs);
  }
}

export interface SignAndSendOptions {
  /** Robinhood Chain RPC URL. Defaults to the client's RPC. */
  rpcUrl?: string;
  /** Wait for each step's receipt before sending the next one. Default true (same as the /sign page). */
  waitBetweenSteps?: boolean;
  /** Give up waiting for a step's receipt after this long. Default 120,000 ms. */
  stepTimeoutMs?: number;
}

export interface SentStep {
  step: number;
  hash: Hex;
}

/**
 * Sign every step of a prepared action with your own wallet and send them,
 * in order — the path Forge uses to launch a token from a script.
 *
 * `account` is a viem account (for example from `privateKeyToAccount`).
 * The key stays in your process; it is never sent to Polypad. Each step is
 * checked before it is sent: it must be for Robinhood Chain (4663), its
 * `from` must match your wallet, and its `to` must be an address the API
 * returned for this action. Steps are sent one at a time, and each step's
 * receipt is awaited before the next step is sent (unless
 * `waitBetweenSteps` is false) — the same order the /sign page uses.
 *
 * Returns the transaction hash of every step sent. If a step fails, the
 * error is thrown and no later step is sent.
 */
export async function signAndSend(
  prepared: PreparedAction,
  account: Account,
  opts: SignAndSendOptions = {},
): Promise<SentStep[]> {
  const rpcUrl = opts.rpcUrl ?? robinhoodChain.rpcUrls.default.http[0];
  const waitBetweenSteps = opts.waitBetweenSteps ?? true;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 120_000;
  const publicClient: PublicClient = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
  const walletClient: WalletClient = createWalletClient({ chain: robinhoodChain, transport: http(rpcUrl), account });

  const allowedTargets = new Set<string>();
  for (const step of prepared.transactions) allowedTargets.add(step.to.toLowerCase());
  // Addresses the API itself returns outside the transactions (a new token,
  // a new fund) are also valid targets for later steps.
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) allowedTargets.add(v.toLowerCase());
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(collect);
  };
  const { transactions: _t, signing: _s, ...rest } = prepared;
  collect(rest);

  const sent: SentStep[] = [];
  for (const step of prepared.transactions) {
    if (step.chainId !== 4663) {
      throw new PolypadError(`Refused: step ${step.step} is not for Robinhood Chain (chain id 4663).`, 'invalid_params');
    }
    if (step.from.toLowerCase() !== account.address.toLowerCase()) {
      throw new PolypadError(`Refused: step ${step.step} was built for a different wallet (${step.from}).`, 'invalid_params');
    }
    if (!allowedTargets.has(step.to.toLowerCase())) {
      throw new PolypadError(`Refused: step ${step.step} sends to an address the API did not return for this action.`, 'invalid_params');
    }
    if (!/^0x[0-9a-fA-F]*$/.test(step.data) || !/^\d{1,40}$/.test(step.value)) {
      throw new PolypadError(`Refused: step ${step.step} is malformed.`, 'invalid_params');
    }
    const hash = await walletClient.sendTransaction({
      account,
      chain: robinhoodChain,
      to: step.to as Hex,
      data: step.data,
      value: BigInt(step.value),
      ...(step.gas ? { gas: BigInt(step.gas) } : {}),
    });
    sent.push({ step: step.step, hash });
    const isLast = step.step === prepared.transactions.length;
    if (waitBetweenSteps && !isLast) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: stepTimeoutMs });
      if (receipt.status !== 'success') {
        throw new PolypadTxFailedError(hash, `Step ${step.step} failed on-chain. Nothing after it was sent.`);
      }
    }
  }
  return sent;
}

/**
 * The whole scripted loop in one call: sign and send every step, then wait
 * for the last step to confirm. Returns the confirmed status of the last
 * transaction, plus every hash sent. For the human flow (a person signs on
 * the /sign page), use `confirm()` with the hash they paste back instead.
 */
export async function signSendAndConfirm(
  client: PolypadClient,
  prepared: PreparedAction,
  account: Account,
  opts: SignAndSendOptions & ConfirmOptions = {},
): Promise<{ sent: SentStep[]; status: TxStatus }> {
  const sent = await signAndSend(prepared, account, opts);
  const last = sent[sent.length - 1];
  if (!last) throw new PolypadError('The prepared action has no transactions.', 'invalid_params');
  const status = await confirm(client, last.hash, opts);
  return { sent, status };
}
