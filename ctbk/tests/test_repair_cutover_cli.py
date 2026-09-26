"""Candidate-rollout CLI pieces (`specs/station-id-trailing-zero.md` §Candidate
rollout): content-addressed asset keys, and `normalized-mirror`'s same-bytes
skip + destination prefix."""
import hashlib
import os

import pytest

from ctbk.gbfs_cli import _mirror_normalized
from ctbk.r2_keys import content_key


def test_content_key():
    body = b'{"s:364": "c:4452.01"}'
    h = hashlib.md5(body).hexdigest()[:12]
    assert [content_key('stations/station-canonicalize-map.json', body), content_key('station-luc', body)] == [
        f'stations/station-canonicalize-map.{h}.json', f'station-luc.{h}',
    ]


class ClientError(Exception):
    def __init__(self, code):
        self.response = {'Error': {'Code': code}}


class R2:
    """head/copy stand-in: `objs` = key → (etag, size)."""
    class exceptions:
        ClientError = ClientError

    def __init__(self, objs):
        self.objs, self.copies = objs, []

    def head_object(self, Bucket, Key):
        if Key not in self.objs:
            raise ClientError('404')
        etag, size = self.objs[Key]
        return {'ETag': f'"{etag}"', 'ContentLength': size}

    def copy_object(self, Bucket, Key, CopySource):
        self.copies.append((CopySource['Key'], Key))


MD5 = '0123456789abcdef0123456789abcdef'


@pytest.fixture
def repo(tmp_path):
    d = tmp_path / 's3/ctbk/normalized'
    d.mkdir(parents=True)
    (d / '201801.parquet.dvc').write_text(f'outs:\n- md5: {MD5}\n  size: 100\n  path: 201801.parquet\n')
    cwd = os.getcwd()
    os.chdir(tmp_path)
    yield
    os.chdir(cwd)


SRC = f'.dvc/files/md5/{MD5[:2]}/{MD5[2:]}'


def test_same_bytes_skip(repo):
    r2 = R2({'normalized/201801.parquet': (MD5, 100)})
    _mirror_normalized(r2, 'ctbk', '201801', dry_run=False)
    assert r2.copies == []


def test_same_size_different_bytes_copies(repo):
    r2 = R2({'normalized/201801.parquet': ('f' * 32, 100)})
    _mirror_normalized(r2, 'ctbk', '201801', dry_run=False)
    assert r2.copies == [(SRC, 'normalized/201801.parquet')]


def test_candidate_prefix(repo):
    r2 = R2({'normalized/201801.parquet': (MD5, 100)})
    _mirror_normalized(r2, 'ctbk', '201801', dry_run=False, dest_prefix='normalized-next/')
    assert r2.copies == [(SRC, 'normalized-next/201801.parquet')]


def test_multipart_etag_falls_back_to_size(repo):
    r2 = R2({'normalized/201801.parquet': ('abc-3', 100)})
    _mirror_normalized(r2, 'ctbk', '201801', dry_run=False)
    assert r2.copies == []
