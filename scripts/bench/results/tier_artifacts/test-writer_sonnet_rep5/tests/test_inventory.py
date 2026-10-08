import unittest
from inventory import apply_discount, chunk, parse_qty


class TestApplyDiscount(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(apply_discount(200, 25), 150.0)

    def test_zero_pct(self):
        self.assertEqual(apply_discount(19.99, 0), 19.99)

    def test_full_discount(self):
        self.assertEqual(apply_discount(50, 100), 0)

    def test_rounds_to_two_places(self):
        self.assertEqual(apply_discount(10, 33), 6.7)

    def test_negative_pct(self):
        with self.assertRaises(ValueError):
            apply_discount(10, -1)

    def test_pct_over_100(self):
        with self.assertRaises(ValueError):
            apply_discount(10, 101)


class TestChunk(unittest.TestCase):
    def test_uneven(self):
        self.assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_empty(self):
        self.assertEqual(chunk([], 3), [])

    def test_n_larger_than_len(self):
        self.assertEqual(chunk([1, 2], 5), [[1, 2]])

    def test_string(self):
        self.assertEqual(chunk("abcd", 3), ["abc", "d"])

    def test_zero_n(self):
        with self.assertRaises(ValueError):
            chunk([1], 0)

    def test_negative_n(self):
        with self.assertRaises(ValueError):
            chunk([1], -2)


class TestParseQty(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_qty("12"), 12)

    def test_x_suffix(self):
        self.assertEqual(parse_qty("3x"), 3)

    def test_whitespace(self):
        self.assertEqual(parse_qty("  7x "), 7)

    def test_empty(self):
        with self.assertRaises(ValueError):
            parse_qty("")

    def test_only_x(self):
        with self.assertRaises(ValueError):
            parse_qty("x")

    def test_non_numeric(self):
        with self.assertRaises(ValueError):
            parse_qty("abc")

    def test_negative(self):
        with self.assertRaises(ValueError):
            parse_qty("-4")

    def test_double_x(self):
        with self.assertRaises(ValueError):
            parse_qty("3xx")


if __name__ == "__main__":
    unittest.main()
