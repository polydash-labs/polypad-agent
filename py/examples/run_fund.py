"""Recipe 2 — run a tokenized fund from an agent.

The manager's agent creates the fund, then mints the manager's own skin shares — both through
the agent API, signed with the manager wallet's own key, confirmed through the API. The wallet
is bound by the token (POLYPAD_WALLET_TOKEN) — no per-call `from`. After this, investors mint
through the same prepare → sign → confirm loop (see the chat-agent helper), and the manager
invests under the strategy's limits.

Run:  POLYPAD_WALLET_TOKEN=... MANAGER_PRIVATE_KEY=0x... python examples/run_fund.py

The manager key must be the bound wallet's key — and never the Polypad deployer wallet.
Strategy #6 is the LP-Dividend strategy: the Tokenized Fund buys POLYDASH, adds POLYDASH/WETH liquidity,
and pays the fees back to share holders. No guaranteed returns.
"""

import json
import os

from polypad_agent import PolypadClient


def main():
    token = os.environ.get("POLYPAD_WALLET_TOKEN")
    key = os.environ.get("MANAGER_PRIVATE_KEY")
    if not token or not key:
        raise SystemExit("Set POLYPAD_WALLET_TOKEN and MANAGER_PRIVATE_KEY first.")

    client = PolypadClient(wallet_token=token)
    print("Bound wallet (manager):", client.wallet_address())

    # 0. List the published Strategies first, so the choice is explicit — Strategy #6 below
    # is the LP-Dividend strategy the Tokenized Fund is created from.
    strategies = client.list_fund_templates()
    print("Strategies:", json.dumps(strategies)[:1200])

    # 1. Create the fund: Strategy #6, 0.01 ETH a share, 2 ETH raise cap, 7-day raise.
    created = client.prepare_sign_broadcast(
        "polypad_prepare_fund_create",
        {"templateId": 6, "name": "Polydash Growth Fund", "symbol": "PDGFUND",
         "mintPriceEth": "0.01", "raiseCapEth": "2", "raiseDurationDays": 7},
        private_key=key,
    )
    print("Fund created:", created["status"], created["tx_hash"], "—", created["result"])
    fund = created["tx_status"].get("newFund")
    if not fund:
        raise SystemExit("Tokenized Fund created but no fund address came back in the status.")
    print("Fund:", fund)

    # 2. Mint the manager's skin shares (Strategy #6 needs 5% before anyone else can mint).
    skin = (created["prepared"].get("extra") or {}).get("managerSkin") or {}
    shares = int(skin.get("shares", 10))
    minted = client.prepare_sign_broadcast(
        "polypad_prepare_fund_mint", {"fund": fund, "quantity": shares}, private_key=key)
    print(f"Skin minted ({shares} shares):", minted["status"], minted["tx_hash"], "—", minted["result"])
    print("Raise is open. Investors mint with polypad_prepare_fund_mint; the manager invests after it closes.")


if __name__ == "__main__":
    main()
