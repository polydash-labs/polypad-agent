import base64
import json
import unittest
from unittest.mock import patch

from polypad_agent import PolypadClient, PolypadError, connect_url, decode_wallet_token

# A token for 0x1111111111111111111111111111111111111111, exp far in the future.
# The signature is not real — decode only reads the envelope, verification is server-side.
TOKEN = base64.urlsafe_b64encode(json.dumps({
    "v": 1,
    "address": "0x1111111111111111111111111111111111111111",
    "exp": 4102444800,
    "sig": "0x" + "11" * 65,
}).encode()).decode().rstrip("=")


def mcp_reply(out, is_error=False):
    return {"jsonrpc": "2.0", "id": 1, "result": {
        "content": [{"type": "text", "text": json.dumps(out)}],
        "structuredContent": out, "isError": is_error}}


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self.text = json.dumps(payload) if isinstance(payload, dict) else str(payload)

    def json(self):
        return self._payload


class ClientTest(unittest.TestCase):
    def test_decode_reads_wallet_and_expiry(self):
        info = decode_wallet_token(TOKEN)
        self.assertEqual(info["address"], "0x1111111111111111111111111111111111111111")
        self.assertFalse(info["expired"])
        self.assertIsNone(decode_wallet_token("not-a-token"))

    def test_decode_flags_expired(self):
        old = base64.urlsafe_b64encode(json.dumps({
            "v": 1, "address": "0x1111111111111111111111111111111111111111",
            "exp": 1000000000, "sig": "0x" + "11" * 65}).encode()).decode().rstrip("=")
        self.assertTrue(decode_wallet_token(old)["expired"])

    def test_connect_url(self):
        url = connect_url(return_url="https://example.com/done")
        self.assertTrue(url.startswith("https://polypad.family/sign?connect=1"))
        self.assertIn("r=https%3A%2F%2Fexample.com%2Fdone", url)

    def test_prepare_attaches_wallet_token(self):
        seen = []
        client = PolypadClient(wallet_token=TOKEN)
        with patch.object(client.session, "post", side_effect=lambda url, **kw: seen.append(kw["json"]) or FakeResponse(mcp_reply({
                "ok": True, "action": "fund-mint",
                "signing": {"url": "https://polypad.family/sign?v=1", "checksum": "abc", "returnUrl": None, "expiresInSeconds": 1200}}))):
            out = client.prepare_fund_mint(fund="0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", quantity=1)
        self.assertEqual(out["action"], "fund-mint")
        args = seen[0]["params"]["arguments"]
        self.assertEqual(args["walletToken"], TOKEN)
        self.assertNotIn("from", args)
        self.assertEqual(client.wallet_address(), "0x1111111111111111111111111111111111111111")

    def test_explicit_from_left_alone_without_token(self):
        seen = []
        client = PolypadClient()
        with patch.object(client.session, "post", side_effect=lambda url, **kw: seen.append(kw["json"]) or FakeResponse(mcp_reply({"ok": True}))):
            client.call_tool("polypad_prepare_buy", {"token": "POLYDASH", "from": "0x2222222222222222222222222222222222222222", "amountEth": "0.01"})
        args = seen[0]["params"]["arguments"]
        self.assertEqual(args["from"], "0x2222222222222222222222222222222222222222")
        self.assertNotIn("walletToken", args)

    def test_tool_error_becomes_polypad_error(self):
        client = PolypadClient()
        with patch.object(client.session, "post", return_value=FakeResponse(mcp_reply(
                {"ok": False, "error": {"code": "invalid_params", "message": "fund must be a 0x address."}}, True))):
            with self.assertRaises(PolypadError) as ctx:
                client.get_fund("nope")
        self.assertEqual(ctx.exception.code, "invalid_params")

    def test_prepare_sign_confirm_polls_until_confirmed(self):
        calls = []
        client = PolypadClient(wallet_token=TOKEN)
        n = {"i": 0}

        def fake_post(url, **kw):
            body = kw["json"]
            calls.append(body["params"]["name"])
            n["i"] += 1
            if body["params"]["name"] == "polypad_prepare_fund_mint":
                return FakeResponse(mcp_reply({
                    "ok": True, "action": "fund-mint",
                    "summary": {"headline": "Mint 1 share", "lines": [], "risks": []},
                    "transactions": [],
                    "signing": {"url": "https://polypad.family/sign?v=1&a=fund-mint", "checksum": "abc", "returnUrl": None, "expiresInSeconds": 1200},
                    "warnings": []}))
            status = "confirmed" if n["i"] >= 3 else "pending"
            return FakeResponse(mcp_reply({"ok": True, "hash": "0xhash", "status": status,
                                           "result": "Minted 1 share." if status == "confirmed" else None}))

        links = []
        with patch.object(client.session, "post", side_effect=fake_post):
            done = client.prepare_sign_confirm(
                "polypad_prepare_fund_mint",
                {"fund": "0x7c1d31629ac68aebe83f230edbc7eacfc26285ef", "quantity": 1},
                on_signing_link=lambda url, summary: links.append(url),
                get_tx_hash=lambda: "0xhash",
                interval_s=0.01,
            )
        self.assertEqual(done["status"], "confirmed")
        self.assertEqual(done["tx_hash"], "0xhash")
        self.assertEqual(done["result"], "Minted 1 share.")
        self.assertEqual(links[0], "https://polypad.family/sign?v=1&a=fund-mint")
        self.assertEqual(calls[0], "polypad_prepare_fund_mint")


if __name__ == "__main__":
    unittest.main()


class FakeSession:
    """A requests.Session stand-in that answers with canned JSON-RPC replies."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.index = 0

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        reply = self.replies[min(self.index, len(self.replies) - 1)]
        self.index += 1
        return FakeResponse(reply)


def _result(payload):
    return {"jsonrpc": "2.0", "id": 1, "result": payload}


def _tool_ok(result):
    return _result(
        {
            "content": [{"type": "text", "text": json.dumps(result)}],
            "structuredContent": result,
            "isError": False,
        }
    )


def _tool_err(body):
    return _result(
        {
            "content": [{"type": "text", "text": json.dumps(body)}],
            "structuredContent": body,
            "isError": True,
        }
    )


class TransportTest(unittest.TestCase):
    def test_tool_list_constants(self):
        from polypad_agent.tools import PREPARE_TOOLS, TOOL_NAMES

        self.assertEqual(len(TOOL_NAMES), 21)
        self.assertTrue(all(name.startswith("polypad_") for name in TOOL_NAMES))
        self.assertEqual(len(PREPARE_TOOLS), 7)

    def test_lists_tools(self):
        session = FakeSession([_result({"tools": [{"name": "polypad_stats", "description": "stats", "inputSchema": {}}]})])
        client = PolypadClient(session=session)
        tools = client.list_tools()
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["name"], "polypad_stats")
        self.assertEqual(session.calls[0]["json"]["method"], "tools/list")

    def test_returns_structured_content(self):
        session = FakeSession([_tool_ok({"ok": True, "total": 3})])
        client = PolypadClient(session=session)
        self.assertEqual(client.stats(), {"ok": True, "total": 3})
        sent = session.calls[0]["json"]
        self.assertEqual(sent["method"], "tools/call")
        self.assertEqual(sent["params"]["name"], "polypad_stats")

    def test_server_tool_error_becomes_polypad_error(self):
        session = FakeSession(
            [_tool_err({"ok": False, "error": {"code": "rate_limited", "message": "Too many requests.", "retryAfter": 60}})]
        )
        client = PolypadClient(session=session)
        with self.assertRaises(PolypadError) as ctx:
            client.stats()
        self.assertEqual(ctx.exception.code, "rate_limited")
        self.assertIn("Too many requests", ctx.exception.meaning)
        self.assertEqual(ctx.exception.retry_after_seconds, 60)

    def test_json_rpc_error(self):
        session = FakeSession([{"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "Unknown tool: polypad_nope"}}])
        client = PolypadClient(session=session)
        with self.assertRaises(PolypadError) as ctx:
            client.call_tool("polypad_stats", {})
        self.assertEqual(ctx.exception.code, "rpc_-32602")

    def test_http_error(self):
        class RawSession(FakeSession):
            def post(self, url, json=None, headers=None, timeout=None):
                return FakeResponse("Use POST with a JSON-RPC message.", status_code=405)

        client = PolypadClient(session=RawSession([]))
        with self.assertRaises(PolypadError) as ctx:
            client.ping()
        self.assertEqual(ctx.exception.code, "http_error")
        self.assertEqual(ctx.exception.status, 405)

    def test_network_failure(self):
        import requests

        class FailingSession:
            def post(self, *a, **k):
                raise requests.ConnectionError("fetch failed")

        client = PolypadClient(session=FailingSession())
        with self.assertRaises(PolypadError) as ctx:
            client.ping()
        self.assertEqual(ctx.exception.code, "network_error")

    def test_sends_client_name_header(self):
        session = FakeSession([_result({})])
        client = PolypadClient(session=session, client_name="my-agent")
        client.ping()
        self.assertEqual(session.calls[0]["headers"]["x-polypad-client"], "my-agent")

    def test_refuses_key_material_before_sending(self):
        session = FakeSession([_tool_ok({"ok": True})])
        client = PolypadClient(session=session)
        fake_key = "0x" + "ab" * 32
        with self.assertRaises(PolypadError) as ctx:
            client.prepare_buy(token="POLYDASH", **{"from": fake_key, "amountEth": "0.01"})
        self.assertEqual(ctx.exception.code, "key_material_rejected")
        self.assertEqual(len(session.calls), 0)

    def test_refuses_malformed_from(self):
        session = FakeSession([_tool_ok({"ok": True})])
        client = PolypadClient(session=session)
        with self.assertRaises(PolypadError) as ctx:
            client.prepare_buy(token="POLYDASH", **{"from": "not-an-address", "amountEth": "0.01"})
        self.assertEqual(ctx.exception.code, "invalid_params")
        self.assertEqual(len(session.calls), 0)

    def test_initialize_returns_server_info(self):
        session = FakeSession(
            [_result({"protocolVersion": "2025-06-18", "serverInfo": {"name": "polypad", "version": "2.0.0"}})]
        )
        client = PolypadClient(session=session)
        info = client.initialize()
        self.assertEqual(info["serverInfo"]["version"], "2.0.0")

    def test_wallet_token_attached_to_intent(self):
        session = FakeSession([_tool_ok({"ok": True})])
        client = PolypadClient(session=session, wallet_token=TOKEN)
        client.intent({"text": "buy some POLYDASH"})
        args = session.calls[0]["json"]["params"]["arguments"]
        self.assertEqual(args["walletToken"], TOKEN)
