"""polypad-agent — thin typed client for the Polypad agent API (MCP) on Robinhood Chain."""

from .binding import connect_url, decode_wallet_token
from .client import CHAIN_ID, DEFAULT_RPC_URL, MCP_URL, SITE_ORIGIN, PolypadClient
from .constants import (
    ACTION_LIMITS,
    CHAIN_NAME,
    ERROR_MEANINGS,
    EXPLORER,
    MCP_ENDPOINT,
    MCP_PROTOCOL_VERSION,
    RATE_LIMITS,
    SERVER_VERSION,
    SPEND_VAULT_ADDRESS,
    VAULT_TOKENS,
    X402,
    X402_PRODUCTS,
    x402_product,
)
from .errors import PolypadConfirmTimeoutError, PolypadError, PolypadTxFailedError
from .prepare import confirm, sign_and_send, sign_send_and_confirm
from .spend_vault import (
    build_create_key_tx,
    build_deposit_tx,
    build_revoke_key_tx,
    build_withdraw_tx,
    get_key_status,
    get_vault_balance,
    spend_vault_key_flow,
)
from .tools import PREPARE_TOOLS, TOOL_NAMES, is_prepare_tool
from .x402 import (
    encode_payment_header,
    fetch_with_x402,
    next_permit2_nonce,
    pay_for_report,
    product_url,
    sign_x402_payment,
)

__all__ = [
    "PolypadClient",
    "PolypadError",
    "PolypadTxFailedError",
    "PolypadConfirmTimeoutError",
    "MCP_URL",
    "MCP_ENDPOINT",
    "SITE_ORIGIN",
    "CHAIN_ID",
    "DEFAULT_RPC_URL",
    "connect_url",
    "decode_wallet_token",
    "pay_for_report",
    "confirm",
    "sign_and_send",
    "sign_send_and_confirm",
    "TOOL_NAMES",
    "PREPARE_TOOLS",
    "is_prepare_tool",
    "build_create_key_tx",
    "build_deposit_tx",
    "build_revoke_key_tx",
    "build_withdraw_tx",
    "get_key_status",
    "get_vault_balance",
    "spend_vault_key_flow",
    "encode_payment_header",
    "fetch_with_x402",
    "next_permit2_nonce",
    "product_url",
    "sign_x402_payment",
    "ACTION_LIMITS",
    "CHAIN_NAME",
    "ERROR_MEANINGS",
    "EXPLORER",
    "MCP_PROTOCOL_VERSION",
    "RATE_LIMITS",
    "SERVER_VERSION",
    "SPEND_VAULT_ADDRESS",
    "VAULT_TOKENS",
    "X402",
    "X402_PRODUCTS",
    "x402_product",
]
__version__ = "2.0.1"
