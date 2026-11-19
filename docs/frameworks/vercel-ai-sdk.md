# Vercel AI SDK guide — Polypad tools for a Vercel AI SDK agent

Use the `polypad-agent` SDK as Vercel AI SDK tools. The SDK owns the
Polypad-specific parts (typed calls, prepare → sign → confirm, x402
payments, SpendVault keys); the AI SDK owns the agent loop. The wallet
model is the persistent binding: connect once, Polypad remembers the
wallet (see `docs/wallet-binding.md`).

## Install

```bash
npm install polypad-agent ai zod
```

## Wire the client and bind a wallet

```ts
import { PolypadClient } from 'polypad-agent';

// Connect once: the user connects their wallet on polypad.family/sign?connect=1,
// signs one message, and gets a token. Store it as POLYPAD_WALLET_TOKEN.
// From here on, prepare calls leave `from` out and the SDK passes the token instead.
const polypad = new PolypadClient({ clientName: 'my-ai-sdk-agent' }); // reads POLYPAD_WALLET_TOKEN
```

## Expose the tools

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { confirm } from 'polypad-agent';

const tools = {
  polypad_list_tokens: tool({
    description: 'List trending, new, or high-volume token launches on Polypad.',
    parameters: z.object({
      sort: z.enum(['trending', 'new', 'volume']).optional(),
      limit: z.number().optional(),
    }),
    execute: async (args) => polypad.listTokens(args),
  }),

  polypad_prepare_buy: tool({
    description:
      'Prepare a buy of a launch token with ETH. Returns a plain-language summary ' +
      'and a one-tap signing link. Show the summary first, then the link. Never signs.',
    parameters: z.object({ token: z.string(), amountEth: z.string() }),
    // `from` is left out on purpose: the wallet token fills it in.
    execute: async (args) => polypad.prepareBuy(args),
  }),

  polypad_check_tx: tool({
    description: 'Wait for a transaction to confirm or fail, and say what happened in plain words.',
    parameters: z.object({ hash: z.string() }),
    execute: async ({ hash }) => confirm(polypad, hash),
  }),
};
```

## Run the agent

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const { text } = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'List trending tokens on Polypad, then prepare a 0.01 ETH buy of the first one and show me the signing link.',
});
```

## The 5-minute check

Ask the agent, in order: list tokens, quote a trade for one of them,
prepare a mint of a Tokenized Fund share. It should list, quote, and
prepare — then show the signing link and wait. It must not sign anything
itself, and it must never ask for a private key or seed phrase.

## Alternative: connect to the MCP endpoint directly

The Vercel AI SDK can also talk to the MCP server itself (streamable
HTTP, no login) instead of going through this SDK:

```ts
import { experimental_createMCPClient } from 'ai';

const mcp = await experimental_createMCPClient({
  transport: { type: 'http', url: 'https://polypad.family/api/mcp' },
});
const mcpTools = await mcp.tools();
```

Use the direct MCP route when you want the raw tools with no helpers.
Use this SDK when you want the sign loop (`prepare → sign → confirm`),
the x402 payment helper, SpendVault key handling, and the persistent
wallet binding — those are the parts the raw MCP client does not give you.

## Notes

- **Reads are free and keyless.** The MCP has no login and no API key;
  reads run at 120/minute per IP.
- **Prepares are capped.** 30/minute per IP, 12/minute per wallet, at
  most 25 ETH per action, and anything above 1 ETH needs
  `confirmLarge: true` after the user confirms the amount.
- **Signing is the user's.** The human flow is the `/sign` link; the
  scripted flow (`signAndSend`) needs the agent's own wallet key and is
  for dedicated launcher/manager wallets only — never the deployer wallet.
- **Spending keys:** when the bound wallet needs to spend from a vault,
  the owner issues a SpendVault key for that same address on
  `/agents/accounts`. See `spendVaultKeyFlow()` in the SDK.
