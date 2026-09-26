"""Masks personal data and secrets before any tool output reaches a model."""
import os
import re

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# 13-19 digits, optionally grouped by spaces or dashes: card numbers.
_CARD = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")
_BEARER = re.compile(r"(?i)\b(bearer|token|api[_-]?key|secret|password)([\"'\s:=]+)[^\s\"',}]{6,}")
_CVV = re.compile(r"(?i)(\"?(?:cvv|card_cvv|creditCardCvv)\"?\s*[:=]\s*\"?)\d{3,4}")

_SECRET_NAMES = ("KEY", "TOKEN", "SECRET", "PASSWORD")


def _secret_values() -> list[str]:
    return [v for k, v in os.environ.items() if any(s in k.upper() for s in _SECRET_NAMES) and len(v) >= 6]


def redact(text: str) -> str:
    for value in _secret_values():
        text = text.replace(value, "[REDACTED]")
    text = _CVV.sub(r"\1[REDACTED]", text)
    text = _CARD.sub(lambda m: "[CARD ****" + re.sub(r"\D", "", m.group())[-4:] + "]", text)
    text = _EMAIL.sub("[EMAIL]", text)
    text = _BEARER.sub(r"\1\2[REDACTED]", text)
    return text
