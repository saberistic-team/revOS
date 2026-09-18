import unittest
from app import title

class Validation(unittest.TestCase):
    def test_title_is_normalized(self):
        self.assertEqual(title('  Synthetic requirement '), 'Synthetic requirement')
    def test_invalid_input_is_rejected(self):
        for value in ('', '  ', 'x' * 201, None, 23):
            with self.assertRaises(ValueError):
                title(value)
