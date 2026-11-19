"""polypad-agent — thin typed client for the Polypad agent API (MCP) on Robinhood Chain.

The client talks JSON-RPC to https://polypad.family/api/mcp. Reads only fetch data. Prepare
calls return an unsigned transaction, a plain summary, and a signing link — nothing moves until
somebody signs.

Wallet binding (persistent): connect once on /sign?connect=1, store the token, and pass it here.
The client attaches it to every prepare call instead of a wallet address; the server resolves the
wallet from the token. Per-call `from` still works as the fallback — pass it explicitly and the
client leaves the token out for that call.
"""

import itertools
import json
import os
import re
import time

import requests

from .binding import connect_url, decode_wallet_token
from .constants import MCP_ENDPOINT, SERVER_VERSION
from .errors import PolypadError, error_from_body, is_api_error_body
from .tools import is_prepare_tool

MCP_URL = MCP_ENDPOINT
SITE_ORIGIN = "https://polypad.family"
CHAIN_ID = 4663
DEFAULT_RPC_URL = "https://robinhood.drpc.org"

PREPARE_TOOLS = {
    "polypad_prepare_buy",
    "polypad_prepare_sell",
    "polypad_prepare_nft_buy",
    "polypad_prepare_fund_create",
    "polypad_prepare_fund_mint",
    "polypad_prepare_fund_redeem",
    "polypad_prepare_token_launch",
}

# Prepare tools plus intent: the calls that take a wallet (from the token or an explicit `from`).
_TOKEN_TOOLS = PREPARE_TOOLS | {"polypad_intent"}

_KEY_LOOKALIKE = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")
_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _reject_key_material(args):
    """The server refuses anything that looks like key material. Check first, so nothing sensitive is ever sent."""

    def walk(value):
        if isinstance(value, str) and _KEY_LOOKALIKE.match(value.strip()):
            raise PolypadError(
                "Do not send private keys or seed phrases. Polypad never needs them. Nothing was sent.",
                "key_material_rejected",
            )
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)

    walk(args)


class PolypadClient:
    def __init__(self, mcp_url=None, wallet_token=None, client_name=None, session=None, ref=None, timeout=30):
        self.mcp_url = mcp_url or MCP_URL
        self.wallet_token = wallet_token or os.environ.get("POLYPAD_WALLET_TOKEN") or None
        self.client_name = client_name or "polypad-agent"
        self.session = session or requests.Session()
        self.default_ref = ref
        self.timeout = timeout
        self._ids = itertools.count(1)

    # ---- binding ------------------------------------------------------------

    def set_wallet_token(self, token):
        """Store a wallet token (from /sign?connect=1). Later prepare calls resolve the wallet from it."""
        self.wallet_token = token or None

    def wallet_address(self):
        """The wallet bound by the stored token, or None when no token is set."""
        if not self.wallet_token:
            return None
        info = decode_wallet_token(self.wallet_token)
        return info["address"] if info else None

    def connect_url(self, return_url=None):
        """The connect URL to show the user so they can bind a wallet and get a token."""
        return connect_url(return_url=return_url, origin=SITE_ORIGIN)

    # ---- raw call -----------------------------------------------------------

    def rpc(self, method, params=None):
        """Low-level JSON-RPC call. Returns the ``result`` object, or raises PolypadError."""
        request_id = next(self._ids)
        headers = {"content-type": "application/json", "x-polypad-client": self.client_name}
        try:
            response = self.session.post(
                self.mcp_url,
                json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}},
                headers=headers,
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise PolypadError(
                f"Could not reach {self.mcp_url}: {exc}. Check your connection and try again.",
                "network_error",
            ) from exc
        if not response.ok:
            text = response.text or ""
            raise PolypadError(
                "The Polypad API answered HTTP " + str(response.status_code) + (f": {text[:200]}" if text else "."),
                "http_error",
                status=response.status_code,
            )
        try:
            reply = response.json()
        except ValueError as exc:
            raise PolypadError("The Polypad API answered with something that was not JSON.", "invalid_response") from exc
        if reply.get("error"):
            error = reply["error"]
            raise PolypadError(
                error.get("message", "JSON-RPC error."),
                f"rpc_{error.get('code')}",
                extra={"json_rpc_code": error.get("code"), **(error.get("data") or {})},
            )
        return reply.get("result") or {}

    def initialize(self):
        """The MCP handshake. Optional — the server is stateless and answers tools/call without it."""
        return self.rpc(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": self.client_name, "version": SERVER_VERSION},
            },
        )

    def ping(self):
        """Returns True when the server answers."""
        self.rpc("ping")
        return True

    def list_tools(self):
        """The 21 tools, with names, descriptions, and input schemas, straight from the server."""
        result = self.rpc("tools/list")
        return result.get("tools") or []

    def call_tool(self, name, arguments=None):
        """One MCP tools/call. Raises PolypadError when the tool answers with an error."""
        args = dict(arguments or {})
        if self.default_ref and args.get("ref") is None and (is_prepare_tool(name) or name == "polypad_intent"):
            args["ref"] = self.default_ref
        if name in _TOKEN_TOOLS:
            if self.wallet_token and "walletToken" not in args and "from" not in args:
                args["walletToken"] = self.wallet_token
            _reject_key_material(args)
            from_value = args.get("from")
            if isinstance(from_value, str) and not _ADDRESS_RE.match(from_value.strip()):
                raise PolypadError("`from` must be a 0x wallet address.", "invalid_params", extra={"field": "from"})
        result = self.rpc("tools/call", {"name": name, "arguments": args})
        if result.get("isError"):
            structured = result.get("structuredContent")
            if is_api_error_body(structured):
                raise error_from_body(structured)
            content = result.get("content") or []
            text = content[0].get("text", "") if content else ""
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = None
            if is_api_error_body(parsed):
                raise error_from_body(parsed)
            raise PolypadError(text[:400] or f"The {name} tool reported an error.", "tool_error")
        out = result.get("structuredContent")
        if out is None and result.get("content"):
            try:
                out = json.loads(result["content"][0]["text"])
            except (ValueError, KeyError, IndexError):
                out = None
        if not isinstance(out, dict):
            raise PolypadError("MCP endpoint answered with no result.", "bad_response")
        if out.get("ok") is False:
            err = out.get("error") or {}
            raise PolypadError(err.get("message", "The tool call failed."), err.get("code", "tool_error"))
        return out

    # ---- reads (no wallet, no signature) ------------------------------------

    def what_can_i_do(self):
        return self.call_tool("polypad_what_can_i_do", {})

    def intent(self, args):
        return self.call_tool("polypad_intent", args)

    def list_tokens(self, **kwargs):
        return self.call_tool("polypad_list_tokens", kwargs)

    def get_token(self, token):
        return self.call_tool("polypad_get_token", {"token": token})

    def token_protections(self, token):
        return self.call_tool("polypad_token_protections", {"token": token})

    def quote_trade(self, **kwargs):
        return self.call_tool("polypad_quote_trade", kwargs)

    def list_nfts(self, **kwargs):
        return self.call_tool("polypad_list_nfts", kwargs)

    def list_nft_listings(self, **kwargs):
        return self.call_tool("polypad_list_nft_listings", kwargs)

    def list_funds(self, **kwargs):
        return self.call_tool("polypad_list_funds", kwargs)

    def get_fund(self, fund):
        return self.call_tool("polypad_get_fund", {"fund": fund})

    def list_fund_templates(self):
        return self.call_tool("polypad_list_fund_templates", {})

    def portfolio(self, address):
        return self.call_tool("polypad_portfolio", {"address": address})

    def stats(self):
        return self.call_tool("polypad_stats", {})

    def get_tx_status(self, tx_hash):
        """One status check. Pending means the transaction is still travelling."""
        return self.call_tool("polypad_get_tx_status", {"hash": tx_hash})

    # ---- prepares (wallet from the token, or an explicit `from`) ------------

    def prepare_buy(self, **kwargs):
        return self.call_tool("polypad_prepare_buy", kwargs)

    def prepare_sell(self, **kwargs):
        return self.call_tool("polypad_prepare_sell", kwargs)

    def prepare_nft_buy(self, **kwargs):
        return self.call_tool("polypad_prepare_nft_buy", kwargs)

    def prepare_fund_create(self, **kwargs):
        return self.call_tool("polypad_prepare_fund_create", kwargs)

    def prepare_fund_mint(self, **kwargs):
        return self.call_tool("polypad_prepare_fund_mint", kwargs)

    def prepare_fund_redeem(self, **kwargs):
        return self.call_tool("polypad_prepare_fund_redeem", kwargs)

    def prepare_token_launch(self, **kwargs):
        return self.call_tool("polypad_prepare_token_launch", kwargs)

    # ---- the loop: prepare → sign → confirm --------------------------------

    def wait_for_confirmation(self, tx_hash, interval_s=3, timeout_s=120):
        """Poll get_tx_status until the transaction confirms or fails. Raises on timeout.

        A hash the chain has not seen yet (``tx_not_found``) keeps polling until the
        timeout, because a just-sent transaction can take a few seconds to appear.
        """
        started = time.time()
        while True:
            try:
                status = self.get_tx_status(tx_hash)
            except PolypadError as exc:
                if exc.code == "tx_not_found":
                    if time.time() - started > timeout_s:
                        raise PolypadError(
                            f"No confirmation after {int(timeout_s)}s for {tx_hash}. Check the explorer.",
                            "confirm_timeout",
                        ) from exc
                    time.sleep(interval_s)
                    continue
                raise
            if status.get("status") in ("confirmed", "failed"):
                return status
            if time.time() - started > timeout_s:
                raise PolypadError(
                    f"No confirmation after {int(timeout_s)}s for {tx_hash}. Check the explorer.",
                    "confirm_timeout",
                )
            time.sleep(interval_s)

    def prepare_sign_confirm(self, tool, arguments, on_signing_link, get_tx_hash,
                             return_url=None, interval_s=3, timeout_s=120):
        """Prepare → sign → confirm, for a chat agent.

        Prepares the action (wallet from the stored token), hands the signing link to
        `on_signing_link` for the user to open, then waits for the transaction hash — supplied by
        `get_tx_hash`, which resolves once the user has signed (for example from the returnUrl
        callback, or the user pasting the hash back) — and polls until the chain confirms it.
        """
        args = dict(arguments)
        if return_url:
            args["returnUrl"] = return_url
        prepared = self.call_tool(tool, args)
        on_signing_link(prepared["signing"]["url"], prepared["summary"])
        tx_hash = get_tx_hash()
        done = self.wait_for_confirmation(tx_hash, interval_s=interval_s, timeout_s=timeout_s)
        return {"status": done["status"], "tx_hash": tx_hash, "result": done.get("result"),
                "tx_status": done, "prepared": prepared}

    def prepare_sign_broadcast(self, tool, arguments, private_key, rpc_url=None,
                               interval_s=3, timeout_s=120):
        """Prepare → sign → confirm, for a script with its own wallet (the Forge path).

        Prepares the action, signs and sends each step with the script's own key, waits for each
        step's receipt before the next, then polls get_tx_status for the final result. The signing
        key must be the bound wallet — never the Polypad deployer wallet.
        """
        from eth_account import Account

        prepared = self.call_tool(tool, dict(arguments))
        account = Account.from_key(private_key)
        rpc = rpc_url or DEFAULT_RPC_URL
        bound = self.wallet_address()
        if bound and bound.lower() != account.address.lower():
            raise PolypadError(
                f"The signing key ({account.address}) is not the bound wallet ({bound}).",
                "wallet_mismatch",
            )
        for step in prepared["transactions"]:
            if step["from"].lower() != account.address.lower():
                raise PolypadError(
                    f"Step {step['step']} was prepared for {step['from']}, not the signing wallet {account.address}.",
                    "wallet_mismatch",
                )
        hashes = []
        nonce = self._rpc(rpc, "eth_getTransactionCount", [account.address, "pending"])
        gas_price = self._rpc(rpc, "eth_gasPrice", [])
        for i, step in enumerate(prepared["transactions"]):
            tx = {
                "chainId": CHAIN_ID,
                "to": step["to"],
                "data": step["data"],
                "value": int(step["value"]),
                "gas": int(step["gas"]) if step.get("gas") else 300000,
                "gasPrice": gas_price,
                "nonce": nonce,
            }
            signed = account.sign_transaction(tx)
            tx_hash = self._rpc(rpc, "eth_sendRawTransaction", [signed.raw_transaction.hex()])
            hashes.append(tx_hash)
            nonce += 1
            if i < len(prepared["transactions"]) - 1:
                receipt = self._wait_receipt(rpc, tx_hash)
                if int(receipt.get("status", "0x0"), 16) != 1:
                    raise PolypadError(f"Step {i + 1} failed on-chain. Nothing after it was sent.", "step_failed")
        tx_hash = hashes[-1]
        done = self.wait_for_confirmation(tx_hash, interval_s=interval_s, timeout_s=timeout_s)
        return {"status": done["status"], "tx_hash": tx_hash, "result": done.get("result"),
                "tx_status": done, "hashes": hashes, "prepared": prepared}

    # ---- minimal JSON-RPC helpers (script signing path only) -----------------

    def _rpc(self, rpc_url, method, params):
        resp = self.session.post(
            rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
        body = resp.json()
        if body.get("error"):
            raise PolypadError(f"RPC {method} failed: {body['error'].get('message')}", "rpc_error")
        result = body["result"]
        return int(result, 16) if isinstance(result, str) and result.startswith("0x") and method != "eth_sendRawTransaction" else result

    def _wait_receipt(self, rpc_url, tx_hash, timeout_s=120):
        started = time.time()
        while True:
            receipt = self._rpc(rpc_url, "eth_getTransactionReceipt", [tx_hash])
            if receipt:
                return receipt
            if time.time() - started > timeout_s:
                raise PolypadError(f"No receipt after {int(timeout_s)}s for {tx_hash}.", "confirm_timeout")
            time.sleep(2)
