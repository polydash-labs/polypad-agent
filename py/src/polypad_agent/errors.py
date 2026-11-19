"""Errors. The server answers with ``{"ok": false, "error": {"code", "message", ...}}``
(and the same shape inside a tools/call reply marked ``isError: true``).
This module turns those replies — plus plain JSON-RPC and HTTP failures —
into one typed error with the server's own plain-language meaning attached.
"""

from .constants import ERROR_MEANINGS


class PolypadError(Exception):
    """One error for every Polypad failure, with the server's own code.

    Args:
        message: Plain-language message, usually the server's own.
        code: Machine-readable code from the server (for example ``rate_limited``).
        status: HTTP status when the server sent one.
        extra: Extra fields the server sent (for example ``retryAfter``, ``field``).
    """

    def __init__(self, message, code="error", status=None, extra=None):
        super().__init__(message)
        self.message = message
        self.code = code
        #: HTTP status when the server sent one.
        self.status = status
        #: Extra fields the server sent (for example ``retryAfter``, ``field``).
        self.extra = extra or {}
        #: The server's plain-language meaning for this code, when one is published.
        self.meaning = ERROR_MEANINGS.get(code)

    @property
    def retry_after_seconds(self):
        """Seconds to wait before retrying, when the server said so (429s)."""
        value = self.extra.get("retryAfter")
        return value if isinstance(value, (int, float)) else None


class PolypadTxFailedError(PolypadError):
    """Raised by ``confirm()`` when a transaction is mined but fails on-chain."""

    def __init__(self, tx_hash, result):
        super().__init__(
            f"Transaction {tx_hash} was mined but failed on-chain. {result}",
            "tx_failed",
            extra={"tx_hash": tx_hash},
        )
        self.tx_hash = tx_hash


class PolypadConfirmTimeoutError(PolypadError):
    """Raised by ``confirm()`` when no final answer arrives before the timeout."""

    def __init__(self, tx_hash, timeout_ms, explorer_url):
        super().__init__(
            f"No confirmed or failed result for {tx_hash} within {round(timeout_ms / 1000)} seconds. "
            f"The transaction may still confirm — check {explorer_url} before sending it again, "
            "or you may pay twice.",
            "confirm_timeout",
            extra={"tx_hash": tx_hash, "timeout_ms": timeout_ms},
        )
        self.tx_hash = tx_hash
        self.explorer_url = explorer_url


def is_api_error_body(value):
    """True when ``value`` is the server's ``{ok: False, error: {...}}`` shape."""
    return (
        isinstance(value, dict)
        and value.get("ok") is False
        and isinstance(value.get("error"), dict)
        and isinstance(value["error"].get("code"), str)
    )


def error_from_body(body, status=None):
    """Build a PolypadError from a server error body."""
    error = dict(body["error"])
    code = error.pop("code")
    message = error.pop("message")
    return PolypadError(message, code, status=status, extra=error)
