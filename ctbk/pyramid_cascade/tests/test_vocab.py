"""Tests for the frozen ragged station-cell vocabulary
(`specs/drop-luc-station-keys.md`): descent rule, ancestor-closed
chains, and the config `chains:` mode switch.
"""
from __future__ import annotations

import s2cell

from ctbk.pyramid_cascade.lambda_exec import parse_chains_mode
from ctbk.pyramid_cascade.vocab import BASE_LEVEL, MAX_LEVEL, build_vocab, station_chain

# Five co-located stations (share every cell down to the L20 cap —
# always > T=4, so descent runs the full depth) + one isolated station
# (its L10 cell holds 1 ≤ T → terminal immediately).
NEAR = (40.7192, -74.0432)
FAR = (40.65, -73.95)
STATIONS = {f'N{i}': NEAR for i in range(5)} | {'F': FAR}

NEAR_TOKENS = [s2cell.lat_lon_to_token(*NEAR, lvl) for lvl in range(BASE_LEVEL, MAX_LEVEL + 1)]
FAR_L10 = s2cell.lat_lon_to_token(*FAR, BASE_LEVEL)


class TestBuildVocab:
    def test_descent_rule(self):
        assert build_vocab(STATIONS, t=4) == set(NEAR_TOKENS) | {FAR_L10}

    def test_higher_threshold_stops_at_base(self):
        assert build_vocab(STATIONS, t=5) == {NEAR_TOKENS[0], FAR_L10}


class TestStationChain:
    def test_dense_station_full_depth(self):
        vocab = build_vocab(STATIONS, t=4)
        assert station_chain(*NEAR, 'N0', vocab) == NEAR_TOKENS + ['s:N0']

    def test_isolated_station_base_only(self):
        vocab = build_vocab(STATIONS, t=4)
        assert station_chain(*FAR, 'F', vocab) == [FAR_L10, 's:F']

    def test_new_area_station_gets_identity_row_only(self):
        """A station in a region with NO vocab cells (frozen vocab
        predates it) still gets its `s:` row — station pages work
        immediately; cells appear at the next vocabulary extension."""
        vocab = build_vocab(STATIONS, t=4)
        assert station_chain(51.5, -0.1, 'LDN1', vocab) == ['s:LDN1']


class TestChainsMode:
    def test_default_is_luc(self):
        assert parse_chains_mode('tiers: []\n') == 'luc'

    def test_vocab_mode(self):
        assert parse_chains_mode('chains: vocab\ntiers: []\n') == 'vocab'
