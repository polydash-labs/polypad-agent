import test from 'node:test';
import assert from 'node:assert/strict';
import { PolypadClient, PolypadError } from '../index.js';
import { decodeWalletToken, connectUrl } from '../binding.js';
import { TOOL_NAMES, PREPARE_TOOLS } from '../tools.js';

// A token for 0x1111111111111111111111111111111111111111, exp far in the future.
// The signature is not real — decode only reads the envelope, verification is server-side.
const TOKEN = Buffer.from(
  JSON.stringify({
    v: 1,
    address: '0x1111111111111111111111111111111111111111',
    exp: 4102444800,
    sig: `0x${'11'.repeat(65)}`,
  }),
).toString('base64url');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mcpResult(out: unknown, isError = false) {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError } };
}

test('decodeWalletToken reads the bound wallet and expiry', () => {
  const info = decodeWalletToken(TOKEN);
  assert.equal(info?.address, '0x1111111111111111111111111111111111111111');
  assert.equal(info?.expired, false);
  assert.equal(decodeWalletToken('not-a-token'), null);
});

test('decodeWalletToken flags an expired token', () => {
  const old = Buffer.from(JSON.stringify({ v: 1, address: '0x1111111111111111111111111111111111111111', exp: 1000000000, sig: `0x${'11'.repeat(65)}` })).toString('base64url');
  assert.equal(decodeWalletToken(old)?.expired, true);
});

test('connectUrl builds the /sign connect link', () => {
  const url = connectUrl({ returnUrl: 'https://example.com/done' });
  assert.ok(url.startsWith('https://polypad.family/sign?connect=1'));
  assert.ok(url.includes('r=https%3A%2F%2Fexample.com%2Fdone'));
});

test('prepare calls attach the wallet token instead of from', async () => {
  const seen: Record<string, unknown>[] = [];
  const client = new PolypadClient({
    walletToken: TOKEN,
    fetch: (async (input: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return jsonResponse(mcpResult({ ok: true, action: 'fund-mint', signing: { url: 'https://polypad.family/sign?v=1', checksum: 'abc', returnUrl: null, expiresInSeconds: 1200 } }));
    }) as typeof fetch,
  });
  const out = await client.prepareFundMint({ fund: '0x7c1d31629ac68aebe83f230edbc7eacfc26285ef', quantity: 1 });
  assert.equal(out.action, 'fund-mint');
  const args = (seen[0].params as { arguments: Record<string, unknown> }).arguments;
  assert.equal(args.walletToken, TOKEN);
  assert.equal('from' in args, false);
  assert.equal(client.walletAddress(), '0x1111111111111111111111111111111111111111');
});

test('an explicit from is left alone when no token is set', async () => {
  const seen: Record<string, unknown>[] = [];
  const client = new PolypadClient({
    fetch: (async (_input: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return jsonResponse(mcpResult({ ok: true }));
    }) as typeof fetch,
  });
  await client.callTool('polypad_prepare_buy', { token: 'POLYDASH', from: '0x2222222222222222222222222222222222222222', amountEth: '0.01' });
  const args = (seen[0].params as { arguments: Record<string, unknown> }).arguments;
  assert.equal(args.from, '0x2222222222222222222222222222222222222222');
  assert.equal('walletToken' in args, false);
});

test('a tool error becomes a PolypadError with the server code', async () => {
  const client = new PolypadClient({
    fetch: (async () => jsonResponse(mcpResult({ ok: false, error: { code: 'invalid_params', message: 'fund must be a 0x address.' } }, true))) as typeof fetch,
  });
  await assert.rejects(() => client.getFund('nope'), (e: unknown) => e instanceof PolypadError && e.code === 'invalid_params');
});

test('prepareSignConfirm shows the link, then polls until confirmed', async () => {
  const calls: string[] = [];
  let n = 0;
  const client = new PolypadClient({
    walletToken: TOKEN,
    fetch: (async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.params.name);
      n += 1;
      if (body.params.name === 'polypad_prepare_fund_mint') {
        return jsonResponse(mcpResult({
          ok: true, action: 'fund-mint',
          summary: { headline: 'Mint 1 share', lines: [], risks: [] },
          transactions: [],
          signing: { url: 'https://polypad.family/sign?v=1&a=fund-mint', checksum: 'abc', returnUrl: null, expiresInSeconds: 1200 },
          warnings: [],
        }));
      }
      // get_tx_status: pending once, then confirmed.
      const status = n >= 3 ? 'confirmed' : 'pending';
      return jsonResponse(mcpResult({ ok: true, hash: '0xhash', status, result: status === 'confirmed' ? 'Minted 1 share.' : undefined }));
    }) as typeof fetch,
  });
  const links: string[] = [];
  const done = await client.prepareSignConfirm({
    tool: 'polypad_prepare_fund_mint',
    arguments: { fund: '0x7c1d31629ac68aebe83f230edbc7eacfc26285ef', quantity: 1 },
    onSigningLink: (url) => { links.push(url); },
    getTxHash: async () => '0xhash',
    pollIntervalMs: 1,
  });
  assert.equal(done.status, 'confirmed');
  assert.equal(done.txHash, '0xhash');
  assert.equal(done.result, 'Minted 1 share.');
  assert.equal(links[0], 'https://polypad.family/sign?v=1&a=fund-mint');
  assert.deepEqual(calls.slice(0, 1), ['polypad_prepare_fund_mint']);
});

function jsonRpcResult(id: number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
}

function toolsCallReply(result: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
}

function toolsCallErrorReply(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
}

test('TOOL_NAMES exposes all 21 polypad_* tools and 7 prepares', () => {
  assert.equal(TOOL_NAMES.length, 21);
  assert.ok(TOOL_NAMES.every((n) => n.startsWith('polypad_')));
  assert.equal(PREPARE_TOOLS.length, 7);
});

test('listTools lists tools from the server reply', async () => {
  const seen: unknown[] = [];
  const client = new PolypadClient({
    fetch: (async (_input: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return jsonRpcResult(1, { tools: [{ name: 'polypad_stats', description: 'stats', inputSchema: { type: 'object', properties: {} } }] });
    }) as typeof fetch,
  });
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'polypad_stats');
  assert.equal((seen[0] as { method: string }).method, 'tools/list');
});

test('stats() returns structuredContent from a tool call', async () => {
  const client = new PolypadClient({
    fetch: (async () => jsonRpcResult(1, toolsCallReply({ ok: true, total: 3 }))) as typeof fetch,
  });
  assert.deepEqual(await client.stats(), { ok: true, total: 3 });
});

test('a server tool error becomes a PolypadError with the server code, meaning, and retry-after', async () => {
  const client = new PolypadClient({
    fetch: (async () =>
      jsonRpcResult(1, toolsCallErrorReply({ ok: false, error: { code: 'rate_limited', message: 'Too many requests.', retryAfter: 60 } }))) as typeof fetch,
  });
  await assert.rejects(() => client.stats(), (e: unknown) => {
    assert.ok(e instanceof PolypadError);
    assert.equal(e.code, 'rate_limited');
    assert.match(e.meaning ?? '', /Too many requests/);
    assert.equal(e.retryAfterSeconds, 60);
    return true;
  });
});

test('a JSON-RPC error becomes a PolypadError', async () => {
  const client = new PolypadClient({
    fetch: (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool: polypad_nope' } }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(() => client.callTool('polypad_stats', {}), (e: unknown) => {
    assert.ok(e instanceof PolypadError);
    assert.equal(e.code, 'rpc_-32602');
    return true;
  });
});

test('an HTTP error becomes a PolypadError with the status', async () => {
  const client = new PolypadClient({
    fetch: (async () => new Response('Use POST with a JSON-RPC message.', { status: 405 })) as typeof fetch,
  });
  await assert.rejects(() => client.ping(), (e: unknown) => {
    assert.ok(e instanceof PolypadError);
    assert.equal(e.code, 'http_error');
    assert.equal(e.status, 405);
    return true;
  });
});

test('a network failure becomes a PolypadError', async () => {
  const client = new PolypadClient({
    fetch: (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(() => client.ping(), (e: unknown) => {
    assert.ok(e instanceof PolypadError);
    assert.equal(e.code, 'network_error');
    return true;
  });
});

test('x-polypad-client carries the client name', async () => {
  const seen: Record<string, unknown>[] = [];
  const client = new PolypadClient({
    clientName: 'my-agent',
    fetch: (async (_input: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, unknown>);
      return jsonRpcResult(1, {});
    }) as typeof fetch,
  });
  await client.ping();
  assert.equal((seen[0] as Record<string, string>)['x-polypad-client'], 'my-agent');
});

test('key material in a prepare call is refused before anything is sent', async () => {
  let calls = 0;
  const client = new PolypadClient({
    fetch: (async () => {
      calls += 1;
      return jsonRpcResult(1, toolsCallReply({ ok: true }));
    }) as typeof fetch,
  });
  const fakeKey = `0x${'ab'.repeat(32)}`;
  await assert.rejects(
    () => client.prepareBuy({ token: 'POLYDASH', from: fakeKey, amountEth: '0.01' }),
    (e: unknown) => {
      assert.ok(e instanceof PolypadError);
      assert.equal(e.code, 'key_material_rejected');
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('a malformed from address in a prepare call is refused before anything is sent', async () => {
  let calls = 0;
  const client = new PolypadClient({
    fetch: (async () => {
      calls += 1;
      return jsonRpcResult(1, toolsCallReply({ ok: true }));
    }) as typeof fetch,
  });
  await assert.rejects(
    () => client.prepareBuy({ token: 'POLYDASH', from: 'not-an-address', amountEth: '0.01' }),
    (e: unknown) => {
      assert.ok(e instanceof PolypadError);
      assert.equal(e.code, 'invalid_params');
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('initialize returns the server info', async () => {
  const client = new PolypadClient({
    fetch: (async () =>
      jsonRpcResult(1, { protocolVersion: '2025-06-18', serverInfo: { name: 'polypad', version: '2.0.0' }, capabilities: { tools: {} } })) as typeof fetch,
  });
  const info = await client.initialize();
  assert.equal(info.serverInfo.version, '2.0.0');
});

test('the wallet token is also attached to polypad_intent', async () => {
  const seen: Record<string, unknown>[] = [];
  const client = new PolypadClient({
    walletToken: TOKEN,
    fetch: (async (_input: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return jsonResponse(mcpResult({ ok: true }));
    }) as typeof fetch,
  });
  await client.intent({ text: 'buy some POLYDASH' });
  const args = (seen[0].params as { arguments: Record<string, unknown> }).arguments;
  assert.equal(args.walletToken, TOKEN);
});
