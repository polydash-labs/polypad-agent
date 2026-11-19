---
name: use-polypad
description: Use Polypad's MCP tools to trade, launch tokens, and run tokenized funds on Robinhood Chain. Use when the user asks about Polypad, trading, launching a token, starting a fund, or checking a fund or token.
---

# Use Polypad

Polypad is an agent API on Robinhood Chain (chain 4663). Its MCP server gives you 21 tools, all under the `polypad_` prefix. The tools only read data and prepare unsigned transactions — they never sign or move funds. A transaction only happens when a human (or the wallet owner) signs it on Polypad's signing page. Never promise a transaction is done until it is confirmed on-chain; check with `polypad_get_tx_status`.

## What you can do

- **Trade**: `polypad_quote_trade` prices a buy or sell first. `polypad_prepare_buy` / `polypad_prepare_sell` build the unsigned transaction. Always quote before preparing, and show the user the price before asking them to sign.
- **Launch a token**: `polypad_prepare_token_launch` builds the unsigned launch transaction. Ask the user for the name, symbol, and description first.
- **Tokenized funds**: `polypad_list_fund_templates` lists the fund strategies (Strategy #1–#9). `polypad_list_funds` lists live funds, `polypad_get_fund` shows one fund in detail. `polypad_prepare_fund_create` builds the unsigned fund-creation transaction; `polypad_prepare_fund_mint` mints a share (an NFT); `polypad_prepare_fund_redeem` redeems one. A fund's mandate is locked and public, and manager changes wait 2 days before they take effect — say so when describing a fund.
- **NFTs**: `polypad_list_nfts` and `polypad_list_nft_listings` list collections and items for sale; `polypad_prepare_nft_buy` builds the unsigned buy.
- **Read**: `polypad_what_can_i_do` explains the API in plain words. `polypad_intent` turns a sentence into the matching action. `polypad_token_protections` checks a token's holder protections. `polypad_portfolio` shows a wallet's tokens, funds, and stakes. `polypad_stats` gives Polypad totals.

## Rules

- Read first, prepare second, sign last. Never skip the quote step on a trade.
- One action is at most 25 ETH. Above 1 ETH, tell the user to confirm first.
- Keep answers in plain words. Say "tokenized fund", not "fund". Say "strategy", not "template".
- If a tool call fails, read the error message back to the user in plain words and suggest the next step. Do not retry a failed prepare blindly.
- Paid reports (token report $0.01, fund NAV $0.01, CTO report $0.05) are pay-per-call in USDG or POLYDASH — mention the price before calling one.
