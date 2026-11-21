# polypad-agent (Python)

Thin typed client for the Polypad agent API (MCP) on Robinhood Chain. Version 2.0.1.
Published on PyPI: `pip install polypad-agent`.

[polypad.family](https://polypad.family) · [Build guide](https://polypad.family/build) · [GitHub](https://github.com/polydash-labs/polypad-agent) · [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=family.polypad) · [Capability Index](https://capability-index-dhn.pages.dev/?q=polypad)

> Part of [Polydash](https://github.com/polydash-labs/Polydash). If this SDK helps you, please ⭐ the main repo.

## Install

```bash
pip install polypad-agent
```

## Connect once

```python
from polypad_agent import PolypadClient

client = PolypadClient()
# Show the user this URL: they connect their wallet, sign one message, and get a token.
print(client.connect_url(return_url="https://example.com/agent/done"))
# Store the token as POLYPAD_WALLET_TOKEN. The client reads it automatically.
```

## Quickstart

```python
from polypad_agent import PolypadClient

client = PolypadClient()  # reads POLYPAD_WALLET_TOKEN
print(client.list_tokens(sort="new", limit=5))
print(client.quote_trade(token="POLYDASH", side="buy", amountEth="0.01"))
mint = client.prepare_fund_mint(fund="0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", quantity=1)
print(mint["signing"]["url"])  # the user opens this and signs
```

## The loop

```python
# Chat agent: prepare, show the link, wait for the hash, poll until confirmed.
done = client.prepare_sign_confirm(
    "polypad_prepare_fund_mint",
    {"fund": "0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", "quantity": 1},
    on_signing_link=lambda url, summary: print(summary["headline"], url),
    get_tx_hash=read_hash_from_return_callback,
    return_url="https://example.com/agent/done",
)
print(done["status"], done["tx_hash"], done["result"])

# Script with its own wallet (the Forge path): prepare, sign, broadcast, confirm.
launched = client.prepare_sign_broadcast(
    "polypad_prepare_token_launch",
    {"name": "Agent Swarm", "symbol": "SWARM", "creatorFeeBps": 100, "devBuyEth": "0"},
    private_key=os.environ["LAUNCHER_PRIVATE_KEY"],
)
print(launched["status"], launched["tx_hash"])
```

## Pay-per-call

```python
from polypad_agent import pay_for_report

report = pay_for_report(
    "token-report",
    "address=0x3Da9244DDE38284017fD15e45d1Fdf66D3617B4B",
    private_key=os.environ["PAYER_PRIVATE_KEY"],
)
```

## Recipes

- `examples/launch_token.py` — launch a token from a script, then create its staking pool.
- `examples/run_fund.py` — create a tokenized fund, then mint the manager's skin shares.
- `examples/smoke.py` — read-only live smoke test (initialize, tools/list, stats).

## More in the package

- `confirm` / `sign_and_send` / `sign_send_and_confirm` — the standalone sign-loop helpers
  (`confirm` polls `polypad_get_tx_status` until the transaction confirms or fails).
- `sign_x402_payment` / `fetch_with_x402` / `product_url` / `next_permit2_nonce` — x402
  building blocks for USDG (EIP-3009) and POLYDASH (Permit2) payments.
- `build_create_key_tx` / `build_deposit_tx` / `build_withdraw_tx` / `build_revoke_key_tx` /
  `get_key_status` / `get_vault_balance` — SpendVault spending keys.
- `TOOL_NAMES` / `PREPARE_TOOLS` / `is_prepare_tool`, `RATE_LIMITS`, `ACTION_LIMITS`,
  `ERROR_MEANINGS` — the 21 tools, the published limits, and the server's error meanings.

## Tests

```bash
PYTHONPATH=src python -m unittest discover -s tests -v   # 44 tests (mocked transport, no network)
```

Per-call `from` still works: pass it explicitly and the client leaves the token out for that call.
