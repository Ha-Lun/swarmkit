import unittest
from inventory import apply_discount, chunk, parse_qty


class TestApplyDiscount(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(apply_discount(200, 25), 150.0)

    def test_zero_and_full(self):
        self.assertEqual(apply_discount(10, 0), 10)
        self.assertEqual(apply_discount(10, 100), 0)

    def test_rounding(self):
        self.assertEqual(apply_discount(9.99, 33), 6.69)

    def test_invalid_pct(self):
        with self.assertRaises(ValueError):
            apply_discount(10, -1)
        with self.assertRaises(ValueError):
            apply_discount(10, 101)


class TestChunk(unittest.TestCase):
    def test_uneven(self):
        self.assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_empty(self):
        self.assertEqual(chunk([], 3), [])

    def test_larger_than_list(self):
        self.assertEqual(chunk([1, 2], 5), [[1, 2]])

    def test_invalid_n(self):
        for n in (0, -1):
            with self.assertRaises(ValueError):
                chunk([1], n)


class TestParseQty(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_qty("12"), 12)

    def test_suffix_x(self):
        self.assertEqual(parse_qty("3x"), 3)

    def test_whitespace(self):
        self.assertEqual(parse_qty("  7x "), 7)

    def test_invalid(self):
        for s in ("", "x", "abc", "-1", "1.5", "2xx"):
            with self.assertRaises(ValueError, msg=s):
                parse_qty(s)


if __name__ == "__main__":
    unittest.main()
