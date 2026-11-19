# polypad-agent — SDKs for the Polypad agent API

Thin typed clients for the Polypad agent API (MCP) on Robinhood Chain, versioned with the server
(2.0.0). Two packages, one repo:

- `ts/` — TypeScript (`polypad-agent` on npm, once published)
- `py/` — Python (`polypad-agent` on PyPI, once published)

Both wrap the same API: reads, prepares, the **prepare → sign → confirm** loop, persistent wallet
binding, x402 pay-per-call, and SpendVault spending keys.

## Wallet binding: connect once

The agent API is keyless, but a prepare call needs to know which wallet will sign. The old way is
a per-call `from` address. The SDKs use the new way instead:

1. The user opens the connect URL — `PolypadClient.connectUrl()` gives you
   `https://polypad.family/sign?connect=1` — connects their wallet, and signs **one message**
   (not a transaction, no funds move).
2. The page shows a token. Store it as `POLYPAD_WALLET_TOKEN`.
3. Every prepare call after that passes the token instead of `from`. The server recovers the
   wallet from the signature. The token lasts 90 days; after that, connect again.

Per-call `from` still works as the fallback: pass it explicitly and the client leaves the token
out for that call. If both are passed they must name the same wallet. A token cannot be revoked
from the server — it stops working when it expires, or when the holder deletes it.

## Quickstart (TypeScript)

```ts
import { PolypadClient } from "polypad-agent";

const client = new PolypadClient(); // reads POLYPAD_WALLET_TOKEN
console.log(await client.listTokens({ sort: "new", limit: 5 }));
console.log(await client.quoteTrade({ token: "POLYDASH", side: "buy", amountEth: "0.01" }));
const mint = await client.prepareFundMint({ fund: "0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", quantity: 1 });
console.log(mint.summary.headline);
console.log(mint.signing.url); // the user opens this and signs
```

## Quickstart (Python)

```python
from polypad_agent import PolypadClient

client = PolypadClient()  # reads POLYPAD_WALLET_TOKEN
print(client.list_tokens(sort="new", limit=5))
print(client.quote_trade(token="POLYDASH", side="buy", amountEth="0.01"))
mint = client.prepare_fund_mint(fund="0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", quantity=1)
print(mint["summary"]["headline"])
print(mint["signing"]["url"])  # the user opens this and signs
```

## The loop: prepare → sign → confirm

An action is not done when it is prepared, and not done when it is signed — it is done when the
agent knows the result. Both SDKs have the same two helpers:

- **Chat agent** — `prepareSignConfirm` / `prepare_sign_confirm`: prepares, hands the signing
  link to your `onSigningLink` callback for the user to open, waits for the transaction hash (from
  the `returnUrl` callback, or the user pasting it back), then polls `polypad_get_tx_status` until
  the chain confirms it.
- **Script with its own wallet** — `prepareSignBroadcast` / `prepare_sign_broadcast`: prepares,
  signs and sends each step with the script's own key, waits for each step's receipt before the
  next, then polls for the final result. This is the Forge path. The signing key must be the bound
  wallet — never the Polypad deployer wallet.

Both recipes live in `ts/examples/` and `py/examples/`:

- `launch-token` — launch a token from a script, then create its staking pool (Forge path).
- `run-fund` — create a tokenized fund, then mint the manager's skin shares.

## Pay-per-call (x402)

`payForReport` / `pay_for_report` fetches a priced report — token report $0.01, Tokenized Fund NAV $0.01,
CTO report $0.05 — paying with USDG (EIP-3009). Ask, get a 402 with the price, sign, send it back
in the `X-PAYMENT` header. The server only settles after the report is built. The building blocks
are there too: `signX402Payment` / `sign_x402_payment` and `fetchWithX402` / `fetch_with_x402`
also pay with POLYDASH (Permit2), and refuse a payment to the wrong recipient before signing.

## SpendVault spending keys

`buildCreateKeyTx` / `build_create_key_tx` (and deposit / withdraw / revoke) build the unsigned
calls an owner signs to give an agent wallet a spending key — a wallet address with a per-payment
cap, a daily cap, an allowlist, and an expiry. `getKeyStatus` / `get_key_status` reads a key's
live state. The SDK never sends these transactions; the owner signs them.

## Docs

- `docs/wallet-binding.md` — the persistent token model, exactly as the live server implements it.
- `docs/frameworks/langchain.md` and `docs/frameworks/vercel-ai-sdk.md` — framework guides.

## Publish status

The packages are built, tested (45 TypeScript tests, 44 Python tests — all mocked, no network),
and versioned — but **not yet published** to npm or PyPI. Until they are, install from this repo:

- TypeScript: `cd ts && npm install && npm run build`
- Python: `pip install -e py/`

Publishing as `polypad-agent` (npm + PyPI) is the next step and needs Jon's go-ahead. Full docs:
https://polypad.family/docs/sdks
