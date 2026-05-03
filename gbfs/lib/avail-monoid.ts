/**
 * 1m@1m monoid shard schema + helpers (avail-perf-pass Phase 0).
 *
 * Shared by:
 *   - gbfs/worker  (currently only re-exports for existing unit tests; no
 *                   inline parquet write since 609512e9)
 *   - gbfs/loader  (writes one parquet shard per per-minute JSON, on R2
 *                   PutObject events arriving via `gbfs-status-events`)
 *
 * Schema (v1; see specs/avail-perf-pass.md § "Monoid schema"):
 *   station_id : STRING       sort key — enables row-group prune
 *   dt         : INT64        floor(polled_at / 60) * 60
 *   <m>_n      : INT32        count (=1 at cons=1m)
 *   <m>_sum    : DOUBLE       sum
 *   <m>_sum_sq : DOUBLE       sum of squares (for variance)
 * for m in {bikes, ebikes, docks, disabled, pending}.
 *
 * The monoid (n, sum, sum_sq) is reducible by simple addition, so the
 * cascade compactor merges shards into higher cons levels with a single
 * column-wise sum. Per-metric columns are flat (rather than nested),
 * so a query projecting one metric only decodes 3 cols out of 17.
 */

export interface StationStatus {
	station_id: string;
	num_bikes_available: number;
	num_ebikes_available: number;
	num_docks_available: number;
	num_bikes_disabled: number;
	num_docks_disabled: number;
	is_installed: number;
	is_renting: number;
	is_returning: number;
	last_reported: number;
}

export interface MinuteRecord {
	ts: number;
	polled_at: number;
	stations: StationStatus[];
}

export interface ColumnSource {
	name: string;
	data: (string | number | bigint)[];
	type: 'STRING' | 'INT32' | 'INT64' | 'DOUBLE';
}

export const AVAIL_METRICS = [
	{ name: 'bikes',    src: 'num_bikes_available'  as const },
	{ name: 'ebikes',   src: 'num_ebikes_available' as const },
	{ name: 'docks',    src: 'num_docks_available'  as const },
	{ name: 'disabled', src: 'num_bikes_disabled'   as const },
	{ name: 'pending',  src: 'num_docks_disabled'   as const },
] as const;

/** Build columnar data for one 1m@1m shard. Sorts by station_id so
 *  per-station queries can prune by row-group station_id stats. */
export function buildMinuteShard(record: MinuteRecord): ColumnSource[] {
	const stations = [...record.stations].sort((a, b) =>
		a.station_id < b.station_id ? -1 : a.station_id > b.station_id ? 1 : 0,
	);
	const n = stations.length;
	const dt = BigInt(Math.floor(record.polled_at / 60) * 60);

	const stationIds: string[] = new Array(n);
	const dts: bigint[] = new Array(n);
	const perMetric: Record<string, { n: number[]; sum: number[]; sum_sq: number[] }> = {};
	for (const m of AVAIL_METRICS) {
		perMetric[m.name] = { n: new Array(n), sum: new Array(n), sum_sq: new Array(n) };
	}

	for (let i = 0; i < n; i++) {
		const s = stations[i];
		stationIds[i] = s.station_id;
		dts[i] = dt;
		for (const m of AVAIL_METRICS) {
			const v = s[m.src] ?? 0;
			perMetric[m.name].n[i] = 1;
			perMetric[m.name].sum[i] = v;
			perMetric[m.name].sum_sq[i] = v * v;
		}
	}

	const cols: ColumnSource[] = [
		{ name: 'station_id', data: stationIds, type: 'STRING' },
		{ name: 'dt',         data: dts,        type: 'INT64'  },
	];
	for (const m of AVAIL_METRICS) {
		cols.push({ name: `${m.name}_n`,      data: perMetric[m.name].n,      type: 'INT32'  });
		cols.push({ name: `${m.name}_sum`,    data: perMetric[m.name].sum,    type: 'DOUBLE' });
		cols.push({ name: `${m.name}_sum_sq`, data: perMetric[m.name].sum_sq, type: 'DOUBLE' });
	}
	return cols;
}

/** Row-group size for 1m@1m shards: ~10 stations/rg, bounding rg-count
 *  to ~4 per shard for ~2400 stations. Matches the profile the h1
 *  compactor settled on (specs/done/h1-stats-fix.md). */
export const AVAIL_1M_ROW_GROUP_SIZE = 600;

/** Map per-minute JSON key → corresponding 1m@1m parquet key.
 *  `gbfs/status/2026-05-03/12-45.json` → `avail/agg=1m/cons=1m/2026-05-03/1245.parquet`
 *  Throws if the key doesn't match the per-minute JSON shape. */
export function availParquetKeyFromStatusKey(statusKey: string): string {
	const m = statusKey.match(/^gbfs\/status\/(\d{4}-\d{2}-\d{2})\/(\d{2})-(\d{2})\.json$/);
	if (!m) throw new Error(`not a per-minute status key: ${statusKey}`);
	return `avail/agg=1m/cons=1m/${m[1]}/${m[2]}${m[3]}.parquet`;
}
