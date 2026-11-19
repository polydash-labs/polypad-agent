"""Unit tests for confirm(): polling, tx_not_found, failure, timeout."""

import json
import unittest

from polypad_agent import PolypadClient, PolypadConfirmTimeoutError, PolypadError, PolypadTxFailedError
from polypad_agent.prepare import confirm


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.ok = 200 <= status < 300
        self.text = json.dumps(payload) if isinstance(payload, dict) else str(payload)

    def json(self):
        if isinstance(self._payload, dict):
            return self._payload
        raise ValueError("not json")


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


HASH = "0x" + "11" * 32


class TestConfirm(unittest.TestCase):
    def test_returns_confirmed_status(self):
        session = FakeSession(
            [
                _tool_ok({"ok": True, "chainId": 4663, "hash": HASH, "status": "pending", "explorer": f"https://x/tx/{HASH}"}),
                _tool_ok(
                    {"ok": True, "chainId": 4663, "hash": HASH, "status": "confirmed", "result": "Token launched: TEST.", "explorer": f"https://x/tx/{HASH}"}
                ),
            ]
        )
        client = PolypadClient(session=session)
        status = confirm(client, HASH, interval_ms=5)
        self.assertEqual(status["status"], "confirmed")
        self.assertEqual(status["result"], "Token launched: TEST.")

    def test_polls_through_tx_not_found_then_confirms(self):
        session = FakeSession(
            [
                _tool_err({"ok": False, "error": {"code": "tx_not_found", "message": "No transaction with that hash was found yet."}}),
                _tool_ok({"ok": True, "chainId": 4663, "hash": HASH, "status": "confirmed", "result": "The transaction was confirmed.", "explorer": f"https://x/tx/{HASH}"}),
            ]
        )
        client = PolypadClient(session=session)
        status = confirm(client, HASH, interval_ms=5)
        self.assertEqual(status["status"], "confirmed")

    def test_failed_transaction_raises(self):
        session = FakeSession(
            [_tool_ok({"ok": True, "chainId": 4663, "hash": HASH, "status": "failed", "result": "The transaction was mined but failed.", "explorer": f"https://x/tx/{HASH}"})]
        )
        client = PolypadClient(session=session)
        with self.assertRaises(PolypadTxFailedError):
            confirm(client, HASH, interval_ms=5)

    def test_timeout_raises_with_explorer_link(self):
        session = FakeSession(
            [_tool_ok({"ok": True, "chainId": 4663, "hash": HASH, "status": "pending", "explorer": f"https://x/tx/{HASH}"})]
        )
        client = PolypadClient(session=session)
        with self.assertRaises(PolypadConfirmTimeoutError) as ctx:
            confirm(client, HASH, timeout_ms=30, interval_ms=5)
        self.assertEqual(ctx.exception.tx_hash, HASH)
        self.assertIn(HASH, ctx.exception.explorer_url)
        self.assertIn("may still confirm", str(ctx.exception))

    def test_other_server_errors_pass_through(self):
        session = FakeSession(
            [_tool_err({"ok": False, "error": {"code": "invalid_params", "message": "hash must be a 32-byte 0x transaction hash."}})]
        )
        client = PolypadClient(session=session)
        with self.assertRaises(PolypadError) as ctx:
            confirm(client, HASH, interval_ms=5)
        self.assertEqual(ctx.exception.code, "invalid_params")


if __name__ == "__main__":
    unittest.main()
