"""`d1_http.register_rows` over D1 REST stays under its 100-parameter cap."""
from ctbk.pyramid_cascade import d1_http


def test_rest_batches_clamped_to_param_cap(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(d1_http, '_proxy', lambda: None)
    monkeypatch.setattr(d1_http, 'd1_query', lambda sql, params: calls.append(len(params)))
    rows = [
        {'pyramid': 'p', 'tier': '1h', 'shard_dur': '32d', 'period_start': i, 'period_end': i + 1, 'key': f'k{i}', 'written_at': 0}
        for i in range(30)
    ]
    d1_http.register_rows(rows, batch_size=40)
    assert calls == [98, 98, 14]
