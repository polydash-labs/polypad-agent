"""Unit tests for the x402 payment helper: payload signing, header encoding, 402 retry."""

import base64
import json
import unittest

from polypad_agent import PolypadError
from polypad_agent.constants import X402
from polypad_agent.x402 import encode_payment_header, fetch_with_x402, product_url, sign_x402_payment

from eth_account import Account
from eth_account.messages import encode_typed_data

# A throwaway test key. Never a real key; used only to check signatures recover correctly.
TEST_KEY = "0x" + "01" * 32
ACCOUNT = Account.from_key(TEST_KEY)

USDG_ACCEPT = {
    "scheme": "exact",
    "network": "eip155:4663",
    "amount": "10000",
    "asset": X402["usdg"]["address"],
    "payTo": X402["pay_to"],
    "maxTimeoutSeconds": 120,
    "description": "Token report",
    "extra": {"assetTransferMethod": "eip3009", "name": "Global Dollar", "version": "1"},
}

POLY_ACCEPT = {
    "scheme": "exact",
    "network": "eip155:4663",
    "amount": "1000000000000000000",
    "asset": X402["polydash"]["address"],
    "payTo": X402["pay_to"],
    "maxTimeoutSeconds": 120,
    "description": "Token report",
    "extra": {"assetTransferMethod": "permit2", "name": "Polydash", "version": "1"},
}


def _recover_eip3009(authorization, signature):
    message = {
        "domain": {"name": "Global Dollar", "version": "1", "chainId": 4663, "verifyingContract": X402["usdg"]["address"]},
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
            "from": authorization["from"],
            "to": authorization["to"],
            "value": int(authorization["value"]),
            "validAfter": int(authorization["validAfter"]),
            "validBefore": int(authorization["validBefore"]),
            "nonce": bytes.fromhex(authorization["nonce"][2:]),
        },
    }
    return Account.recover_message(encode_typed_data(full_message=message), signature=bytes.fromhex(signature[2:]))


def _recover_permit2(authorization, signature):
    message = {
        "domain": {"name": "Permit2", "chainId": 4663, "verifyingContract": X402["permit2"]},
        "types": {
            "PermitWitnessTransferFrom": [
                {"name": "permitted", "type": "TokenPermissions"},
                {"name": "spender", "type": "address"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
                {"name": "witness", "type": "Witness"},
            ],
            "TokenPermissions": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}],
            "Witness": [{"name": "to", "type": "address"}, {"name": "validAfter", "type": "uint256"}],
        },
        "primaryType": "PermitWitnessTransferFrom",
        "message": {
            "permitted": {"token": authorization["permitted"]["token"], "amount": int(authorization["permitted"]["amount"])},
            "spender": authorization["spender"],
            "nonce": int(authorization["nonce"]),
            "deadline": int(authorization["deadline"]),
            "witness": {"to": authorization["witness"]["to"], "validAfter": int(authorization["witness"]["validAfter"])},
        },
    }
    return Account.recover_message(encode_typed_data(full_message=message), signature=bytes.fromhex(signature[2:]))


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class TestSignPayment(unittest.TestCase):
    def test_usdg_eip3009_recovers_to_payer(self):
        payment = sign_x402_payment(USDG_ACCEPT, ACCOUNT)
        self.assertEqual(payment["x402Version"], 2)
        auth = payment["payload"]["authorization"]
        self.assertEqual(auth["from"].lower(), ACCOUNT.address.lower())
        self.assertEqual(auth["to"].lower(), X402["pay_to"].lower())
        self.assertEqual(auth["value"], "10000")
        self.assertRegex(auth["nonce"], r"^0x[0-9a-f]{64}$")
        recovered = _recover_eip3009(auth, payment["payload"]["signature"])
        self.assertEqual(recovered.lower(), ACCOUNT.address.lower())

    def test_polydash_permit2_recovers_to_payer(self):
        payment = sign_x402_payment(POLY_ACCEPT, ACCOUNT, nonce=7)
        auth = payment["payload"]["permit2Authorization"]
        self.assertEqual(auth["from"].lower(), ACCOUNT.address.lower())
        self.assertEqual(auth["spender"].lower(), X402["permit2_proxy"].lower())
        self.assertEqual(auth["nonce"], "7")
        self.assertEqual(auth["witness"]["to"].lower(), X402["pay_to"].lower())
        recovered = _recover_permit2(auth, payment["payload"]["signature"])
        self.assertEqual(recovered.lower(), ACCOUNT.address.lower())

    def test_refuses_wrong_recipient(self):
        wrong = dict(USDG_ACCEPT, payTo="0x0000000000000000000000000000000000000001")
        with self.assertRaises(PolypadError) as ctx:
            sign_x402_payment(wrong, ACCOUNT)
        self.assertEqual(ctx.exception.code, "invalid_params")

    def test_refuses_wrong_network(self):
        wrong = dict(USDG_ACCEPT, network="eip155:1")
        with self.assertRaises(PolypadError):
            sign_x402_payment(wrong, ACCOUNT)

    def test_header_is_base64_json(self):
        payment = sign_x402_payment(USDG_ACCEPT, ACCOUNT)
        header = encode_payment_header(payment)
        decoded = json.loads(base64.b64decode(header).decode("utf-8"))
        self.assertEqual(decoded["x402Version"], 2)
        self.assertEqual(decoded["accepted"]["amount"], "10000")


class TestFetchWithX402(unittest.TestCase):
    def test_no_402_returns_first_response(self):
        calls = []

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls.append((url, headers))
                return FakeResponse({"product": "token-report"}, status=200)

        result = fetch_with_x402("https://polypad.family/api/x402/products/token-report?address=0x1234", ACCOUNT, session=Session())
        self.assertEqual(result["response"].status_code, 200)
        self.assertIsNone(result["payment"])
        self.assertEqual(len(calls), 1)

    def test_402_signs_and_retries_with_header(self):
        calls = []

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls.append((url, headers))
                if len(calls) == 1:
                    return FakeResponse({"x402Version": 2, "accepts": [USDG_ACCEPT]}, status=402)
                return FakeResponse({"product": "token-report", "symbol": "TEST"}, status=200)

        result = fetch_with_x402("https://polypad.family/api/x402/products/token-report?address=0x1234", ACCOUNT, session=Session())
        self.assertEqual(result["response"].status_code, 200)
        self.assertIsNotNone(result["payment"])
        self.assertEqual(result["accepted"]["amount"], "10000")
        header = calls[1][1]["x-payment"]
        decoded = json.loads(base64.b64decode(header).decode("utf-8"))
        self.assertEqual(decoded["x402Version"], 2)

    def test_402_without_options_raises(self):
        class Session:
            def get(self, url, headers=None, timeout=None):
                return FakeResponse({"x402Version": 2, "accepts": []}, status=402)

        with self.assertRaises(PolypadError):
            fetch_with_x402("https://polypad.family/api/x402/products/token-report?address=0x1234", ACCOUNT, session=Session())


class TestProductUrl(unittest.TestCase):
    def test_token_report_url(self):
        self.assertEqual(
            product_url("token-report", "0x3Da9244DDE38284017fD15e45d1Fdf66D3617B4B"),
            "https://polypad.family/api/x402/products/token-report?address=0x3Da9244DDE38284017fD15e45d1Fdf66D3617B4B",
        )

    def test_unknown_product(self):
        with self.assertRaises(PolypadError):
            product_url("nope", "0x1234")


if __name__ == "__main__":
    unittest.main()
