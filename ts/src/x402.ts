/**
 * x402 pay-per-call: pay a few cents for a priced report (token report $0.01, Tokenized Fund NAV $0.01,
 * CTO report $0.05) with USDG (EIP-3009) or POLYDASH (Permit2). The flow is the x402 v2 one:
 * ask, get a 402 with the price, sign the authorization, send it back in the X-PAYMENT header.
 * The server only settles after the report is built — if the report cannot be built, nothing
 * is charged.
 *
 * Two ways to use it:
 * - `payForReport` — the one-call path for USDG: fetch the report, paying with the given
 *   account. Everything the signature needs comes from the 402 answer itself.
 * - `signX402Payment` + `fetchWithX402` — the building blocks, for both USDG (EIP-3009) and
 *   POLYDASH (Permit2). The payment is checked before signing: wrong recipient, wrong
 *   network, wrong token, or a zero amount are all refused.
 */
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, parseAbi, type Account, type Hex } from 'viem';
import { robinhoodChain } from './chain.js';
import { X402, x402Product, type X402ProductId } from './constants.js';
import { PolypadError } from './errors.js';

export const SITE_ORIGIN = 'https://polypad.family';
export const CHAIN_ID = 4663;

/**
 * A wallet that can sign EIP-712 typed data — for example a viem account
 * from `privateKeyToAccount`. Only the address and the signing function
 * are needed; the SDK never sees the key itself.
 */
export type TypedDataSigner = Pick<Account, 'address'> & {
  signTypedData: NonNullable<Account['signTypedData']>;
};
export interface PaymentRequirement {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource?: { url: string; description: string; mimeType: string };
  description: string;
  mimeType?: string;
  extra: { assetTransferMethod: 'eip3009' | 'permit2'; name: string; version: string };
}

export type X402PaymentPayload =
  | {
      signature: Hex;
      authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: Hex };
    }
  | {
      signature: Hex;
      permit2Authorization: {
        permitted: { token: string; amount: string };
        from: string;
        spender: string;
        nonce: string;
        deadline: string;
        witness: { to: string; validAfter: string };
      };
    };

export interface X402Payment {
  x402Version: 2;
  accepted: PaymentRequirement;
  payload: X402PaymentPayload;
}

const NONCE_BITMAP_ABI = parseAbi(['function nonceBitmap(address owner, uint256 word) view returns (uint256)']);

/**
 * The next unused Permit2 nonce for a wallet. Permit2 tracks used nonces
 * in 256-bit words; the first unset bit in the lowest word is the next
 * free nonce. A payment signed with an already-used nonce is rejected, so
 * never reuse a nonce.
 */
export async function nextPermit2Nonce(owner: string, rpcUrl: string = X402.rpcUrl): Promise<bigint> {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
  for (let word = 0n; word < 4n; word++) {
    const bitmap = await client.readContract({
      address: X402.permit2 as Hex,
      abi: NONCE_BITMAP_ABI,
      functionName: 'nonceBitmap',
      args: [owner as Hex, word],
    });
    for (let bit = 0n; bit < 256n; bit++) {
      if (((bitmap as bigint) >> bit) & 1n) continue;
      return word * 256n + bit;
    }
  }
  throw new PolypadError('No free Permit2 nonce found in the first 1,024 nonces for this wallet.', 'invalid_params');
}

export interface SignPaymentOptions {
  /** Permit2 nonce. When omitted, the next free nonce is read from the chain. */
  nonce?: bigint;
  /** Robinhood Chain RPC URL for the nonce read. Defaults to the public RPC. */
  rpcUrl?: string;
  /** Approval lifetime in seconds. Defaults to the requirement's maxTimeoutSeconds (120). */
  timeoutSeconds?: number;
}

/**
 * Sign a payment for one `accepts` entry from a 402 reply.
 * Returns the full x402 v2 payload — pass it to `encodePaymentHeader`
 * and send it as the `X-PAYMENT` header.
 */
export async function signX402Payment(
  accepted: PaymentRequirement,
  account: TypedDataSigner,
  opts: SignPaymentOptions = {},
): Promise<X402Payment> {
  if (accepted.scheme !== 'exact' || accepted.network !== X402.network) {
    throw new PolypadError(
      `Unsupported payment requirement: ${accepted.scheme} on ${accepted.network}. This SDK pays x402 v2 exact payments on eip155:4663 only.`,
      'invalid_params',
    );
  }
  if (accepted.payTo.toLowerCase() !== X402.payTo.toLowerCase()) {
    throw new PolypadError(`Refused: this payment goes to ${accepted.payTo}, not the Polypad fee wallet.`, 'invalid_params');
  }
  const amount = BigInt(accepted.amount);
  if (amount <= 0n) throw new PolypadError('Refused: the payment amount is zero.', 'invalid_params');
  const now = Math.floor(Date.now() / 1000);
  const timeout = opts.timeoutSeconds ?? accepted.maxTimeoutSeconds ?? X402.maxTimeoutSeconds;
  const validAfter = BigInt(now);
  const validBefore = BigInt(now + timeout);

  if (accepted.extra.assetTransferMethod === 'eip3009') {
    if (accepted.asset.toLowerCase() !== X402.usdg.address.toLowerCase()) {
      throw new PolypadError(`Refused: EIP-3009 payment for an unexpected token ${accepted.asset}.`, 'invalid_params');
    }
    // EIP-3009 nonces are random 32-byte values, one use each.
    const nonce = `0x${randomBytes(32).toString('hex')}` as Hex;
    const signature = await account.signTypedData({
      domain: {
        name: X402.usdg.eip712.name,
        version: X402.usdg.eip712.version,
        chainId: X402.chainId,
        verifyingContract: X402.usdg.address as Hex,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address as Hex,
        to: accepted.payTo as Hex,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    });
    return {
      x402Version: 2,
      accepted,
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: accepted.payTo,
          value: amount.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
  }

  if (accepted.extra.assetTransferMethod === 'permit2') {
    if (accepted.asset.toLowerCase() !== X402.polydash.address.toLowerCase()) {
      throw new PolypadError(`Refused: Permit2 payment for an unexpected token ${accepted.asset}.`, 'invalid_params');
    }
    const nonce = opts.nonce ?? (await nextPermit2Nonce(account.address, opts.rpcUrl));
    const deadline = validBefore;
    const signature = await account.signTypedData({
      domain: { name: 'Permit2', chainId: X402.chainId, verifyingContract: X402.permit2 as Hex },
      types: {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: 'Witness' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        Witness: [
          { name: 'to', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
        ],
      },
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: accepted.asset as Hex, amount },
        spender: X402.permit2Proxy as Hex,
        nonce,
        deadline,
        witness: { to: accepted.payTo as Hex, validAfter },
      },
    });
    return {
      x402Version: 2,
      accepted,
      payload: {
        signature,
        permit2Authorization: {
          permitted: { token: accepted.asset, amount: amount.toString() },
          from: account.address,
          spender: X402.permit2Proxy,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          witness: { to: accepted.payTo, validAfter: validAfter.toString() },
        },
      },
    };
  }

  throw new PolypadError(`Unsupported payment method: ${accepted.extra.assetTransferMethod}.`, 'invalid_params');
}

/** The `X-PAYMENT` header value for a signed payment: base64 JSON. */
export function encodePaymentHeader(payment: X402Payment): string {
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

export interface FetchWithPaymentOptions extends SignPaymentOptions {
  /** Pay in USDG (default) or POLYDASH. */
  asset?: 'USDG' | 'POLYDASH';
  /** Fetch implementation (defaults to the global fetch). */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Per-request timeout in milliseconds. Default 30,000. */
  timeoutMs?: number;
}

export interface PaidFetchResult {
  /** The final response (the paid content). */
  response: Response;
  /** The payment that was sent, if the first request came back 402. */
  payment: X402Payment | null;
  /** The requirement that was paid, if any. */
  accepted: PaymentRequirement | null;
}

/**
 * GET a priced Polypad read (a token report, a Tokenized Fund NAV, a CTO
 * report) with x402 payment handled for you: request, get a 402 with the
 * price, sign the payment, retry with the `X-PAYMENT` header.
 *
 * `url` is the full product URL, for example
 * `https://polypad.family/api/x402/products/token-report?address=0x…`.
 * Use `productUrl()` to build it from a product id.
 */
export async function fetchWithX402(url: string, account: TypedDataSigner, opts: FetchWithPaymentOptions = {}): Promise<PaidFetchResult> {
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const first = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (first.status !== 402) return { response: first, payment: null, accepted: null };

  let body: { x402Version?: number; accepts?: PaymentRequirement[] };
  try {
    body = (await first.json()) as typeof body;
  } catch {
    throw new PolypadError('The priced read answered 402 with something that was not JSON.', 'invalid_response');
  }
  const accepts = body.accepts ?? [];
  if (!accepts.length) throw new PolypadError('The priced read answered 402 but named no payment option.', 'invalid_response');
  const wanted = opts.asset ?? 'USDG';
  const accepted =
    accepts.find((a) => a.asset.toLowerCase() === (wanted === 'USDG' ? X402.usdg.address : X402.polydash.address).toLowerCase()) ??
    accepts[0];
  const payment = await signX402Payment(accepted, account, opts);
  const second = await doFetch(url, {
    headers: { 'x-payment': encodePaymentHeader(payment) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response: second, payment, accepted };
}

/** Build the URL for a priced read: product id plus the one address it needs. */
export function productUrl(productId: X402ProductId, address: string): string {
  const product = x402Product(productId);
  if (!product) throw new PolypadError(`Unknown x402 product: ${productId}.`, 'invalid_params');
  return `https://polypad.family${product.endpoint}?${product.queryParam}=${encodeURIComponent(address)}`;
}

function toBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

type PaymentRequirementV2 = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource: { url: string; description: string; mimeType: string };
  description: string;
  mimeType: string;
  extra: { assetTransferMethod?: string; name?: string; version?: string };
};

/**
 * Fetch a priced report, paying with USDG from the given account. `query` is the report's query
 * string, for example "address=0x..." for a token report. Returns the report JSON.
 *
 * This is the one-call path: it only pays with USDG (EIP-3009) and takes the price, asset,
 * and domain straight from the 402 answer. For POLYDASH (Permit2) payments, or to sign a
 * payment yourself, use `fetchWithX402` / `signX402Payment` instead.
 */
export async function payForReport(options: {
  product: 'token-report' | 'fund-nav' | 'cto-report' | string;
  query: string;
  account: import('viem').PrivateKeyAccount;
  origin?: string;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<Record<string, unknown>> {
  const origin = options.origin ?? SITE_ORIGIN;
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${origin}/api/x402/products/${options.product}?${options.query}`;

  const ask = await fetchFn(url);
  if (ask.ok) return (await ask.json()) as Record<string, unknown>;
  if (ask.status !== 402) throw new Error(`Report endpoint answered HTTP ${ask.status}.`);
  const body = (await ask.json()) as { accepts?: PaymentRequirementV2[] };
  const requirement = (body.accepts ?? []).find((r) => r.extra?.assetTransferMethod === 'eip3009');
  if (!requirement) throw new Error('The report does not offer a USDG (EIP-3009) payment option.');

  const now = Math.floor(Date.now() / 1000);
  const nonce = `0x${randomBytes(32).toString('hex')}` as Hex;
  const authorization = {
    from: options.account.address,
    to: requirement.payTo,
    value: requirement.amount,
    validAfter: '0',
    validBefore: String(now + requirement.maxTimeoutSeconds),
    nonce,
  };
  const signature = await options.account.signTypedData({
    domain: {
      name: requirement.extra.name ?? 'Global Dollar',
      version: requirement.extra.version ?? '1',
      chainId: CHAIN_ID,
      verifyingContract: requirement.asset as Hex,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  } as never);

  const payment = toBase64Json({ x402Version: 2, accepted: requirement, payload: { signature, authorization } });
  const paid = await fetchFn(url, { headers: { 'X-PAYMENT': payment } });
  if (!paid.ok) throw new Error(`Paid report request answered HTTP ${paid.status}.`);
  return (await paid.json()) as Record<string, unknown>;
}
