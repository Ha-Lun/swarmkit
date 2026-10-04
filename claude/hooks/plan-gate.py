#!/usr/bin/env python3
"""UserPromptSubmit hook: remind the main agent to enter plan mode first for T2/T3 work.

Prints additionalContext JSON or nothing. Always exits 0 (exit 2 would block the prompt).
"""
import json
import re
import sys

REMINDER = (
    'SwarmKit plan-mode gate: classify this request T0-T3 before any tool call. '
    'If it is a NEW T2/T3 request (edits beyond T1 limits, new behaviour, unclear scope, '
    'or anything you would delegate) and not a continuation of an already-approved plan, '
    'your FIRST tool call must be EnterPlanMode so Opus plans. Never present a T2/T3 plan '
    'in chat. T0/T1 never enter plan mode.'
)
APPROVAL = re.compile(r'(go ahead|yes|ok|approved|continue|commit|proceed)\b', re.I)


def main():
    try:
        data = json.loads(sys.stdin.read())
        prompt = (data.get('prompt') or '').strip()
        if (data.get('permission_mode') == 'plan' or data.get('is_continuation')
                or prompt.startswith('/') or len(prompt) < 40
                or (len(prompt) < 120 and APPROVAL.match(prompt))):
            return
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit',
                                                 'additionalContext': REMINDER}}))
    except Exception:  # noqa: BLE001 - a broken hook must never block the prompt
        return


if __name__ == '__main__':
    main()
    sys.exit(0)
