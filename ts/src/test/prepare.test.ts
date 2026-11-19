import test from 'node:test';
import assert from 'node:assert/strict';
import { PolypadClient } from '../index.js';
import { PolypadConfirmTimeoutError, PolypadTxFailedError } from '../errors.js';
import { confirm } from '../prepare.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function okCall(result: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function errCall(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

/** A client whose fetch answers tools/call with a canned sequence of replies. */
function sequencedClient(replies: unknown[]) {
  let i = 0;
  const fetchFn = (async () =>
    jsonResponse({ jsonrpc: '2.0', id: 1, result: replies[Math.min(i++, replies.length - 1)] })) as typeof fetch;
  return new PolypadClient({ fetch: fetchFn });
}

const HASH = `0x${'11'.repeat(32)}`;

test('confirm() returns the confirmed status with its plain-language result', async () => {
  const client = sequencedClient([
    okCall({ ok: true, chainId: 4663, hash: HASH, status: 'pending', explorer: `https://x/tx/${HASH}` }),
    okCall({ ok: true, chainId: 4663, hash: HASH, status: 'confirmed', result: 'Token launched: TEST.', explorer: `https://x/tx/${HASH}` }),
  ]);
  const status = await confirm(client, HASH, { intervalMs: 5 });
  assert.equal(status.status, 'confirmed');
  assert.equal(status.result, 'Token launched: TEST.');
});

test('confirm() keeps polling through tx_not_found and then confirms', async () => {
  const client = sequencedClient([
    errCall({ ok: false, error: { code: 'tx_not_found', message: 'No transaction with that hash was found yet.' } }),
    okCall({ ok: true, chainId: 4663, hash: HASH, status: 'confirmed', result: 'The transaction was confirmed.', explorer: `https://x/tx/${HASH}` }),
  ]);
  const status = await confirm(client, HASH, { intervalMs: 5 });
  assert.equal(status.status, 'confirmed');
});

test('confirm() throws PolypadTxFailedError when the transaction fails on-chain', async () => {
  const client = sequencedClient([
    okCall({ ok: true, chainId: 4663, hash: HASH, status: 'failed', result: 'The transaction was mined but failed.', explorer: `https://x/tx/${HASH}` }),
  ]);
  await assert.rejects(() => confirm(client, HASH, { intervalMs: 5 }), PolypadTxFailedError);
});

test('confirm() throws PolypadConfirmTimeoutError with the explorer link', async () => {
  const client = sequencedClient([okCall({ ok: true, chainId: 4663, hash: HASH, status: 'pending', explorer: `https://x/tx/${HASH}` })]);
  await assert.rejects(
    () => confirm(client, HASH, { timeoutMs: 30, intervalMs: 5 }),
    (e: unknown) => {
      assert.ok(e instanceof PolypadConfirmTimeoutError);
      assert.equal(e.txHash, HASH);
      assert.ok(e.explorerUrl.includes(HASH));
      assert.match(e.message, /may still confirm/);
      return true;
    },
  );
});

test('confirm() throws other server errors straight through instead of polling forever', async () => {
  const client = sequencedClient([
    errCall({ ok: false, error: { code: 'invalid_params', message: 'hash must be a 32-byte 0x transaction hash.' } }),
  ]);
  await assert.rejects(() => confirm(client, HASH, { intervalMs: 5 }), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal((e as { code?: string }).code, 'invalid_params');
    return true;
  });
});

test('confirm() stops when the abort signal fires', async () => {
  const client = sequencedClient([okCall({ ok: true, chainId: 4663, hash: HASH, status: 'pending', explorer: `https://x/tx/${HASH}` })]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => confirm(client, HASH, { intervalMs: 5, signal: controller.signal }), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal((e as { code?: string }).code, 'aborted');
    return true;
  });
});
