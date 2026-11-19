/**
 * SpendVault spending keys.
 *
 * How it works (this is how /agents/accounts issues keys — nothing here
 * invents a format):
 *
 * - A "spending key" is a wallet *address*, not a secret string. The owner
 *   deposits USDG or POLYDASH into the SpendVault, then calls `createKey`
 *   with the agent's wallet address, the token, a per-payment cap, a daily
 *   cap, an allowlist of addresses the agent may pay, and an expiry.
 * - The agent then spends from the vault with that wallet, inside the caps.
 *   The owner can take the money back any time (`withdraw`) and can revoke
 *   the key any time (`revokeKey`).
 * - The key is created by the *owner* in their own wallet (on
 *   polypad.family/agents/accounts, or with `buildCreateKeyTx` below).
 *   The agent never holds a secret for the vault — its wallet address is
 *   the key, and the vault enforces the caps on-chain.
 *
 * The SDK does not send these transactions for you: each builder returns
 * the unsigned call (to / data / value) for the owner's wallet to sign.
 * `getKeyStatus` reads a key's live state without a wallet.
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, type Hex } from 'viem';
import { robinhoodChain } from './chain.js';
import { SPEND_VAULT_ADDRESS, X402 } from './constants.js';
import { PolypadError } from './errors.js';

export const SPEND_VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
  'function createKey(address key, address token, uint256 perPaymentCap, uint256 dailyCap, address[] allowlist, uint64 expiry)',
  'function revokeKey(address key)',
  'function balances(address owner, address token) view returns (uint256)',
  'function keys(address key) view returns (address owner, address token, uint256 perPaymentCap, uint256 dailyCap, uint64 expiry, bool revoked, uint64 spentDay, uint256 spentToday, uint256 allowlistCount)',
]);

export interface SpendingKeyStatus {
  key: string;
  owner: string;
  token: string;
  perPaymentCap: bigint;
  dailyCap: bigint;
  /** Expiry as a Unix timestamp (seconds). */
  expiry: number;
  revoked: boolean;
  spentToday: bigint;
}

export interface UnsignedCall {
  to: string;
  data: Hex;
  value: string;
  chainId: number;
  description: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireAddress(v: string, field: string): void {
  if (!ADDRESS_RE.test(v)) throw new PolypadError(`${field} must be a 0x wallet address.`, 'invalid_params', undefined, { field });
}

/** The key flow in plain words — for docs, prompts, and agent instructions. */
export function spendVaultKeyFlow(): string[] {
  return [
    'The owner opens polypad.family/agents/accounts and connects their own wallet.',
    'The owner deposits USDG or POLYDASH into the SpendVault (the vault holds the money; the agent never holds it).',
    'The owner creates a spending key for the agent wallet address: the token, a per-payment cap, a daily cap, the addresses the agent may pay, and an expiry date.',
    'The agent spends from the vault with that wallet, inside the caps. The vault enforces them on-chain.',
    'The owner can withdraw the money back or revoke the key at any time.',
    'A spending key is a wallet address, not a password or secret. Never share a private key — Polypad never asks for one.',
  ];
}

function vaultClient(rpcUrl: string = X402.rpcUrl) {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
}

/** Read a spending key's live state (caps, expiry, revoked, spent today). Returns null when the address has no key. */
export async function getKeyStatus(keyAddress: string, rpcUrl?: string): Promise<SpendingKeyStatus | null> {
  requireAddress(keyAddress, 'keyAddress');
  const client = vaultClient(rpcUrl);
  const k = await client.readContract({
    address: SPEND_VAULT_ADDRESS as Hex,
    abi: SPEND_VAULT_ABI,
    functionName: 'keys',
    args: [keyAddress as Hex],
  });
  const [owner, token, perPaymentCap, dailyCap, expiry, revoked, _spentDay, spentToday] = k as unknown as [
    string, string, bigint, bigint, bigint, boolean, bigint, bigint,
  ];
  if (owner === '0x0000000000000000000000000000000000000000') return null;
  return { key: keyAddress, owner, token, perPaymentCap, dailyCap, expiry: Number(expiry), revoked, spentToday };
}

/** Read how much of a token an owner has in the vault. */
export async function getVaultBalance(owner: string, token: 'USDG' | 'POLYDASH' | string, rpcUrl?: string): Promise<bigint> {
  requireAddress(owner, 'owner');
  const tokenAddress = token === 'USDG' ? X402.usdg.address : token === 'POLYDASH' ? X402.polydash.address : token;
  requireAddress(tokenAddress, 'token');
  const client = vaultClient(rpcUrl);
  return (await client.readContract({
    address: SPEND_VAULT_ADDRESS as Hex,
    abi: SPEND_VAULT_ABI,
    functionName: 'balances',
    args: [owner as Hex, tokenAddress as Hex],
  })) as bigint;
}

export interface CreateKeyParams {
  /** The agent's wallet address — this IS the key. */
  key: string;
  token: 'USDG' | 'POLYDASH' | string;
  /** Largest single payment, in the token's smallest units (USDG: 6 decimals; POLYDASH: 18). */
  perPaymentCap: bigint;
  /** Largest total per day, in the token's smallest units. Must be at least the per-payment cap. */
  dailyCap: bigint;
  /** Addresses the agent may pay. An empty list means the vault's own rules decide. */
  allowlist?: string[];
  /** Expiry as a Unix timestamp (seconds). Must be in the future. */
  expiry: number;
}

/** Unsigned `createKey` call for the owner's wallet to sign. The owner signs this — never the agent. */
export function buildCreateKeyTx(params: CreateKeyParams): UnsignedCall {
  requireAddress(params.key, 'key');
  const tokenAddress = params.token === 'USDG' ? X402.usdg.address : params.token === 'POLYDASH' ? X402.polydash.address : params.token;
  requireAddress(tokenAddress, 'token');
  if (params.perPaymentCap <= 0n || params.dailyCap <= 0n) {
    throw new PolypadError('Caps must be above zero.', 'invalid_params');
  }
  if (params.perPaymentCap > params.dailyCap) {
    throw new PolypadError('The per-payment cap cannot be larger than the daily cap.', 'invalid_params');
  }
  if (params.expiry * 1000 <= Date.now()) {
    throw new PolypadError('The expiry must be in the future.', 'invalid_params');
  }
  const allowlist = params.allowlist ?? [];
  allowlist.forEach((a, i) => requireAddress(a, `allowlist[${i}]`));
  return {
    to: SPEND_VAULT_ADDRESS,
    data: encodeFunctionData({
      abi: SPEND_VAULT_ABI,
      functionName: 'createKey',
      args: [params.key as Hex, tokenAddress as Hex, params.perPaymentCap, params.dailyCap, allowlist as Hex[], BigInt(params.expiry)],
    }),
    value: '0',
    chainId: 4663,
    description: `Create a spending key for ${params.key} (token ${tokenAddress}, per-payment cap ${params.perPaymentCap}, daily cap ${params.dailyCap}).`,
  };
}

/** Unsigned `deposit` call for the owner's wallet to sign. Approve the vault to take the tokens first. */
export function buildDepositTx(token: 'USDG' | 'POLYDASH' | string, amount: bigint): UnsignedCall {
  const tokenAddress = token === 'USDG' ? X402.usdg.address : token === 'POLYDASH' ? X402.polydash.address : token;
  requireAddress(tokenAddress, 'token');
  if (amount <= 0n) throw new PolypadError('Deposit amount must be above zero.', 'invalid_params');
  return {
    to: SPEND_VAULT_ADDRESS,
    data: encodeFunctionData({ abi: SPEND_VAULT_ABI, functionName: 'deposit', args: [tokenAddress as Hex, amount] }),
    value: '0',
    chainId: 4663,
    description: `Deposit ${amount} of ${tokenAddress} into the SpendVault.`,
  };
}

/** Unsigned `withdraw` call for the owner's wallet to sign — takes money back out of the vault. */
export function buildWithdrawTx(token: 'USDG' | 'POLYDASH' | string, amount: bigint): UnsignedCall {
  const tokenAddress = token === 'USDG' ? X402.usdg.address : token === 'POLYDASH' ? X402.polydash.address : token;
  requireAddress(tokenAddress, 'token');
  if (amount <= 0n) throw new PolypadError('Withdraw amount must be above zero.', 'invalid_params');
  return {
    to: SPEND_VAULT_ADDRESS,
    data: encodeFunctionData({ abi: SPEND_VAULT_ABI, functionName: 'withdraw', args: [tokenAddress as Hex, amount] }),
    value: '0',
    chainId: 4663,
    description: `Withdraw ${amount} of ${tokenAddress} from the SpendVault.`,
  };
}

/** Unsigned `revokeKey` call for the owner's wallet to sign — the agent can no longer spend. */
export function buildRevokeKeyTx(key: string): UnsignedCall {
  requireAddress(key, 'key');
  return {
    to: SPEND_VAULT_ADDRESS,
    data: encodeFunctionData({ abi: SPEND_VAULT_ABI, functionName: 'revokeKey', args: [key as Hex] }),
    value: '0',
    chainId: 4663,
    description: `Revoke the spending key for ${key}.`,
  };
}
