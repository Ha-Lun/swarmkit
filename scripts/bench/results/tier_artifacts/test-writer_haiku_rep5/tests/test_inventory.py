import unittest
from inventory import apply_discount, chunk, parse_qty


class TestApplyDiscount(unittest.TestCase):
    def test_zero_percent_returns_price(self):
        self.assertEqual(apply_discount(50.0, 0), 50.0)

    def test_hundred_percent_returns_zero(self):
        self.assertEqual(apply_discount(50.0, 100), 0.0)

    def test_quarter_off(self):
        self.assertEqual(apply_discount(80.0, 25), 60.0)

    def test_rounds_to_two_places(self):
        self.assertEqual(apply_discount(19.99, 10), 17.99)

    def test_negative_pct_raises(self):
        with self.assertRaises(ValueError):
            apply_discount(10.0, -1)

    def test_pct_over_100_raises(self):
        with self.assertRaises(ValueError):
            apply_discount(10.0, 101)


class TestChunk(unittest.TestCase):
    def test_even(self):
        self.assertEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])

    def test_uneven_leaves_short_tail(self):
        self.assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_n_larger_than_length(self):
        self.assertEqual(chunk([1, 2], 5), [[1, 2]])

    def test_empty_list(self):
        self.assertEqual(chunk([], 3), [])

    def test_zero_n_raises(self):
        with self.assertRaises(ValueError):
            chunk([1, 2, 3], 0)

    def test_negative_n_raises(self):
        with self.assertRaises(ValueError):
            chunk([1, 2, 3], -2)


class TestParseQty(unittest.TestCase):
    def test_plain_digits(self):
        self.assertEqual(parse_qty("3"), 3)

    def test_trailing_x_is_stripped(self):
        self.assertEqual(parse_qty("3x"), 3)

    def test_surrounding_whitespace(self):
        self.assertEqual(parse_qty("  7x  "), 7)

    def test_zero(self):
        self.assertEqual(parse_qty("0"), 0)

    def test_bare_x_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("x")

    def test_empty_string_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("")

    def test_non_numeric_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("abc")

    def test_negative_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("-1")

    def test_double_x_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("3xx")


if __name__ == "__main__":
    unittest.main()
