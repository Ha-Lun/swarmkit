import unittest
from inventory import apply_discount, chunk, parse_qty


class TestApplyDiscount(unittest.TestCase):
    def test_typical_discount(self):
        self.assertEqual(apply_discount(100.0, 25), 75.0)

    def test_zero_percent_returns_price(self):
        self.assertEqual(apply_discount(19.99, 0), 19.99)

    def test_hundred_percent_returns_zero(self):
        self.assertEqual(apply_discount(19.99, 100), 0.0)

    def test_rounds_to_two_decimals(self):
        self.assertEqual(apply_discount(10.0, 33.333), 6.67)

    def test_negative_pct_raises(self):
        with self.assertRaises(ValueError):
            apply_discount(10.0, -1)

    def test_pct_over_100_raises(self):
        with self.assertRaises(ValueError):
            apply_discount(10.0, 101)


class TestChunkExtra(unittest.TestCase):
    def test_uneven_keeps_short_final_chunk(self):
        self.assertEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])

    def test_n_larger_than_length_returns_single_chunk(self):
        self.assertEqual(chunk([1, 2], 10), [[1, 2]])

    def test_n_equal_to_length_returns_single_chunk(self):
        self.assertEqual(chunk([1, 2, 3], 3), [[1, 2, 3]])

    def test_empty_input_returns_empty_list(self):
        self.assertEqual(chunk([], 3), [])

    def test_n_of_one(self):
        self.assertEqual(chunk(["a", "b"], 1), [["a"], ["b"]])

    def test_zero_n_raises(self):
        with self.assertRaises(ValueError):
            chunk([1, 2], 0)

    def test_negative_n_raises(self):
        with self.assertRaises(ValueError):
            chunk([1, 2], -2)


class TestParseQty(unittest.TestCase):
    def test_plain_digits(self):
        self.assertEqual(parse_qty("42"), 42)

    def test_trailing_x_is_stripped(self):
        self.assertEqual(parse_qty("3x"), 3)

    def test_surrounding_whitespace_is_stripped(self):
        self.assertEqual(parse_qty("  7  "), 7)

    def test_whitespace_before_trailing_x(self):
        self.assertEqual(parse_qty(" 5x "), 5)

    def test_zero(self):
        self.assertEqual(parse_qty("0"), 0)

    def test_only_one_x_is_stripped(self):
        with self.assertRaises(ValueError):
            parse_qty("3xx")

    def test_bare_x_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("x")

    def test_empty_string_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("")

    def test_negative_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("-1")

    def test_decimal_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("1.5")

    def test_inner_space_raises(self):
        with self.assertRaises(ValueError):
            parse_qty("3 x")

    def test_error_message_includes_value(self):
        with self.assertRaisesRegex(ValueError, "bad quantity"):
            parse_qty("abc")


if __name__ == "__main__":
    unittest.main()
