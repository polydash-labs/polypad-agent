# Wallet binding — persistent connect-on-/sign token

**Status:** live on the server. The client half is built (this SDK) and the
server half is built (see the evidence below). **Decision (Jon, Nov 18,
2026 — final):** persistent connect-on-`/sign` token. The per-chat
`set_wallet` design was considered and not chosen.

## The model in one paragraph

An agent connects once and Polypad remembers the wallet. The user connects
their wallet on the `/sign` page, signs one short message (not a
transaction — no funds move), and gets a token that lasts 90 days. Later
calls pass the token instead of naming the wallet every time. The per-call
`from` address stays as the underlying transport and the fallback: an
explicit `from` on a call always wins over the binding, and calls work
with no binding at all, exactly as before.

## What the server actually does (ground truth from the code)

- The token is base64url JSON `{ v: 1, address, exp, sig }`, where `sig`
  is the wallet's `personal_sign` signature over a short binding message
  naming the wallet and the expiry date
  (`lib/agents-api/v2/wallet-token-shared.ts`: `bindingMessage`,
  `buildWalletToken`).
- The `/sign?connect=1` page builds the token in the browser after the
  user signs (`app/sign/_components/connect-wallet.tsx`). With a return
  URL it sends the user back with `?walletToken=...&wallet=...`.
- Every prepare call accepts `walletToken` in the call itself
  (`lib/agents-api/v2/tools.ts`: `applyWalletBinding` runs on every
  prepare tool). The server recovers the signer from the signature,
  checks it matches the wallet named in the token and that the token has
  not expired, and uses that wallet as `from`. A token and a different
  `from` on the same call is refused.
- Nothing is stored server-side. The trade-off is honest: a token cannot
  be revoked from the server — it stops working when it expires (90
  days), or when the holder deletes it. It also cannot move funds: it is
  a signature over a binding message, not a transaction, and the API
  still only ever returns unsigned transactions for the user (or the
  agent's own wallet) to sign.
- `polypad_intent` resolves the token the same way, so an agent can ask
  what the user wants without naming the wallet.

## What the SDK does

- `new PolypadClient()` reads the token from `POLYPAD_WALLET_TOKEN`;
  `setWalletToken(token)` / `set_wallet_token(token)` stores one, and
  `walletAddress()` / `wallet_address()` shows which wallet is bound.
  `decodeWalletToken` / `decode_wallet_token` reads the token's wallet
  and expiry without verifying it (verification happens server-side on
  every call).
- `connectUrl()` / `connect_url()` builds the `/sign?connect=1` link to
  show the user. With a `returnUrl`, the page sends them back to it with
  the token after connecting.
- Prepare calls (and `intent`) that leave both `walletToken` and `from`
  out get the stored token attached. An explicit `from` always wins.
- A token is a bearer credential for *preparing* actions only.
  Preparing returns unsigned transactions; nothing can move funds
  without the wallet itself signing, on the `/sign` page or with its own
  key. Treat the token like a password for this one wallet: keep it in
  the agent's own storage, never in a URL or a log, never in a public chat.

## How it composes

- **Sign loop:** unchanged. Prepare → sign → confirm. The binding only
  decides which wallet `from` is when a call does not name one.
  `confirm()` polls `polypad_get_tx_status` by hash, which never needed
  a wallet. After signing, the `/sign` page shows a link back to the
  `returnUrl` with `?tx=<hash>&status=confirmed` added.
- **Agent Accounts / SpendVault:** the owner issues a spending key for
  the *bound wallet address* on `/agents/accounts`. The binding says
  which wallet prepares; the key says what that wallet may spend from
  the vault, inside its caps.
- **x402:** unchanged. A priced read is paid by the wallet that signs
  the payment, which is the bound wallet in the usual case.

## Rejected alternative

Per-chat `set_wallet`: bind a wallet per chat/session, no token stored by
the agent. Rejected by Jon's final call — it would have made every new
chat re-bind the wallet and left framework integrations (LangChain,
Vercel AI SDK) with no durable identity to build on.

## Correction note (Nov 18, 2026)

An earlier draft of this document described a different design: a
server-issued 32-byte token stored server-side, sent as an
`x-polypad-wallet-token` header. That design was never built. The live
server implements the signed-message token described above instead, and
this SDK matches the live server. The header design is dropped, not
kept alongside — there is one binding model.
