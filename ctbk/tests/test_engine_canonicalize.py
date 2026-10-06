import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import boto3
import pytest
from click.testing import CliRunner
from pyrmts import S3Storage
from pyrmts_engine.cli import _open_registry

from ctbk import gbfs_cli


@pytest.mark.parametrize('rw', [False, True])
def test_canonicalize_registry_uses_r2_credentials_without_changing_parent(
	monkeypatch: pytest.MonkeyPatch,
	tmp_path: Path,
	rw: bool,
) -> None:
	# Monthly processing inherits an AWS OIDC role for Batch. The engine's
	# generic manifest storage must use R2 instead; stub only the GET so its
	# real boto3 credential/endpoint selection runs without any cloud calls.
	config = tmp_path / 'aws-config'
	config.write_text('[profile aws-role-profile]\nregion = us-east-1\n[profile aws-default-profile]\nregion = us-east-1\n')
	credentials_file = tmp_path / 'aws-credentials'
	credentials_file.write_text('')
	parent = {
		'AWS_ACCESS_KEY_ID': 'a' * 20,
		'AWS_SECRET_ACCESS_KEY': 'aws-role-secret',
		'AWS_SESSION_TOKEN': 'aws-role-session',
		'AWS_SECURITY_TOKEN': 'aws-legacy-session',
		'AWS_PROFILE': 'aws-role-profile',
		'AWS_DEFAULT_PROFILE': 'aws-default-profile',
		'AWS_ENDPOINT_URL': 'https://aws-fixture.invalid',
		'AWS_CONFIG_FILE': str(config),
		'AWS_SHARED_CREDENTIALS_FILE': str(credentials_file),
		'CLOUDFLARE_ACCOUNT_ID': 'fixture-account',
		'R2_ACCESS_KEY_ID': 'd' * 32,
		'R2_SECRET_ACCESS_KEY': 'r2-default-secret',
	}
	if rw:
		parent.update(R2_RW_ACCESS_KEY_ID='w' * 32, R2_RW_SECRET_ACCESS_KEY='r2-write-secret')
	for name in ('R2_RW_ACCESS_KEY_ID', 'R2_RW_SECRET_ACCESS_KEY', 'R2_ENDPOINT_URL'):
		monkeypatch.delenv(name, raising=False)
	for name, value in parent.items():
		monkeypatch.setenv(name, value)
	monkeypatch.setattr(boto3, 'DEFAULT_SESSION', None)
	monkeypatch.setattr(S3Storage, 'get', lambda self, key: b'')
	observed = []

	def run(cmd: list[str], *, env: dict[str, str]) -> SimpleNamespace:
		with patch.dict(os.environ, env, clear=True):
			registry = _open_registry(cmd[cmd.index('-i') + 1], 'rides-start')
			client = registry.storage._client
			credentials = client._request_signer._credentials
			observed.append((
				credentials.access_key,
				credentials.secret_key,
				credentials.token,
				client.meta.endpoint_url,
				tuple(env.get(name) for name in ('AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE')),
			))
		return SimpleNamespace(returncode=0)

	monkeypatch.setattr(gbfs_cli.subprocess, 'run', run)
	result = CliRunner().invoke(gbfs_cli.gbfs, [
		'engine', 'canonicalize', '-C', 'rides-start', '-r', '2026-08-01/2026-10-01',
	])
	assert result.exit_code == 0, result.output
	assert observed == [(
		('w' if rw else 'd') * 32,
		'r2-write-secret' if rw else 'r2-default-secret',
		None,
		'https://fixture-account.r2.cloudflarestorage.com',
		(None, None, None, None),
	)]
	assert {name: os.environ.get(name) for name in parent} == parent
