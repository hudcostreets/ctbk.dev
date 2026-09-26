"""`gbfs/engine/ctbk_engine_src.normalized_io`: a candidate rides build reads
its monthly tiles from `CTBK_NORMALIZED_PREFIX` (specs/station-id-trailing-zero.md
§Candidate rollout) while tiles keep their `normalized/<YM>.parquet` keys."""
import importlib.util
from pathlib import Path

SRC = Path(__file__).parents[3] / 'gbfs' / 'engine' / 'ctbk_engine_src.py'


def load_src():
    spec = importlib.util.spec_from_file_location('ctbk_engine_src', SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Storage:
    def __init__(self, objs: dict[str, bytes]):
        self.objs, self.gets = objs, []

    def list(self, prefix: str):
        return [k for k in self.objs if k.startswith(prefix)]

    def get(self, key: str):
        self.gets.append(key)
        return self.objs.get(key)


OBJS = {
    'normalized/201801.parquet': b'live',
    'normalized-next/201801.parquet': b'candidate',
    'normalized-next/201802.parquet': b'candidate-2',
    'normalized-next/README.txt': b'',
}


def test_default_prefix_is_live():
    storage = Storage(OBJS)
    available, fetch = load_src().normalized_io(storage)
    assert (available, fetch('normalized/201801.parquet'), storage.gets) == (
        {'201801'}, b'live', ['normalized/201801.parquet'],
    )


def test_candidate_prefix_lists_and_fetches_elsewhere():
    storage = Storage(OBJS)
    available, fetch = load_src().normalized_io(storage, 'normalized-next/')
    assert (available, fetch('normalized/201801.parquet'), storage.gets) == (
        {'201801', '201802'}, b'candidate', ['normalized-next/201801.parquet'],
    )
