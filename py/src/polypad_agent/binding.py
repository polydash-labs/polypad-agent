"""Persistent wallet binding — the token from /sign?connect=1.

Connect once: the user opens the connect URL, signs one message (not a transaction), and gets
a token. The SDK stores it (POLYPAD_WALLET_TOKEN) and passes it instead of a wallet address on
every prepare call. The server recovers the wallet from the signature — no server storage, no
per-call `from`. The token lasts 90 days; after that, connect again.

The token is base64url JSON {v: 1, address, exp, sig}. This module only decodes it (to show
which wallet is bound and when it expires). Verification happens server-side on every call.
"""

import base64
import json
import time

SITE_ORIGIN = "https://polypad.family"


def decode_wallet_token(token: str):
    """Decode a wallet token. Returns None when it is not a token at all."""
    try:
        padded = token.strip() + "=" * (-len(token.strip()) % 4)
        text = base64.urlsafe_b64decode(padded).decode("utf-8")
        parsed = json.loads(text)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    if parsed.get("v") != 1 or not isinstance(parsed.get("address"), str):
        return None
    if not isinstance(parsed.get("exp"), (int, float)) or not isinstance(parsed.get("sig"), str):
        return None
    address = parsed["address"]
    if len(address) != 42 or not address.startswith("0x"):
        return None
    try:
        int(address[2:], 16)
    except ValueError:
        return None
    exp = int(parsed["exp"])
    return {"address": address, "exp": exp, "expired": exp <= int(time.time())}


def connect_url(return_url=None, origin=SITE_ORIGIN):
    """The connect URL to show the user so they can bind a wallet and get a token.

    When return_url is given, the page sends them back to it with
    ?walletToken=...&wallet=... after connecting.
    """
    from urllib.parse import urlencode

    params = {"connect": "1"}
    if return_url:
        params["r"] = return_url
    return f"{origin}/sign?{urlencode(params)}"
