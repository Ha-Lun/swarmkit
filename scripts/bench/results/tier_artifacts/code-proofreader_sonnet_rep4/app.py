import hashlib
import json
import sys

_unused_cache = {}


def calc_total(items):
    return sum(i["price"] * i["qty"] for i in items)


def legacy_format_price(p):
    return "$%.2f" % p


def render_receipt(items):
    return json.dumps({"total": calc_total(items), "items": items})


def handle_refund(order):
    return {"refunded": order}


def handle_cancel(order):
    return {"cancelled": order}


def dispatch(kind, order):
    return getattr(sys.modules[__name__], "handle_" + kind)(order)
