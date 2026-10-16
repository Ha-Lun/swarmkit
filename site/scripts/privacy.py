#!/usr/bin/env python3
"""Shared privacy checks for the site data exporters (stdlib only)."""


import getpass, json, os, re


class PrivacyError(SystemExit, Exception):
    """Raised when a value looks like a leaked path, secret or prompt."""


MAX_STR = 120


def _static_parts():
    return [
        r"/home/", r"/Users/", r"/root/", r"/tmp/", r"/var/", r"/private/",
        r"[A-Za-z]:\\", r"~/", r"\$HOME", r"file://", r"https?://", r"@",
        r"(?:\d{1,3}\.){3}\d{1,3}",
        r"sk-", r"ghp_", r"gho_", r"github_pat_", r"AKIA", r"xox[abps]-",
        r"AIza", r"glpat-", r"bearer", r"\.opencode-tasks", r"EOF",
        r"[A-Za-z0-9+/=_-]{32,}",
    ]


def _pattern():
    parts = list(_static_parts())
    for value in (getpass.getuser(), getattr(os.uname(), "nodename", None)):
        if value and len(value) >= 3:
            parts.append(re.escape(value))
    return re.compile("|".join(parts), re.IGNORECASE)


def check_private(obj):
    """Raise PrivacyError if any string in *obj* matches the forbidden pattern."""
    pattern = _pattern()

    def check_str(value):
        if len(value) > MAX_STR:
            raise PrivacyError(f"string longer than {MAX_STR} chars")
        if pattern.search(value):
            raise PrivacyError("forbidden string in output")

    if isinstance(obj, str):
        check_str(obj)
        return

    def walk(value):
        if isinstance(value, str):
            check_str(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                walk(key)
                walk(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item)

    walk(obj)
    return None
