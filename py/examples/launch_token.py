"""Recipe 1 — launch a token from a script (the Forge path).

Forge launches one token a day this way: prepare the launch through the agent API, sign it with
the launcher wallet's own key, broadcast it, and confirm it. The wallet is bound by the token
(POLYPAD_WALLET_TOKEN) — no per-call `from`. The staking pool step calls the factory directly:
there is no MCP tool for staking pools yet.

Run:  POLYPAD_WALLET_TOKEN=... LAUNCHER_PRIVATE_KEY=0x... python examples/launch_token.py

Dry run (prepare only, needs no key — prints the summary and signing link, signs nothing):
  POLYPAD_WALLET_TOKEN=... python examples/launch_token.py --dry-run

The launcher key must be the bound wallet's key — and never the Polypad deployer wallet.
"""

import os
import time

import requests
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_utils import function_signature_to_4byte_selector, to_checksum_address

from polypad_agent import PolypadClient

RPC_URL = "https://robinhood.drpc.org"
STAKING_FACTORY_V2 = "0x4C87aff7009DE1c58E052FEe202349a10b28Be9c"
CHAIN_ID = 4663


def rpc(method, params):
    resp = requests.post(RPC_URL, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    body = resp.json()
    if body.get("error"):
        raise RuntimeError(f"RPC {method} failed: {body['error']}")
    return body["result"]


def call(to, data):
    return rpc("eth_call", [{"to": to, "data": data}, "latest"])


def encode_call(signature, types, args):
    selector = function_signature_to_4byte_selector(signature)
    return "0x" + (selector + abi_encode(types, args)).hex()


def send(account, to, data, value=0):
    nonce = int(rpc("eth_getTransactionCount", [account.address, "pending"]), 16)
    gas_price = int(rpc("eth_gasPrice", []), 16)
    tx = {"chainId": CHAIN_ID, "to": to, "data": data, "value": value,
          "gas": 3000000, "gasPrice": gas_price, "nonce": nonce}
    signed = account.sign_transaction(tx)
    tx_hash = rpc("eth_sendRawTransaction", [signed.raw_transaction.hex()])
    for _ in range(60):
        receipt = rpc("eth_getTransactionReceipt", [tx_hash])
        if receipt:
            return tx_hash, receipt
        time.sleep(2)
    raise RuntimeError(f"No receipt for {tx_hash}")


def main():
    import sys

    dry_run = "--dry-run" in sys.argv
    token = os.environ.get("POLYPAD_WALLET_TOKEN")
    key = os.environ.get("LAUNCHER_PRIVATE_KEY")
    if not token:
        raise SystemExit("Set POLYPAD_WALLET_TOKEN first.")
    if not dry_run and not key:
        raise SystemExit("Set LAUNCHER_PRIVATE_KEY first (or add --dry-run to prepare only).")

    client = PolypadClient(wallet_token=token)
    print("Bound wallet:", client.wallet_address())

    launch_args = {"name": "Agent Swarm", "symbol": "SWARM",
                   "imageUri": "ipfs://bafybeihk6cgm5ndcrmy6cucrqz44xzqxa3sz3vkqmasj6ubfnpai7rwrkm",
                   "description": "Launched by an AI agent on Polypad.",
                   "creatorFeeBps": 100, "devBuyEth": "1000000000000000", "launchDelay": "0"}

    # Dry run: prepare the launch, print the summary and signing link, stop before signing.
    if dry_run:
        prepared = client.prepare_token_launch(**launch_args)
        print()
        print(prepared["summary"]["headline"])
        for line in prepared["summary"]["lines"]:
            print("  " + line)
        print()
        print("Sign here (a person, in their own wallet):", prepared["signing"]["url"])
        print("Dry run done — nothing was signed or sent.")
        return

    # 1. Prepare + sign + broadcast the launch. The 0.001 ETH dev buy funds the staking reward.
    launched = client.prepare_sign_broadcast(
        "polypad_prepare_token_launch", launch_args, private_key=key)
    print("Launch:", launched["status"], launched["tx_hash"], "—", launched["result"])
    token_address = launched["tx_status"].get("newToken")
    if not token_address:
        raise SystemExit("Launch confirmed but no token address came back in the status.")
    print("Token:", token_address)

    # 2. The dev buy's tokens are now in the launcher wallet. Stake all of them: 90 days, 1% fee.
    account = Account.from_key(key)
    token = to_checksum_address(token_address)
    balance = int(call(token, encode_call("balanceOf(address)", ["address"], [account.address])), 16)
    print("Reward tokens:", balance)

    approve_data = encode_call("approve(address,uint256)", ["address", "uint256"], [STAKING_FACTORY_V2, balance])
    approve_hash, _ = send(account, token, approve_data)
    print("Approved factory:", approve_hash)

    pool_data = encode_call(
        "createPool(address,address,uint256,uint256,uint256,uint256,uint256,string,string)",
        ["address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "string", "string"],
        [token, token, balance, 0, 90 * 24 * 3600, 0, 100,
         "SWARM Staking", "Stake SWARM to earn SWARM. Launched by an AI agent on Polypad."],
    )
    pool_hash, pool_receipt = send(account, STAKING_FACTORY_V2, pool_data)
    print("Staking pool:", pool_receipt["status"], pool_hash)


if __name__ == "__main__":
    main()
