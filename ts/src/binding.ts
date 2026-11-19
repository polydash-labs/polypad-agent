/**
 * Persistent wallet binding — the token from /sign?connect=1.
 *
 * Connect once: the user opens the connect URL, signs one message (not a transaction), and gets
 * a token. The SDK stores it (POLYPAD_WALLET_TOKEN) and passes it instead of a wallet address on
 * every prepare call. The server recovers the wallet from the signature — no server storage, no
 * per-call `from`. The token lasts 90 days; after that, connect again.
 *
 * The token is base64url JSON { v: 1, address, exp, sig }. This module only decodes it (to show
 * which wallet is bound and when it expires). Verification happens server-side on every call.
 */

export type WalletTokenInfo = {
  address: string;
  /** Expiry as unix seconds. */
  exp: number;
  expired: boolean;
};

function fromBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Decode a wallet token. Returns null when it is not a token at all. */
export function decodeWalletToken(token: string): WalletTokenInfo | null {
  const text = fromBase64Url(token.trim());
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1 || typeof o.address !== 'string' || typeof o.exp !== 'number' || typeof o.sig !== 'string') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.address)) return null;
  return { address: o.address, exp: Math.floor(o.exp), expired: Math.floor(o.exp) <= Math.floor(Date.now() / 1000) };
}

/**
 * The connect URL to show the user. They open it, connect their wallet, sign one message, and get
 * a token. When returnUrl is given, the page sends them back to it with ?walletToken=...&wallet=...
 * after connecting.
 */
export function connectUrl(options: { origin?: string; returnUrl?: string } = {}): string {
  const url = new URL('/sign', options.origin ?? 'https://polypad.family');
  url.searchParams.set('connect', '1');
  if (options.returnUrl) url.searchParams.set('r', options.returnUrl);
  return url.toString();
}
