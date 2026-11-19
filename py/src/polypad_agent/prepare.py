"""The sign loop: prepare → sign → confirm.

Polypad is non-custodial, so signing always happens outside the API:

1. **Prepare** — a ``prepare_*`` tool returns unsigned transactions plus a
   one-tap ``/sign`` link. Show the summary first, then the link.
2. **Sign** — either a person opens the link and signs in their own
   wallet on polypad.family/sign, or a script signs the steps itself
   with its own wallet (the Forge path — see ``sign_and_send``).
3. **Confirm** — ``confirm()`` polls ``polypad_get_tx_status`` until the
   transaction confirms or fails.

Wallet model: the agent connects once on /sign?connect=1 and gets a
token; prepare calls pass ``walletToken`` instead of a per-call ``from``
(see binding.py). The per-call ``from`` address is the underlying
transport and fallback: every prepare call still names the wallet that
will sign, and the /sign page rebuilds the action for whichever wallet
connects there.
"""

import re
import time

from .constants import EXPLORER, X402
from .errors import PolypadConfirmTimeoutError, PolypadError, PolypadTxFailedError

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_HEX_RE = re.compile(r"^0x[0-9a-fA-F]*$")


def confirm(client, tx_hash, timeout_ms=120_000, interval_ms=3_000):
    """Poll ``polypad_get_tx_status`` until the transaction confirms or fails.

    - ``pending`` → keep polling.
    - ``tx_not_found`` (404) → the chain has not seen the hash yet; keep
      polling until the timeout, because a just-sent transaction can take a
      few seconds to appear.
    - ``confirmed`` → returns the status, with its plain-language ``result``.
    - ``failed`` → raises PolypadTxFailedError.
    - Nothing final before ``timeout_ms`` → raises PolypadConfirmTimeoutError.
      A timeout does NOT mean the transaction failed — check the explorer
      link in the error before sending anything again.
    """
    timeout_s = timeout_ms / 1000.0
    interval_s = interval_ms / 1000.0
    started = time.monotonic()
    explorer_url = f"{EXPLORER}/tx/{tx_hash}"
    while True:
        try:
            status = client.get_tx_status(tx_hash)
        except PolypadError as exc:
            if exc.code == "tx_not_found":
                if time.monotonic() - started > timeout_s:
                    raise PolypadConfirmTimeoutError(tx_hash, timeout_ms, explorer_url) from exc
                time.sleep(interval_s)
                continue
            raise
        if status.get("status") == "confirmed":
            return status
        if status.get("status") == "failed":
            raise PolypadTxFailedError(
                tx_hash, status.get("result") or "The transaction was mined but failed. No state changed except gas spent."
            )
        if time.monotonic() - started > timeout_s:
            raise PolypadConfirmTimeoutError(tx_hash, timeout_ms, explorer_url)
        time.sleep(interval_s)


def _rpc(session, rpc_url, method, params):
    import requests

    response = session.post(rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    response.raise_for_status()
    body = response.json()
    if body.get("error"):
        raise PolypadError(f"Robinhood Chain RPC error: {body['error'].get('message', body['error'])}", "rpc_unavailable")
    return body.get("result")


def _wait_receipt(session, rpc_url, tx_hash, timeout_ms=120_000):
    started = time.monotonic()
    while time.monotonic() - started < timeout_ms / 1000.0:
        receipt = _rpc(session, rpc_url, "eth_getTransactionReceipt", [tx_hash])
        if receipt is not None:
            return receipt
        time.sleep(2)
    raise PolypadConfirmTimeoutError(tx_hash, timeout_ms, f"{EXPLORER}/tx/{tx_hash}")


def sign_and_send(prepared, account, rpc_url=None, wait_between_steps=True, step_timeout_ms=120_000, session=None):
    """Sign every step of a prepared action with your own wallet and send them, in order — the path Forge uses to launch a token from a script.

    ``account`` is an eth-account account (for example from
    ``eth_account.Account.from_key(...)`` — needs the ``signing`` extra:
    ``pip install "polypad-agent[signing]"``). The key stays in your
    process; it is never sent to Polypad. Each step is checked before it
    is sent: it must be for Robinhood Chain (4663), its ``from`` must
    match your wallet, and its ``to`` must be an address the API returned
    for this action. Steps are sent one at a time, and each step's receipt
    is awaited before the next step is sent (unless ``wait_between_steps``
    is False) — the same order the /sign page uses.

    Returns the transaction hash of every step sent. If a step fails, the
    error is raised and no later step is sent.
    """
    import requests

    rpc_url = rpc_url or X402["rpc_url"]
    session = session or requests.Session()
    steps = prepared.get("transactions") or []

    allowed_targets = {step["to"].lower() for step in steps}

    def collect(value):
        if isinstance(value, str) and _ADDRESS_RE.match(value):
            allowed_targets.add(value.lower())
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)

    rest = {k: v for k, v in prepared.items() if k not in ("transactions", "signing")}
    collect(rest)

    sent = []
    for step in steps:
        if step.get("chainId") != 4663:
            raise PolypadError(f"Refused: step {step['step']} is not for Robinhood Chain (chain id 4663).", "invalid_params")
        if step.get("from", "").lower() != account.address.lower():
            raise PolypadError(f"Refused: step {step['step']} was built for a different wallet ({step.get('from')}).", "invalid_params")
        if step.get("to", "").lower() not in allowed_targets:
            raise PolypadError(f"Refused: step {step['step']} sends to an address the API did not return for this action.", "invalid_params")
        if not _HEX_RE.match(step.get("data", "")) or not re.match(r"^\d{1,40}$", str(step.get("value", ""))):
            raise PolypadError(f"Refused: step {step['step']} is malformed.", "invalid_params")

        nonce = int(_rpc(session, rpc_url, "eth_getTransactionCount", [account.address, "pending"]), 16)
        gas_price = int(_rpc(session, rpc_url, "eth_gasPrice", []), 16)
        gas = int(step["gas"]) if step.get("gas") else int(
            _rpc(
                session,
                rpc_url,
                "eth_estimateGas",
                [{"from": account.address, "to": step["to"], "data": step["data"], "value": hex(int(step["value"]))}],
            ),
            16,
        )
        tx = {
            "chainId": 4663,
            "to": step["to"],
            "data": step["data"],
            "value": int(step["value"]),
            "gas": gas,
            "gasPrice": gas_price,
            "nonce": nonce,
        }
        signed = account.sign_transaction(tx)
        tx_hash = _rpc(session, rpc_url, "eth_sendRawTransaction", [signed.raw_transaction.hex()])
        sent.append({"step": step["step"], "hash": tx_hash})
        is_last = step["step"] == len(steps)
        if wait_between_steps and not is_last:
            receipt = _wait_receipt(session, rpc_url, tx_hash, timeout_ms=step_timeout_ms)
            if receipt.get("status") != "0x1":
                raise PolypadTxFailedError(tx_hash, f"Step {step['step']} failed on-chain. Nothing after it was sent.")
    return sent


def sign_send_and_confirm(client, prepared, account, rpc_url=None, timeout_ms=120_000, interval_ms=3_000, **kwargs):
    """The whole scripted loop in one call: sign and send every step, then wait for the last step to confirm.

    Returns ``{"sent": [...], "status": {...}}``. For the human flow (a
    person signs on the /sign page), use ``confirm()`` with the hash they
    paste back instead.
    """
    sent = sign_and_send(prepared, account, rpc_url=rpc_url, **kwargs)
    if not sent:
        raise PolypadError("The prepared action has no transactions.", "invalid_params")
    status = confirm(client, sent[-1]["hash"], timeout_ms=timeout_ms, interval_ms=interval_ms)
    return {"sent": sent, "status": status}
