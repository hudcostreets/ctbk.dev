"""Tests for the single-gap Lambda path (`specs/avail-v3-lambda-rebuild.md`):
the gap event wire format shared by the fan-out driver and the handler,
and the `_luc_chains` container-cache invalidation that keeps a warm
Lambda from rebuilding shards through a pre-re-key denorm.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timedelta, timezone

import s2cell
from pyrmts import ExpectedShard

from ctbk.pyramid_cascade import lambda_exec
from ctbk.pyramid_cascade.lambda_exec import _luc_chains, decode_gap, encode_gap

GAP = ExpectedShard(
    tier='1m',
    shard_dur='2d',
    period_start=datetime(2026, 7, 14, tzinfo=timezone.utc),
    period_end=datetime(2026, 7, 16, tzinfo=timezone.utc),
    effective_start=datetime(2026, 7, 14, tzinfo=timezone.utc),
    effective_end=datetime(2026, 7, 16, tzinfo=timezone.utc),
    key='avail-v3/1m/2d/2026-07-14.parquet',
)


class TestGapEvent:
    def test_encode_wire_format(self):
        """The payload IS the contract between driver and handler —
        pin it exactly."""
        assert encode_gap(GAP) == {
            'tier': '1m',
            'shard_dur': '2d',
            'period_start': '2026-07-14T00:00:00+00:00',
            'period_end': '2026-07-16T00:00:00+00:00',
            'key': 'avail-v3/1m/2d/2026-07-14.parquet',
        }

    def test_round_trip(self):
        assert decode_gap(encode_gap(GAP)) == GAP

    def test_round_trip_survives_json(self):
        """Driver → Lambda payloads go through json.dumps/loads."""
        assert decode_gap(json.loads(json.dumps(encode_gap(GAP)))) == GAP


# One station, LUC at level 12 → chain = [L10, L11, LUC cell].
STATION = {'lat': 40.7192, 'lng': -74.0432, 'level': 12}
STATION['cell'] = s2cell.lat_lon_to_token(STATION['lat'], STATION['lng'], 12)
DENORM = {
    'by_uuid': {'uuid-1': 'JC013'},
    'by_short_name': {'JC013': STATION},
}
EXPECTED_CHAINS = {
    'uuid-1': [
        s2cell.lat_lon_to_token(STATION['lat'], STATION['lng'], 10),
        s2cell.lat_lon_to_token(STATION['lat'], STATION['lng'], 11),
        STATION['cell'],
    ],
}


class FakeR2:
    """`get_object` stub serving the station-luc denorm; counts fetches."""
    def __init__(self):
        self.fetches = 0

    def get_object(self, Bucket: str, Key: str):
        self.fetches += 1
        return {'Body': io.BytesIO(json.dumps(DENORM).encode())}


class TestLucChainsCache:
    def setup_method(self):
        lambda_exec._luc_chains_cache = None

    def test_builds_ancestor_chains(self):
        assert _luc_chains(FakeR2()) == EXPECTED_CHAINS

    def test_cached_within_container(self):
        r2 = FakeR2()
        _luc_chains(r2)
        _luc_chains(r2)
        assert r2.fetches == 1

    def test_fetched_after_in_past_keeps_cache(self):
        r2 = FakeR2()
        _luc_chains(r2)
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        assert _luc_chains(r2, fetched_after=past) == EXPECTED_CHAINS
        assert r2.fetches == 1

    def test_fetched_after_in_future_refetches(self):
        """A `stale_before` newer than the cached fetch = the container
        cached the OLD denorm; it must refetch before rebuilding."""
        r2 = FakeR2()
        _luc_chains(r2)
        future = datetime.now(timezone.utc) + timedelta(hours=1)
        assert _luc_chains(r2, fetched_after=future) == EXPECTED_CHAINS
        assert r2.fetches == 2
