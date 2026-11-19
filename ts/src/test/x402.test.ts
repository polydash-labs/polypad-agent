import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { encodePaymentHeader, fetchWithX402, nextPermit2Nonce, productUrl, signX402Payment, type PaymentRequirement } from '../x402.js';
import { X402 } from '../constants.js';
import { PolypadError } from '../errors.js';

// A throwaway test key. Never a real key; used only to check signatures recover correctly.
const TEST_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
const account = privateKeyToAccount(TEST_KEY);

const USDG_ACCEPT: PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:4663',
  amount: '10000',
  asset: X402.usdg.address,
  payTo: X402.payTo,
  maxTimeoutSeconds: 120,
  description: 'Token report',
  extra: { assetTransferMethod: 'eip3009', name: 'Global Dollar', version: '1' },
};

const POLY_ACCEPT: PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:4663',
  amount: '1000000000000000000',
  asset: X402.polydash.address,
  payTo: X402.payTo,
  maxTimeoutSeconds: 120,
  description: 'Token report',
  extra: { assetTransferMethod: 'permit2', name: 'Polydash', version: '1' },
};

test('signX402Payment signs a USDG EIP-3009 authorization that recovers to the payer', async () => {
  const payment = await signX402Payment(USDG_ACCEPT, account);
  assert.equal(payment.x402Version, 2);
  if (!('authorization' in payment.payload)) throw new Error('expected EIP-3009 payload');
  const a = payment.payload.authorization;
  assert.equal(a.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(a.to.toLowerCase(), X402.payTo.toLowerCase());
  assert.equal(a.value, '10000');
  assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: X402.usdg.address as `0x${string}` },
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
      from: a.from as `0x${string}`,
      to: a.to as `0x${string}`,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce as `0x${string}`,
    },
    signature: payment.payload.signature,
  });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test('signX402Payment signs a POLYDASH Permit2 authorization that recovers to the payer', async () => {
  const payment = await signX402Payment(POLY_ACCEPT, account, { nonce: 7n });
  if (!('permit2Authorization' in payment.payload)) throw new Error('expected Permit2 payload');
  const p = payment.payload.permit2Authorization;
  assert.equal(p.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(p.spender.toLowerCase(), X402.permit2Proxy.toLowerCase());
  assert.equal(p.nonce, '7');
  assert.equal(p.witness.to.toLowerCase(), X402.payTo.toLowerCase());
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'Permit2', chainId: 4663, verifyingContract: X402.permit2 as `0x${string}` },
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
      permitted: { token: p.permitted.token as `0x${string}`, amount: BigInt(p.permitted.amount) },
      spender: p.spender as `0x${string}`,
      nonce: BigInt(p.nonce),
      deadline: BigInt(p.deadline),
      witness: { to: p.witness.to as `0x${string}`, validAfter: BigInt(p.witness.validAfter) },
    },
    signature: payment.payload.signature,
  });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test('signX402Payment refuses a payment to the wrong recipient', async () => {
  const wrong = { ...USDG_ACCEPT, payTo: '0x0000000000000000000000000000000000000001' };
  await assert.rejects(() => signX402Payment(wrong, account), (e: unknown) => {
    assert.ok(e instanceof PolypadError);
    assert.equal(e.code, 'invalid_params');
    return true;
  });
});

test('signX402Payment refuses a payment on the wrong network', async () => {
  const wrong = { ...USDG_ACCEPT, network: 'eip155:1' };
  await assert.rejects(() => signX402Payment(wrong, account), PolypadError);
});

test('encodePaymentHeader encodes base64 JSON that decodes back', async () => {
  const payment = await signX402Payment(USDG_ACCEPT, account);
  const header = encodePaymentHeader(payment);
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as typeof payment;
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepted.amount, '10000');
});

test('nextPermit2Nonce returns the first unset bit of the nonce bitmap', async () => {
  const realFetch = globalThis.fetch;
  try {
    // Bitmap with nonces 0 and 1 used (bits 0 and 1 set) → next free is 2.
    const bitmap = `0x${(3n).toString(16).padStart(64, '0')}`;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: bitmap }), { status: 200 })) as typeof fetch;
    assert.equal(await nextPermit2Nonce(account.address, 'https://example.invalid'), 2n);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchWithX402 returns the first response untouched when there is no 402', async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ product: 'token-report' }), { status: 200 });
  }) as (input: string, init: RequestInit) => Promise<Response>;
  const { response, payment } = await fetchWithX402('https://polypad.family/api/x402/products/token-report?address=0x1234', account, { fetch: fetchFn });
  assert.equal(response.status, 200);
  assert.equal(payment, null);
  assert.equal(calls, 1);
});

test('fetchWithX402 signs and retries with the X-PAYMENT header after a 402', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ x402Version: 2, accepts: [USDG_ACCEPT] }), { status: 402 });
    }
    return new Response(JSON.stringify({ product: 'token-report', symbol: 'TEST' }), { status: 200 });
  }) as (input: string, init: RequestInit) => Promise<Response>;
  const { response, payment, accepted } = await fetchWithX402(
    'https://polypad.family/api/x402/products/token-report?address=0x1234',
    account,
    { fetch: fetchFn },
  );
  assert.equal(response.status, 200);
  assert.ok(payment !== null);
  assert.equal(accepted?.amount, '10000');
  const header = (calls[1].init?.headers as Record<string, string>)['x-payment'];
  assert.equal(typeof header, 'string');
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { x402Version: number };
  assert.equal(decoded.x402Version, 2);
});

test('fetchWithX402 throws a clear error when the 402 names no payment option', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ x402Version: 2, accepts: [] }), { status: 402 })) as (
    input: string,
    init: RequestInit,
  ) => Promise<Response>;
  await assert.rejects(
    () => fetchWithX402('https://polypad.family/api/x402/products/token-report?address=0x1234', account, { fetch: fetchFn }),
    PolypadError,
  );
});

test('productUrl builds the token-report URL', () => {
  assert.equal(
    productUrl('token-report', '0x3Da9244DDE38284017fD15e45d1Fdf66D3617B4B'),
    'https://polypad.family/api/x402/products/token-report?address=0x3Da9244DDE38284017fD15e45d1Fdf66D3617B4B',
  );
});

test('productUrl rejects an unknown product', () => {
  assert.throws(() => productUrl('nope' as never, '0x1234'), PolypadError);
});
