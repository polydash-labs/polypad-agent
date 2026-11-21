# polypad-agent (TypeScript)

Thin typed client for the Polypad agent API (MCP) on Robinhood Chain. Version 2.1.1.
Published on npm: `npm install polypad-agent`.

[polypad.family](https://polypad.family) · [Build guide](https://polypad.family/build) · [GitHub](https://github.com/polydash-labs/polypad-agent) · [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=family.polypad) · [Capability Index](https://capability-index-dhn.pages.dev/?q=polypad)

> Part of [Polydash](https://github.com/polydash-labs/Polydash). If this SDK helps you, please ⭐ the main repo.

## Install

```bash
npm install polypad-agent
```

## One-command connect (`polypad connect`)

One command wires Polypad's remote MCP server into your AI host — no config
file to write by hand, no account to create. The free tier needs no key.

```bash
npx -y polypad-agent connect claude
```

Or after a global install:

```bash
npm install -g polypad-agent
polypad connect cursor
```

Supported hosts: `claude` (Claude Code), `cursor`, `codex`, `gemini`,
`vscode` (VS Code / Copilot), `grok` (prints the steps — Grok has no local
config file). With a Pro key for higher rate limits:

```bash
polypad connect cursor --key pp_live_...
```

Other forms:

```bash
polypad connect --list        # which hosts are already connected
polypad connect vscode --local # project-level config (claude, cursor, vscode)
polypad connect claude --dry-run
polypad --help
polypad --version
```

After connecting, restart the host and paste a prompt:

- `What tokens launched on Robinhood Chain today?`
- `Start a tokenized fund for me.`

## Connect once

```ts
import { PolypadClient } from "polypad-agent";

const client = new PolypadClient();
// Show the user this URL: they connect their wallet, sign one message, and get a token.
console.log(client.connectUrl({ returnUrl: "https://example.com/agent/done" }));
// Store the token as POLYPAD_WALLET_TOKEN. The client reads it automatically.
```

## Quickstart

```ts
import { PolypadClient } from "polypad-agent";

const client = new PolypadClient(); // reads POLYPAD_WALLET_TOKEN
console.log(await client.listTokens({ sort: "new", limit: 5 }));
console.log(await client.quoteTrade({ token: "POLYDASH", side: "buy", amountEth: "0.01" }));
const mint = await client.prepareFundMint({ fund: "0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", quantity: 1 });
console.log(mint.signing.url); // the user opens this and signs
```

## The loop

```ts
// Chat agent: prepare, show the link, wait for the hash, poll until confirmed.
const done = await client.prepareSignConfirm({
  tool: "polypad_prepare_fund_mint",
  arguments: { fund: "0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", quantity: 1 },
  returnUrl: "https://example.com/agent/done",
  onSigningLink: (url, summary) => console.log(summary.headline, url),
  getTxHash: async () => readHashFromReturnCallback(),
});
console.log(done.status, done.txHash, done.result);

// Script with its own wallet (the Forge path): prepare, sign, broadcast, confirm.
const launched = await client.prepareSignBroadcast({
  tool: "polypad_prepare_token_launch",
  arguments: { name: "Agent Swarm", symbol: "SWARM", creatorFeeBps: 100, devBuyEth: "0" },
  privateKey: process.env.LAUNCHER_PRIVATE_KEY,
});
console.log(launched.status, launched.txHash);
```

## Pay-per-call

```ts
import { payForReport } from "polypad-agent";
import { privateKeyToAccount } from "viem/accounts";

const report = await payForReport({
  product: "token-report",
  query: "address=0x3Da9244DDE38284017fD15e45d1Fdf66D3617B4B",
  account: privateKeyToAccount(process.env.PAYER_PRIVATE_KEY),
});
```

## Recipes

- `examples/launch-token.ts` — launch a token from a script, then create its staking pool.
- `examples/run-fund.ts` — create a tokenized fund, then mint the manager's skin shares.
- `examples/smoke.ts` — read-only live smoke test (initialize, tools/list, stats).

## More in the package

- `confirm` / `signAndSend` / `signSendAndConfirm` — the standalone sign-loop helpers
  (`confirm` polls `polypad_get_tx_status` until the transaction confirms or fails).
- `signX402Payment` / `fetchWithX402` / `productUrl` / `nextPermit2Nonce` — x402 building
  blocks for USDG (EIP-3009) and POLYDASH (Permit2) payments.
- `buildCreateKeyTx` / `buildDepositTx` / `buildWithdrawTx` / `buildRevokeKeyTx` /
  `getKeyStatus` / `getVaultBalance` — SpendVault spending keys.
- `TOOL_NAMES` / `PREPARE_TOOLS` / `isPrepareTool`, `RATE_LIMITS`, `ACTION_LIMITS`,
  `ERROR_MEANINGS` — the 21 tools, the published limits, and the server's error meanings.

## Tests

```bash
npm test   # build + 45 node:test tests (mocked transport, no network)
```

Per-call `from` still works: pass it explicitly and the client leaves the token out for that call.
