"""`consolidated.truncated_decimal_ids`: which station ids `cons` re-pads
with a trailing `0`."""
from ctbk.consolidated import truncated_decimal_ids


def test_only_decimal_ids_are_repadded():
    ids = {
        '5329.1', '5329.10',   # float round-trip dropped the 0 → repad
        '7323.1',              # single-decimal, but no `7323.10` → leave
        '309', '3090',         # two distinct stations (Murray St / N 8 St) → leave
        '364', '3640',         # Lafayette & Classon / Journal Square → leave
        'JC104', 'JC1040',     # non-numeric → leave
        float('nan'),          # missing ids are floats in the frame
    }
    assert truncated_decimal_ids(ids) == {'5329.1'}
