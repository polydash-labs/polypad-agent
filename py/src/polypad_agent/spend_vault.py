"""SpendVault spending keys.

How it works (this is how /agents/accounts issues keys — nothing here
invents a format):

- A "spending key" is a wallet *address*, not a secret string. The owner
  deposits USDG or POLYDASH into the SpendVault, then calls ``createKey``
  with the agent's wallet address, the token, a per-payment cap, a daily
  cap, an allowlist of addresses the agent may pay, and an expiry.
- The agent then spends from the vault with that wallet, inside the caps.
  The owner can take the money back any time (``withdraw``) and can revoke
  the key any time (``revokeKey``).
- The key is created by the *owner* in their own wallet (on
  polypad.family/agents/accounts, or with ``build_create_key_tx`` below).
  The agent never holds a secret for the vault — its wallet address is
  the key, and the vault enforces the caps on-chain.

The SDK does not send these transactions for you: each builder returns
the unsigned call (to / data / value) for the owner's wallet to sign.
``get_key_status`` reads a key's live state without a wallet.

Calldata is encoded by hand (stdlib only) — the selectors below were
verified against the on-chain ABI, and the unit tests check the encoding
against viem's output byte for byte.
"""

import re
import time

import requests

from .constants import SPEND_VAULT_ADDRESS, X402
from .errors import PolypadError

# Function selectors (first 4 bytes of keccak of the signature), verified.
_SELECTORS = {
    "deposit(address,uint256)": "47e7ef24",
    "withdraw(address,uint256)": "f3fef3a3",
    "createKey(address,address,uint256,uint256,address[],uint64)": "9d30cddc",
    "revokeKey(address)": "5ae7ab32",
    "balances(address,address)": "c23f001f",
    "keys(address)": "670d14b2",
}

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"


def _require_address(value, field):
    if not isinstance(value, str) or not _ADDRESS_RE.match(value):
        raise PolypadError(f"{field} must be a 0x wallet address.", "invalid_params", extra={"field": field})


def _word(value):
    return int(value).to_bytes(32, "big")


def _address_word(address):
    return bytes.fromhex(address[2:].lower()).rjust(32, b"\x00")


def _token_address(token):
    if token == "USDG":
        return X402["usdg"]["address"]
    if token == "POLYDASH":
        return X402["polydash"]["address"]
    return token


def spend_vault_key_flow():
    """The key flow in plain words — for docs, prompts, and agent instructions."""
    return [
        "The owner opens polypad.family/agents/accounts and connects their own wallet.",
        "The owner deposits USDG or POLYDASH into the SpendVault (the vault holds the money; the agent never holds it).",
        "The owner creates a spending key for the agent wallet address: the token, a per-payment cap, a daily cap, the addresses the agent may pay, and an expiry date.",
        "The agent spends from the vault with that wallet, inside the caps. The vault enforces them on-chain.",
        "The owner can withdraw the money back or revoke the key at any time.",
        "A spending key is a wallet address, not a password or secret. Never share a private key — Polypad never asks for one.",
    ]


def _rpc_call(rpc_url, method, params, session=None):
    session = session or requests.Session()
    response = session.post(rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    response.raise_for_status()
    body = response.json()
    if body.get("error"):
        raise PolypadError(f"Robinhood Chain RPC error: {body['error'].get('message', body['error'])}", "rpc_unavailable")
    return body.get("result")


def get_key_status(key_address, rpc_url=None, session=None):
    """Read a spending key's live state (caps, expiry, revoked, spent today). Returns None when the address has no key."""
    _require_address(key_address, "key_address")
    rpc_url = rpc_url or X402["rpc_url"]
    data = "0x" + _SELECTORS["keys(address)"] + _address_word(key_address).hex()
    result = _rpc_call(rpc_url, "eth_call", [{"to": SPEND_VAULT_ADDRESS, "data": data}, "latest"], session=session)
    raw = bytes.fromhex(result[2:])
    if len(raw) < 288:
        raise PolypadError("The SpendVault answered with a short key record.", "invalid_response")
    words = [int.from_bytes(raw[i * 32 : (i + 1) * 32], "big") for i in range(9)]
    owner = "0x" + raw[0 * 32 + 12 : 0 * 32 + 32].hex()
    token = "0x" + raw[1 * 32 + 12 : 1 * 32 + 32].hex()
    if owner.lower() == ZERO_ADDRESS:
        return None
    return {
        "key": key_address,
        "owner": owner,
        "token": token,
        "per_payment_cap": words[2],
        "daily_cap": words[3],
        "expiry": words[4],
        "revoked": words[5] != 0,
        "spent_today": words[7],
    }


def get_vault_balance(owner, token, rpc_url=None, session=None):
    """Read how much of a token an owner has in the vault."""
    _require_address(owner, "owner")
    token_address = _token_address(token)
    _require_address(token_address, "token")
    rpc_url = rpc_url or X402["rpc_url"]
    data = "0x" + _SELECTORS["balances(address,address)"] + _address_word(owner).hex() + _address_word(token_address).hex()
    result = _rpc_call(rpc_url, "eth_call", [{"to": SPEND_VAULT_ADDRESS, "data": data}, "latest"], session=session)
    return int(result, 16)


def build_create_key_tx(key, token, per_payment_cap, daily_cap, allowlist=None, expiry=None):
    """Unsigned ``createKey`` call for the owner's wallet to sign. The owner signs this — never the agent.

    Args:
        key: The agent's wallet address — this IS the key.
        token: "USDG", "POLYDASH", or a token address.
        per_payment_cap: Largest single payment, in the token's smallest units.
        daily_cap: Largest total per day, in the token's smallest units. Must be at least the per-payment cap.
        allowlist: Addresses the agent may pay. Defaults to [].
        expiry: Expiry as a Unix timestamp (seconds). Must be in the future.
    """
    _require_address(key, "key")
    token_address = _token_address(token)
    _require_address(token_address, "token")
    if per_payment_cap <= 0 or daily_cap <= 0:
        raise PolypadError("Caps must be above zero.", "invalid_params")
    if per_payment_cap > daily_cap:
        raise PolypadError("The per-payment cap cannot be larger than the daily cap.", "invalid_params")
    if expiry is None or expiry * 1000 <= int(time.time() * 1000):
        raise PolypadError("The expiry must be in the future.", "invalid_params")
    allowlist = allowlist or []
    for i, address in enumerate(allowlist):
        _require_address(address, f"allowlist[{i}]")
    # Head: 6 words (key, token, perPaymentCap, dailyCap, allowlist offset, expiry).
    # The allowlist is dynamic, so its offset points past the head (6 * 32 = 192).
    head = b"".join(
        [
            _address_word(key),
            _address_word(token_address),
            _word(per_payment_cap),
            _word(daily_cap),
            _word(192),
            _word(expiry),
        ]
    )
    tail = _word(len(allowlist)) + b"".join(_address_word(a) for a in allowlist)
    data = "0x" + _SELECTORS["createKey(address,address,uint256,uint256,address[],uint64)"] + (head + tail).hex()
    return {
        "to": SPEND_VAULT_ADDRESS,
        "data": data,
        "value": "0",
        "chainId": 4663,
        "description": f"Create a spending key for {key} (token {token_address}, per-payment cap {per_payment_cap}, daily cap {daily_cap}).",
    }


def build_deposit_tx(token, amount):
    """Unsigned ``deposit`` call for the owner's wallet to sign. Approve the vault to take the tokens first."""
    token_address = _token_address(token)
    _require_address(token_address, "token")
    if amount <= 0:
        raise PolypadError("Deposit amount must be above zero.", "invalid_params")
    data = "0x" + _SELECTORS["deposit(address,uint256)"] + _address_word(token_address).hex() + _word(amount).hex()
    return {
        "to": SPEND_VAULT_ADDRESS,
        "data": data,
        "value": "0",
        "chainId": 4663,
        "description": f"Deposit {amount} of {token_address} into the SpendVault.",
    }


def build_withdraw_tx(token, amount):
    """Unsigned ``withdraw`` call for the owner's wallet to sign — takes money back out of the vault."""
    token_address = _token_address(token)
    _require_address(token_address, "token")
    if amount <= 0:
        raise PolypadError("Withdraw amount must be above zero.", "invalid_params")
    data = "0x" + _SELECTORS["withdraw(address,uint256)"] + _address_word(token_address).hex() + _word(amount).hex()
    return {
        "to": SPEND_VAULT_ADDRESS,
        "data": data,
        "value": "0",
        "chainId": 4663,
        "description": f"Withdraw {amount} of {token_address} from the SpendVault.",
    }


def build_revoke_key_tx(key):
    """Unsigned ``revokeKey`` call for the owner's wallet to sign — the agent can no longer spend."""
    _require_address(key, "key")
    data = "0x" + _SELECTORS["revokeKey(address)"] + _address_word(key).hex()
    return {
        "to": SPEND_VAULT_ADDRESS,
        "data": data,
        "value": "0",
        "chainId": 4663,
        "description": f"Revoke the spending key for {key}.",
    }
