/**
 * Errors. The server answers with `{ ok: false, error: { code, message, ... } }`
 * (and the same shape inside a tools/call reply marked `isError: true`).
 * This module turns those replies — plus plain JSON-RPC and HTTP failures —
 * into one typed error with the server's own plain-language meaning attached.
 */
import { ERROR_MEANINGS } from './constants.js';

export class PolypadError extends Error {
  /** Machine-readable code from the server (for example `rate_limited`). */
  code: string;
  /** HTTP status when the server sent one. */
  status?: number;
  /** Extra fields the server sent (for example `retryAfter`, `field`). */
  extra: Record<string, unknown>;
  /** The server's plain-language meaning for this code, when one is published. */
  meaning?: string;

  constructor(message: string, code = 'error', status?: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PolypadError';
    this.code = code;
    this.status = status;
    this.extra = extra;
    this.meaning = ERROR_MEANINGS[code];
  }

  /** Seconds to wait before retrying, when the server said so (429s). */
  get retryAfterSeconds(): number | undefined {
    const v = this.extra.retryAfter;
    return typeof v === 'number' ? v : undefined;
  }
}

/** Thrown by `confirm()` when a transaction is mined but fails on-chain. */
export class PolypadTxFailedError extends PolypadError {
  readonly txHash: string;
  constructor(txHash: string, result: string) {
    super(`Transaction ${txHash} was mined but failed on-chain. ${result}`, 'tx_failed', undefined, { txHash });
    this.name = 'PolypadTxFailedError';
    this.txHash = txHash;
  }
}

/** Thrown by `confirm()` when no final answer arrives before the timeout. */
export class PolypadConfirmTimeoutError extends PolypadError {
  readonly txHash: string;
  readonly explorerUrl: string;
  constructor(txHash: string, timeoutMs: number, explorerUrl: string) {
    super(
      `No confirmed or failed result for ${txHash} within ${Math.round(timeoutMs / 1000)} seconds. ` +
        `The transaction may still confirm — check ${explorerUrl} before sending it again, or you may pay twice.`,
      'confirm_timeout',
      undefined,
      { txHash, timeoutMs },
    );
    this.name = 'PolypadConfirmTimeoutError';
    this.txHash = txHash;
    this.explorerUrl = explorerUrl;
  }
}

/** The `{ ok: false, error: {...} }` shape the server returns. */
export type ApiErrorBody = {
  code: string;
  message: string;
  [k: string]: unknown;
};

export function isApiErrorBody(v: unknown): v is { ok: false; error: ApiErrorBody } {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as { ok?: unknown }).ok === false &&
    !!(v as { error?: unknown }).error &&
    typeof (v as { error: { code?: unknown } }).error.code === 'string'
  );
}

export function polypadErrorFromBody(body: { ok: false; error: ApiErrorBody }, status?: number): PolypadError {
  const { code, message, ...extra } = body.error;
  return new PolypadError(message, code, status, extra);
}
