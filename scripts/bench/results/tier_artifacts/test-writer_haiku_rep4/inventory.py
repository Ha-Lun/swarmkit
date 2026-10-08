def apply_discount(price, pct):
    if pct < 0 or pct > 100:
        raise ValueError("pct must be between 0 and 100")
    return round(price * (1 - pct / 100), 2)


def chunk(items, n):
    if n <= 0:
        raise ValueError("n must be positive")
    return [items[i:i + n] for i in range(0, len(items), n)]


def parse_qty(s):
    s = s.strip()
    if s.endswith("x"):
        s = s[:-1]
    if not s.isdigit():
        raise ValueError("bad quantity: %r" % s)
    return int(s)
