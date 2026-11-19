"""x402 pay-per-call: pay a few cents for a priced report (token report $0.01, Tokenized Fund NAV $0.01,
CTO report $0.05) with USDG (EIP-3009). The flow is the x402 v2 one: ask, get a 402 with the
price, sign the authorization, send it back in the X-PAYMENT header. The server only settles
after the report is built — if the report cannot be built, nothing is charged.

Everything the signature needs comes from the 402 answer itself (asset, pay-to, domain name and
version), so nothing about the payment is hardcoded here except the chain (4663) and the EIP-3009
type shape.
"""

import base64
import json
import os
import secrets
import time

import requests
from eth_account import Account
from eth_account.messages import encode_typed_data

SITE_ORIGIN = "https://polypad.family"
CHAIN_ID = 4663

_EIP3009_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ]
}


def pay_for_report(product, query, private_key, origin=SITE_ORIGIN, session=None):
    """Fetch a priced report, paying with USDG from the given key.

    `query` is the report's query string, for example "address=0x..." for a token report.
    Returns the report JSON.
    """
    sess = session or requests.Session()
    account = Account.from_key(private_key)
    url = f"{origin}/api/x402/products/{product}?{query}"

    ask = sess.get(url, timeout=30)
    if ask.status_code == 200:
        return ask.json()
    if ask.status_code != 402:
        raise RuntimeError(f"Report endpoint answered HTTP {ask.status_code}.")
    accepts = ask.json().get("accepts") or []
    requirement = next((r for r in accepts if (r.get("extra") or {}).get("assetTransferMethod") == "eip3009"), None)
    if requirement is None:
        raise RuntimeError("The report does not offer a USDG (EIP-3009) payment option.")

    now = int(time.time())
    nonce = "0x" + secrets.token_hex(32)
    authorization = {
        "from": account.address,
        "to": requirement["payTo"],
        "value": requirement["amount"],
        "validAfter": "0",
        "validBefore": str(now + requirement["maxTimeoutSeconds"]),
        "nonce": nonce,
    }
    extra = requirement.get("extra") or {}
    domain = {
        "name": extra.get("name", "Global Dollar"),
        "version": extra.get("version", "1"),
        "chainId": CHAIN_ID,
        "verifyingContract": requirement["asset"],
    }
    message = encode_typed_data(domain, _EIP3009_TYPES, authorization)
    signature = account.sign_message(message).signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature
    payment = base64.b64encode(json.dumps(
        {"x402Version": 2, "accepted": requirement,
         "payload": {"signature": signature, "authorization": authorization}}
    ).encode()).decode()
    paid = sess.get(url, headers={"X-PAYMENT": payment}, timeout=30)
    if paid.status_code != 200:
        raise RuntimeError(f"Paid report request answered HTTP {paid.status_code}.")
    return paid.json()


# ---- Building blocks: sign a payment yourself (USDG or POLYDASH) -----------

from .constants import X402, x402_product
from .errors import PolypadError

# Function selector for Permit2 nonceBitmap(address,uint256), verified against eth-utils keccak.
_NONCE_BITMAP_SELECTOR = "0x4fe02b44"


def _encode_address_word(address):
    return bytes.fromhex(address[2:].lower()).rjust(32, b"\x00")


def _rpc_call(rpc_url, method, params, session=None):
    session = session or requests.Session()
    response = session.post(rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    response.raise_for_status()
    body = response.json()
    if body.get("error"):
        raise PolypadError(f"Robinhood Chain RPC error: {body['error'].get('message', body['error'])}", "rpc_unavailable")
    return body.get("result")


def next_permit2_nonce(owner, rpc_url=None, session=None):
    """The next unused Permit2 nonce for a wallet.

    Permit2 tracks used nonces in 256-bit words; the first unset bit in
    the lowest word is the next free nonce. A payment signed with an
    already-used nonce is rejected, so never reuse a nonce.
    """
    rpc_url = rpc_url or X402["rpc_url"]
    for word in range(4):
        data = _NONCE_BITMAP_SELECTOR + _encode_address_word(owner).hex() + word.to_bytes(32, "big").hex()
        result = _rpc_call(rpc_url, "eth_call", [{"to": X402["permit2"], "data": "0x" + data}, "latest"], session=session)
        bitmap = int(result, 16) if result else 0
        for bit in range(256):
            if not (bitmap >> bit) & 1:
                return word * 256 + bit
    raise PolypadError("No free Permit2 nonce found in the first 1,024 nonces for this wallet.", "invalid_params")


def _sign_typed_data(account, full_message):
    try:
        from eth_account.messages import encode_typed_data
    except ImportError as exc:
        raise PolypadError(
            'Signing needs eth-account: pip install "polypad-agent[signing]".',
            "invalid_params",
        ) from exc
    encoded = encode_typed_data(full_message=full_message)
    return account.sign_message(encoded).signature


def sign_x402_payment(accepted, account, nonce=None, rpc_url=None, timeout_seconds=None):
    """Sign a payment for one ``accepts`` entry from a 402 reply.

    Returns the full x402 v2 payload — pass it to ``encode_payment_header``
    and send it as the ``X-PAYMENT`` header. The payment is checked before
    signing: a wrong recipient, wrong network, wrong token, or zero amount
    is refused.
    """
    if accepted.get("scheme") != "exact" or accepted.get("network") != X402["network"]:
        raise PolypadError(
            f"Unsupported payment requirement: {accepted.get('scheme')} on {accepted.get('network')}. "
            "This SDK pays x402 v2 exact payments on eip155:4663 only.",
            "invalid_params",
        )
    if accepted.get("payTo", "").lower() != X402["pay_to"].lower():
        raise PolypadError(f"Refused: this payment goes to {accepted.get('payTo')}, not the Polypad fee wallet.", "invalid_params")
    amount = int(accepted["amount"])
    if amount <= 0:
        raise PolypadError("Refused: the payment amount is zero.", "invalid_params")
    now = int(time.time())
    timeout = timeout_seconds if timeout_seconds is not None else accepted.get("maxTimeoutSeconds") or X402["max_timeout_seconds"]
    valid_after = now
    valid_before = now + timeout

    method = (accepted.get("extra") or {}).get("assetTransferMethod")
    if method == "eip3009":
        if accepted["asset"].lower() != X402["usdg"]["address"].lower():
            raise PolypadError(f"Refused: EIP-3009 payment for an unexpected token {accepted['asset']}.", "invalid_params")
        # EIP-3009 nonces are random 32-byte values, one use each.
        nonce_bytes = secrets.token_bytes(32)
        signature = _sign_typed_data(
            account,
            {
                "domain": {
                    "name": X402["usdg"]["eip712"]["name"],
                    "version": X402["usdg"]["eip712"]["version"],
                    "chainId": X402["chain_id"],
                    "verifyingContract": X402["usdg"]["address"],
                },
                "types": {
                    "TransferWithAuthorization": [
                        {"name": "from", "type": "address"},
                        {"name": "to", "type": "address"},
                        {"name": "value", "type": "uint256"},
                        {"name": "validAfter", "type": "uint256"},
                        {"name": "validBefore", "type": "uint256"},
                        {"name": "nonce", "type": "bytes32"},
                    ]
                },
                "primaryType": "TransferWithAuthorization",
                "message": {
                    "from": account.address,
                    "to": accepted["payTo"],
                    "value": amount,
                    "validAfter": valid_after,
                    "validBefore": valid_before,
                    "nonce": nonce_bytes,
                },
            },
        )
        return {
            "x402Version": 2,
            "accepted": accepted,
            "payload": {
                "signature": "0x" + signature.hex(),
                "authorization": {
                    "from": account.address,
                    "to": accepted["payTo"],
                    "value": str(amount),
                    "validAfter": str(valid_after),
                    "validBefore": str(valid_before),
                    "nonce": "0x" + nonce_bytes.hex(),
                },
            },
        }

    if method == "permit2":
        if accepted["asset"].lower() != X402["polydash"]["address"].lower():
            raise PolypadError(f"Refused: Permit2 payment for an unexpected token {accepted['asset']}.", "invalid_params")
        if nonce is None:
            nonce = next_permit2_nonce(account.address, rpc_url)
        signature = _sign_typed_data(
            account,
            {
                "domain": {"name": "Permit2", "chainId": X402["chain_id"], "verifyingContract": X402["permit2"]},
                "types": {
                    "PermitWitnessTransferFrom": [
                        {"name": "permitted", "type": "TokenPermissions"},
                        {"name": "spender", "type": "address"},
                        {"name": "nonce", "type": "uint256"},
                        {"name": "deadline", "type": "uint256"},
                        {"name": "witness", "type": "Witness"},
                    ],
                    "TokenPermissions": [
                        {"name": "token", "type": "address"},
                        {"name": "amount", "type": "uint256"},
                    ],
                    "Witness": [
                        {"name": "to", "type": "address"},
                        {"name": "validAfter", "type": "uint256"},
                    ],
                },
                "primaryType": "PermitWitnessTransferFrom",
                "message": {
                    "permitted": {"token": accepted["asset"], "amount": amount},
                    "spender": X402["permit2_proxy"],
                    "nonce": nonce,
                    "deadline": valid_before,
                    "witness": {"to": accepted["payTo"], "validAfter": valid_after},
                },
            },
        )
        return {
            "x402Version": 2,
            "accepted": accepted,
            "payload": {
                "signature": "0x" + signature.hex(),
                "permit2Authorization": {
                    "permitted": {"token": accepted["asset"], "amount": str(amount)},
                    "from": account.address,
                    "spender": X402["permit2_proxy"],
                    "nonce": str(nonce),
                    "deadline": str(valid_before),
                    "witness": {"to": accepted["payTo"], "validAfter": str(valid_after)},
                },
            },
        }

    raise PolypadError(f"Unsupported payment method: {method}.", "invalid_params")


def encode_payment_header(payment):
    """The ``X-PAYMENT`` header value for a signed payment: base64 JSON."""
    return base64.b64encode(json.dumps(payment).encode("utf-8")).decode("ascii")


def fetch_with_x402(url, account, asset="USDG", session=None, timeout=30, nonce=None, rpc_url=None):
    """GET a priced Polypad read with x402 payment handled for you.

    Requests, gets a 402 with the price, signs the payment, retries with
    the ``X-PAYMENT`` header. Returns ``{"response", "payment", "accepted"}``.
    ``url`` is the full product URL — use ``product_url()`` to build it.
    """
    session = session or requests.Session()
    first = session.get(url, timeout=timeout)
    if first.status_code != 402:
        return {"response": first, "payment": None, "accepted": None}
    try:
        body = first.json()
    except ValueError as exc:
        raise PolypadError("The priced read answered 402 with something that was not JSON.", "invalid_response") from exc
    accepts = body.get("accepts") or []
    if not accepts:
        raise PolypadError("The priced read answered 402 but named no payment option.", "invalid_response")
    wanted_address = X402["usdg"]["address"] if asset == "USDG" else X402["polydash"]["address"]
    accepted = next((a for a in accepts if a.get("asset", "").lower() == wanted_address.lower()), accepts[0])
    payment = sign_x402_payment(accepted, account, nonce=nonce, rpc_url=rpc_url)
    second = session.get(url, headers={"x-payment": encode_payment_header(payment)}, timeout=timeout)
    return {"response": second, "payment": payment, "accepted": accepted}


def product_url(product_id, address):
    """Build the URL for a priced read: product id plus the one address it needs."""
    product = x402_product(product_id)
    if product is None:
        raise PolypadError(f"Unknown x402 product: {product_id}.", "invalid_params")
    from urllib.parse import quote

    return f"https://polypad.family{product['endpoint']}?{product['query_param']}={quote(address, safe='')}"
