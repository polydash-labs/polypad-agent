# LangChain guide — Polypad tools for a LangChain agent

Use the `polypad-agent` SDK as LangChain tools. The SDK owns the
Polypad-specific parts (typed calls, prepare → sign → confirm, x402
payments, SpendVault keys); LangChain owns the agent loop. The wallet
model is the persistent binding: connect once, Polypad remembers the
wallet (see `docs/wallet-binding.md`).

## Install

```bash
npm install polypad-agent langchain @langchain/core zod
```

## Wire the client and bind a wallet

```ts
import { PolypadClient } from 'polypad-agent';

// Connect once: the user connects their wallet on polypad.family/sign?connect=1,
// signs one message, and gets a token. Store it as POLYPAD_WALLET_TOKEN.
// From here on, prepare calls leave `from` out and the SDK passes the token instead.
const polypad = new PolypadClient({ clientName: 'my-langchain-agent' }); // reads POLYPAD_WALLET_TOKEN
```

## Expose the tools

Wrap the calls your agent needs as LangChain structured tools. Reads
run directly; prepares return a signing link and stop — the agent never
signs on its own unless you give it a wallet key and call `signAndSend`
(the Forge path).

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { confirm } from 'polypad-agent';

const listTokens = new DynamicStructuredTool({
  name: 'polypad_list_tokens',
  description: 'List trending, new, or high-volume token launches on Polypad.',
  schema: z.object({ sort: z.enum(['trending', 'new', 'volume']).optional(), limit: z.number().optional() }),
  func: async (args) => JSON.stringify(await polypad.listTokens(args)),
});

const prepareBuy = new DynamicStructuredTool({
  name: 'polypad_prepare_buy',
  description:
    'Prepare a buy of a launch token with ETH. Returns a plain-language summary ' +
    'and a one-tap signing link. Show the summary first, then the link. Never signs.',
  schema: z.object({ token: z.string(), amountEth: z.string() }),
  func: async (args) => JSON.stringify(await polypad.prepareBuy(args)),
  // `from` is left out on purpose: the wallet token fills it in.
});

const checkTx = new DynamicStructuredTool({
  name: 'polypad_check_tx',
  description: 'Wait for a transaction to confirm or fail, and say what happened in plain words.',
  schema: z.object({ hash: z.string() }),
  func: async ({ hash }) => JSON.stringify(await confirm(polypad, hash)),
});
```

## Run the agent

```ts
import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: 'gpt-4o', temperature: 0 }),
  tools: [listTokens, prepareBuy, checkTx],
});
```

## The 5-minute check

Ask the agent, in order: list tokens, quote a trade for one of them,
prepare a mint of a Tokenized Fund share. It should list, quote, and
prepare — then show the signing link and wait. It must not sign anything
itself, and it must never ask for a private key or seed phrase.

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
