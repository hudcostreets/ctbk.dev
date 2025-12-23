"""Stage-level DAG for ctbk pipeline visualization.

This is documentation, not load-bearing code. The actual dependencies
are defined in each stage's dep_artifacts() method.
"""
from click import option

from ctbk.cli.base import ctbk

# Stage dependencies: stage -> list of upstream stages
# Keys use CLI aliases (shortest form)
STAGE_DEPS = {
    'zip': [],
    'csv': ['zip'],
    'norm': ['csv'],
    'cons': ['norm'],
    'agg': ['cons'],
    'smh': ['cons'],
    'sm': ['smh', 'agg'],
    'spj': ['sm', 'agg'],
    'ymrgtb-cd': ['agg'],  # fan-in from all months
}

# Full names and descriptions
STAGE_INFO = {
    'zip': ('TripdataZips', 'Import from s3://tripdata'),
    'csv': ('TripdataCsvs', 'Extract and gzip CSVs'),
    'norm': ('NormalizedMonth', 'Normalize & merge regions'),
    'cons': ('ConsolidatedMonth', 'Consolidate by end month'),
    'agg': ('AggregatedMonth', 'Histogram aggregations'),
    'smh': ('StationMetaHist', 'Station metadata histograms'),
    'sm': ('ModesMonthJson', 'Canonical station info'),
    'spj': ('StationPairsJson', 'Station pair JSONs'),
    'ymrgtb-cd': ('YmrgtbCdJson', 'Dashboard aggregation'),
}


def render_ascii() -> str:
    """Render stage DAG as ASCII art."""
    lines = [
        "Stage-level DAG:",
        "",
        "  zip → csv → norm → cons ─┬─→ agg ─┬─→ ymrgtb-cd",
        "                           │        │",
        "                           └─→ smh ─┼─→ sm → spj",
        "                                    │        ↑",
        "                                    └────────┘",
        "",
    ]
    return "\n".join(lines)


def render_mermaid() -> str:
    """Render stage DAG as Mermaid diagram."""
    lines = ["graph LR"]
    for stage, deps in STAGE_DEPS.items():
        class_name, desc = STAGE_INFO[stage]
        # Node definition with tooltip
        lines.append(f'    {stage}["{stage}<br/><small>{desc}</small>"]')
    lines.append("")
    for stage, deps in STAGE_DEPS.items():
        for dep in deps:
            lines.append(f"    {dep} --> {stage}")
    return "\n".join(lines)


def print_dag(fmt: str = 'ascii'):
    """Print stage DAG in specified format."""
    if fmt == 'ascii':
        print(render_ascii())
    elif fmt == 'mermaid':
        print(render_mermaid())
    else:
        raise ValueError(f"Unknown format: {fmt}")


@ctbk.command('dag', help="Show stage-level pipeline DAG")
@option('-f', '--format', 'fmt', default='ascii', type=str, help="Output format: ascii, mermaid")
def dag_cmd(fmt: str):
    """Show stage-level pipeline DAG."""
    print_dag(fmt)


if __name__ == '__main__':
    import sys
    fmt = sys.argv[1] if len(sys.argv) > 1 else 'ascii'
    print_dag(fmt)
