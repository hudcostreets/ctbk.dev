"""Stage-level DAG for ctbk pipeline visualization.

This is documentation, not load-bearing code. The actual dependencies
are defined in each stage's dep_artifacts() method.
"""
import json
import os
import re
import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from click import option

from ctbk.cli.base import ctbk

# Stage dependencies: stage -> list of upstream stages
# Keys use CLI aliases (shortest form)
# Note: normalization reads CSVs directly from ZIPs, no intermediate csv stage
STAGE_DEPS = {
    'zip': [],
    'norm': ['zip'],
    'cons': ['norm'],
    'agg': ['cons'],
    'smh': ['cons'],
    'sm': ['smh', 'agg'],
    'spj': ['sm', 'agg'],
    'ymrgtb-cd': ['agg'],  # fan-in from all months
}

# Full names and descriptions
STAGE_INFO = {
    'zip': ('TripdataZips', 'Import from s3://tripdata', '🗜️', '#795548'),
    'csv': ('TripdataCsvs', 'Extract and gzip CSVs', '📄', '#8BC34A'),
    'norm': ('NormalizedMonth', 'Normalize & merge regions', '📊', '#4CAF50'),
    'cons': ('ConsolidatedMonth', 'Consolidate by end month', '📦', '#2196F3'),
    'agg': ('AggregatedMonth', 'Histogram aggregations', '📈', '#FF9800'),
    'smh': ('StationMetaHist', 'Station metadata histograms', '🗺️', '#9C27B0'),
    'sm': ('ModesMonthJson', 'Canonical station info', '📍', '#E91E63'),
    'spj': ('StationPairsJson', 'Station pair JSONs', '🔗', '#00BCD4'),
    'ymrgtb-cd': ('YmrgtbCdJson', 'Dashboard aggregation', '📊', '#3F51B5'),
    'partition': ('Partition', 'Partition data', '✂️', '#607D8B'),
    'v0': ('V0 Legacy', 'Legacy v0 data', '📜', '#9E9E9E'),
    'unknown': ('Unknown', 'Unknown stage', '❓', '#9E9E9E'),
}

# Path patterns to infer stage from file paths (for nodes without cmd)
PATH_PATTERNS = [
    (r's3/ctbk/csvs/', 'csv'),
    (r's3/ctbk/zips/', 'zip'),
    (r'tripdata.*\.zip$', 'zip'),
    (r's3/ctbk/aggregated/.*\.parquet$', 'agg'),
    (r's3/ctbk/normalized/\d{6}\.parquet$', 'cons'),
    (r's3/ctbk/normalized/v0/\d{6}\.parquet$', 'v0'),
    (r's3/ctbk/normalized/\d{6}$', 'norm'),
    (r's3/ctbk/stations/meta_hists/', 'smh'),
]


def render_ascii() -> str:
    """Render stage DAG as ASCII art."""
    lines = [
        "Stage-level DAG:",
        "",
        "  zip → norm → cons ─┬─→ agg ─┬─→ ymrgtb-cd",
        "                     │        │",
        "                     └─→ smh ─┼─→ sm → spj",
        "                              │        ↑",
        "                              └────────┘",
        "",
    ]
    return "\n".join(lines)


def render_mermaid() -> str:
    """Render stage DAG as Mermaid diagram."""
    lines = ["graph LR"]
    for stage, deps in STAGE_DEPS.items():
        class_name, desc, icon, color = STAGE_INFO.get(stage, (stage, '', '❓', '#9E9E9E'))
        lines.append(f'    {stage}["{stage}<br/><small>{desc}</small>"]')
    lines.append("")
    for stage, deps in STAGE_DEPS.items():
        for dep in deps:
            lines.append(f"    {dep} --> {stage}")
    return "\n".join(lines)


def _extract_ym(path: str) -> str | None:
    """Extract YYYYMM from path."""
    match = re.search(r'(\d{6})', path)
    return match.group(1) if match else None


def _get_mtime(path: str) -> str | None:
    """Get mtime of the .dvc file for a given path, formatted as YYYY-MM-DD."""
    dvc_path = Path(f"{path}.dvc")
    if dvc_path.exists():
        mtime = os.path.getmtime(dvc_path)
        return datetime.fromtimestamp(mtime).strftime('%Y-%m-%d')
    return None


def _infer_stage(node: dict, path: str) -> str:
    """Infer stage from cmd or path patterns."""
    cmd = node.get('cmd')
    if cmd:
        parts = cmd.split()
        if len(parts) >= 2 and parts[0] == 'ctbk':
            stage_key = parts[1]
            if stage_key in STAGE_INFO:
                return stage_key

    for pattern, stage_key in PATH_PATTERNS:
        if re.search(pattern, path):
            return stage_key

    return 'unknown'


def _parse_agg_params(cmd: str) -> dict:
    """Parse aggregation parameters from command."""
    params = {}
    if '-g' in cmd or '--group-by' in cmd:
        match = re.search(r'-g\s*(\S+)', cmd)
        if match:
            params['groupBy'] = match.group(1)
    if '-a' in cmd or '--aggregate-by' in cmd:
        match = re.search(r'-a\s*(\S+)', cmd)
        if match:
            params['aggBy'] = match.group(1)
    return params


def _transform_dvx_dag(raw_dag: dict) -> dict:
    """Transform raw DVX dag into visualization-friendly structure."""
    nodes = raw_dag.get('nodes', {})
    edges = raw_dag.get('edges', [])

    # Group nodes by stage
    stages = defaultdict(lambda: {'files': [], 'months': set(), 'totalSize': 0})

    for path, node in nodes.items():
        stage_key = _infer_stage(node, path)
        ym = _extract_ym(path)
        size = node.get('size', 0)

        file_info = {
            'path': path,
            'size': size,
            'md5': node.get('md5'),
        }

        mtime = _get_mtime(path)
        if mtime:
            file_info['mtime'] = mtime

        if node.get('cmd'):
            file_info['cmd'] = node['cmd']
            if stage_key == 'agg':
                file_info['params'] = _parse_agg_params(node['cmd'])

        stages[stage_key]['files'].append(file_info)
        stages[stage_key]['totalSize'] += size
        if ym:
            stages[stage_key]['months'].add(ym)

    # Convert to output format
    result_stages = []
    for key, data in sorted(stages.items(), key=lambda x: len(x[1]['files']), reverse=True):
        class_name, desc, icon, color = STAGE_INFO.get(key, (key, '', '❓', '#9E9E9E'))
        months = sorted(data['months'])
        result_stages.append({
            'key': key,
            'name': class_name,
            'icon': icon,
            'color': color,
            'fileCount': len(data['files']),
            'totalSize': data['totalSize'],
            'monthRange': f"{months[0]}-{months[-1]}" if months else None,
            'files': sorted(data['files'], key=lambda f: f['path']),
        })

    # Compute stage-level edges
    stage_edges = set()
    for edge in edges:
        src = edge.get('from', '')
        dst = edge.get('to', '')
        src_stage = _infer_stage(nodes.get(src, {}), src)
        dst_stage = _infer_stage(nodes.get(dst, {}), dst)
        if src_stage != dst_stage:
            stage_edges.add((src_stage, dst_stage))

    return {
        'stages': result_stages,
        'stageEdges': [{'from': s, 'to': d} for s, d in sorted(stage_edges)],
        'totalNodes': len(nodes),
        'totalEdges': len(edges),
    }


def render_json(input_file: str | None = None) -> str:
    """Generate curated JSON for web visualization from DVX dag."""
    if input_file:
        with open(input_file) as f:
            raw_dag = json.load(f)
    else:
        result = subprocess.run(
            ['dvx', 'dag', '--json'],
            capture_output=True,
            text=True,
            check=True,
        )
        raw_dag = json.loads(result.stdout)

    transformed = _transform_dvx_dag(raw_dag)
    return json.dumps(transformed, indent=2)


def print_dag(fmt: str = 'ascii', output: str | None = None, input_file: str | None = None):
    """Print stage DAG in specified format."""
    if fmt == 'ascii':
        result = render_ascii()
    elif fmt == 'mermaid':
        result = render_mermaid()
    elif fmt == 'json':
        result = render_json(input_file)
    else:
        raise ValueError(f"Unknown format: {fmt}")

    if output:
        Path(output).write_text(result)
        from utz import err
        err(f"Wrote {output}")
    else:
        print(result)


@ctbk.command('dag', help="Show stage-level pipeline DAG")
@option('-f', '--format', 'fmt', default='ascii', type=str, help="Output format: ascii, mermaid, json")
@option('-i', '--input', 'input_file', type=str, help="Input file for json format (default: run `dvx dag --json`)")
@option('-o', '--output', type=str, help="Output file (default: stdout)")
def dag_cmd(fmt: str, input_file: str | None, output: str | None):
    """Show stage-level pipeline DAG."""
    print_dag(fmt, output, input_file)


if __name__ == '__main__':
    import sys
    fmt = sys.argv[1] if len(sys.argv) > 1 else 'ascii'
    print_dag(fmt)
