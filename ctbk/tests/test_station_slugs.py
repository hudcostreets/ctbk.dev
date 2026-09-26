"""Slug rules of `gbfs/d1/load_station_slugs.py` (a standalone script)."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

_path = Path(__file__).parents[2] / 'gbfs' / 'd1' / 'load_station_slugs.py'
_spec = spec_from_file_location('load_station_slugs', _path)
slugs = module_from_spec(_spec)
_spec.loader.exec_module(slugs)


@pytest.mark.parametrize('name, slug', [
    ('Lafayette Ave & Classon Ave', 'lafayette+classon'),
    ('W 52 St & 11 Ave', 'w52+11'),
    ('11 Ave & W 59 St', '11+w59'),
    ('1 Ave & E 16 St', '1+e16'),
    ('S 5th St & Kent Ave', 's5+kent'),
    ('Madison Ave & E 26 St', 'madison+e26'),
    ('Central Park W & W 97 St', 'central-park-w+w97'),
    ('Adam Clayton Powell Blvd & W 123 St', 'adam-clayton-powell+w123'),
    ('Hoboken Terminal - Hudson St & Hudson Pl', 'hoboken-terminal-hudson-st+hudson-pl'),
    ('S 5 Pl & S 5 St', 's5pl+s5st'),
    ('Ave A & E 11 St', 'ave-a+e11'),
    ('10 Hudson Yards', '10-hudson-yards'),
    ('Grove St PATH', 'grove-st-path'),
    ('Journal Square', 'journal-square'),
])
def test_compact_slug(name, slug):
    assert slugs.compact_slug(name) == slug


def test_resolve_slugs_collisions():
    canonical = {
        # One site, two ids: the active one gets the plain slug.
        '312': {'name': 'Allen St & Stanton St', 'last_seen': '2019-12-31'},
        '5484.09': {'name': 'Allen St & Stanton St', 'last_seen': None},
        # Different names: the active one stays plain; the other types the
        # side that differs.
        '4724.03': {'name': 'Washington Ave & Park Ave', 'last_seen': None},
        '4116.09': {'name': 'Washington Ave & Park Pl', 'last_seen': '2024-01-01'},
        '48a': {'name': '48 St & 5 Ave', 'last_seen': None},
        '48b': {'name': '48 Ave & 5 St', 'last_seen': '2025-01-01'},
        '4452.01': {'name': 'Lafayette Ave & Classon Ave', 'last_seen': '2024-06-07'},
    }
    assert slugs.resolve_slugs(canonical, overrides={}) == {
        '312': 'allen+stanton-312',
        '5484.09': 'allen+stanton',
        '4724.03': 'washington+park',
        '4116.09': 'washington+park-pl',
        '48a': '48+5',
        '48b': '48ave+5',
        '4452.01': 'lafayette+classon',
    }
