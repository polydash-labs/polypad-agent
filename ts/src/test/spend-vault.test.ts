import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateKeyTx,
  buildDepositTx,
  buildRevokeKeyTx,
  buildWithdrawTx,
  getKeyStatus,
  spendVaultKeyFlow,
} from '../spend-vault.js';
import { SPEND_VAULT_ADDRESS, X402 } from '../constants.js';

const KEY = '0x1111111111111111111111111111111111111111';
const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

test('buildCreateKeyTx builds a createKey call to the vault with the right selector', () => {
  const tx = buildCreateKeyTx({ key: KEY, token: 'USDG', perPaymentCap: 10_000n, dailyCap: 500_000n, allowlist: [], expiry: FUTURE });
  assert.equal(tx.to, SPEND_VAULT_ADDRESS);
  assert.equal(tx.chainId, 4663);
  assert.equal(tx.value, '0');
  // createKey(address,address,uint256,uint256,address[],uint64) = 0x9d30cddc
  assert.equal(tx.data.slice(0, 10), '0x9d30cddc');
});

test('deposit / withdraw / revoke builders use the right selectors', () => {
  assert.equal(buildDepositTx('USDG', 1_000_000n).data.slice(0, 10), '0x47e7ef24');
  assert.equal(buildWithdrawTx('POLYDASH', 5n).data.slice(0, 10), '0xf3fef3a3');
  assert.equal(buildRevokeKeyTx(KEY).data.slice(0, 10), '0x5ae7ab32');
  assert.equal(buildDepositTx('USDG', 1n).to, SPEND_VAULT_ADDRESS);
});

test('buildCreateKeyTx rejects a per-payment cap above the daily cap', () => {
  assert.throws(
    () => buildCreateKeyTx({ key: KEY, token: 'USDG', perPaymentCap: 600_000n, dailyCap: 500_000n, expiry: FUTURE }),
    /per-payment cap cannot be larger/,
  );
});

test('buildCreateKeyTx rejects an expiry in the past', () => {
  assert.throws(
    () => buildCreateKeyTx({ key: KEY, token: 'USDG', perPaymentCap: 1n, dailyCap: 2n, expiry: Math.floor(Date.now() / 1000) - 10 }),
    /expiry must be in the future/,
  );
});

test('buildCreateKeyTx rejects a malformed key address', () => {
  assert.throws(
    () => buildCreateKeyTx({ key: 'nope', token: 'USDG', perPaymentCap: 1n, dailyCap: 2n, expiry: FUTURE }),
    /must be a 0x wallet address/,
  );
});

test('buildDepositTx rejects a zero deposit', () => {
  assert.throws(() => buildDepositTx('USDG', 0n), /above zero/);
});

test('spendVaultKeyFlow explains the key flow in plain words', () => {
  const steps = spendVaultKeyFlow();
  assert.ok(steps.length >= 5);
  assert.match(steps.join(' '), /wallet address, not a password or secret/);
  assert.match(steps.join(' '), /agents\/accounts/);
});

function ethCallResult(words: (bigint | string)[]) {
  const hex = words
    .map((w) => (typeof w === 'bigint' ? w.toString(16).padStart(64, '0') : w.replace(/^0x/, '').padStart(64, '0')))
    .join('');
  return `0x${hex}`;
}

test('getKeyStatus reads and decodes a key row', async () => {
  const realFetch = globalThis.fetch;
  try {
    const owner = `0x${'22'.repeat(20)}`;
    const token = X402.usdg.address.toLowerCase();
    const data = ethCallResult([owner, token, 10_000n, 500_000n, BigInt(FUTURE), 0n, 0n, 123n, 0n]);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: data }), { status: 200 })) as typeof fetch;
    const status = await getKeyStatus(KEY, 'https://example.invalid');
    assert.ok(status !== null);
    assert.equal(status?.owner.toLowerCase(), owner);
    assert.equal(status?.token.toLowerCase(), token);
    assert.equal(status?.perPaymentCap, 10_000n);
    assert.equal(status?.dailyCap, 500_000n);
    assert.equal(status?.expiry, FUTURE);
    assert.equal(status?.revoked, false);
    assert.equal(status?.spentToday, 123n);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('getKeyStatus returns null when the address has no key (zero owner)', async () => {
  const realFetch = globalThis.fetch;
  try {
    const data = ethCallResult(['0x0000000000000000000000000000000000000000', X402.usdg.address, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: data }), { status: 200 })) as typeof fetch;
    assert.equal(await getKeyStatus(KEY, 'https://example.invalid'), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
