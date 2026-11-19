"""Unit tests for the SpendVault helpers: calldata encoding (checked byte-for-byte against viem), validation, key-status decoding."""

import json
import unittest

from polypad_agent import PolypadError
from polypad_agent.constants import SPEND_VAULT_ADDRESS, X402
from polypad_agent.spend_vault import (
    build_create_key_tx,
    build_deposit_tx,
    build_revoke_key_tx,
    build_withdraw_tx,
    get_key_status,
    spend_vault_key_flow,
)

KEY = "0x1111111111111111111111111111111111111111"
FUTURE = 1893456000  # 2030-01-01, a fixed future timestamp matching the viem test vector

# Expected calldata produced by viem's encodeFunctionData for the same inputs.
CREATE_KEY_EMPTY = "0x9d30cddc00000000000000000000000011111111111111111111111111111111111111110000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d1680000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000007a12000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000070dbd8800000000000000000000000000000000000000000000000000000000000000000"

CREATE_KEY_TWO = "0x9d30cddc00000000000000000000000011111111111111111111111111111111111111110000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d1680000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000007a12000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000070dbd880000000000000000000000000000000000000000000000000000000000000000200000000000000000000000022222222222222222222222222222222222222220000000000000000000000003333333333333333333333333333333333333333"


class FakeSession:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def post(self, url, json=None, timeout=None):
        self.calls.append({"url": url, "json": json})
        return _FakeResponse({"jsonrpc": "2.0", "id": 1, "result": self.result})


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        pass


def _key_return(owner, token, per_payment, daily, expiry, revoked, spent_day, spent_today, allowlist_count):
    words = [
        int(owner, 16),
        int(token, 16),
        per_payment,
        daily,
        expiry,
        1 if revoked else 0,
        spent_day,
        spent_today,
        allowlist_count,
    ]
    # owner/token are addresses: they sit in the low 20 bytes of their word.
    raw = b"".join(w.to_bytes(32, "big") for w in words)
    return "0x" + raw.hex()


class TestBuilders(unittest.TestCase):
    def test_create_key_empty_allowlist_matches_viem(self):
        tx = build_create_key_tx(KEY, "USDG", 10_000, 500_000, allowlist=[], expiry=FUTURE)
        self.assertEqual(tx["to"], SPEND_VAULT_ADDRESS)
        self.assertEqual(tx["chainId"], 4663)
        self.assertEqual(tx["value"], "0")
        self.assertEqual(tx["data"], CREATE_KEY_EMPTY)

    def test_create_key_two_allowlist_matches_viem(self):
        tx = build_create_key_tx(
            KEY,
            "USDG",
            10_000,
            500_000,
            allowlist=["0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"],
            expiry=FUTURE,
        )
        self.assertEqual(tx["data"], CREATE_KEY_TWO)

    def test_deposit_withdraw_revoke_selectors(self):
        self.assertTrue(build_deposit_tx("USDG", 1_000_000)["data"].startswith("0x47e7ef24"))
        self.assertTrue(build_withdraw_tx("POLYDASH", 5)["data"].startswith("0xf3fef3a3"))
        self.assertTrue(build_revoke_key_tx(KEY)["data"].startswith("0x5ae7ab32"))

    def test_rejects_per_payment_above_daily(self):
        with self.assertRaises(PolypadError):
            build_create_key_tx(KEY, "USDG", 600_000, 500_000, expiry=FUTURE)

    def test_rejects_past_expiry(self):
        with self.assertRaises(PolypadError):
            build_create_key_tx(KEY, "USDG", 1, 2, expiry=1000)

    def test_rejects_bad_key_address(self):
        with self.assertRaises(PolypadError):
            build_create_key_tx("nope", "USDG", 1, 2, expiry=FUTURE)

    def test_rejects_zero_deposit(self):
        with self.assertRaises(PolypadError):
            build_deposit_tx("USDG", 0)


class TestKeyFlow(unittest.TestCase):
    def test_flow_says_a_key_is_an_address_not_a_secret(self):
        text = " ".join(spend_vault_key_flow())
        self.assertIn("wallet address, not a password or secret", text)
        self.assertIn("agents/accounts", text)


class TestGetKeyStatus(unittest.TestCase):
    def test_reads_and_decodes_a_key_row(self):
        owner = "0x" + "22" * 20
        token = X402["usdg"]["address"].lower()
        result = _key_return(owner, token, 10_000, 500_000, FUTURE, False, 0, 123, 0)
        session = FakeSession(result)
        status = get_key_status(KEY, session=session)
        self.assertIsNotNone(status)
        self.assertEqual(status["owner"].lower(), owner)
        self.assertEqual(status["token"].lower(), token)
        self.assertEqual(status["per_payment_cap"], 10_000)
        self.assertEqual(status["daily_cap"], 500_000)
        self.assertEqual(status["expiry"], FUTURE)
        self.assertFalse(status["revoked"])
        self.assertEqual(status["spent_today"], 123)

    def test_returns_none_without_a_key(self):
        result = _key_return("0x" + "00" * 20, X402["usdg"]["address"], 0, 0, 0, False, 0, 0, 0)
        status = get_key_status(KEY, session=FakeSession(result))
        self.assertIsNone(status)


if __name__ == "__main__":
    unittest.main()
