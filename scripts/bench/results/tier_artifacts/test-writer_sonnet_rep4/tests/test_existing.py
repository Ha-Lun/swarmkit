import unittest
from inventory import chunk


class TestChunk(unittest.TestCase):
    def test_even(self):
        self.assertEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])


if __name__ == "__main__":
    unittest.main()
