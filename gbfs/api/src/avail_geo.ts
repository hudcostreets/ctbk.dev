/**
 * pyrmts-geo CFW glue for ctbk's avail-geo pyramid.
 *
 * Reads h3-cell-keyed `avail-geo/<tier>/<period>.parquet` shards (built by
 * `ctbk avail-geo-build`, see `ctbk/avail_geo.py`). Each shard contains
 * rows at every materialized h3 resolution (9, 7, 5), sorted by
 * `(h3_cell, dt)`. Histograms per metric stored as JSON-string columns
 * (decoded by pyrmts's `histogram` monoid on-the-fly).
 *
 *  Schema (per row):
 *    h3_cell : STRING       (resolution encoded in high bits)
 *    dt      : INT64        unix-seconds — bucket start
 *    bikes   : STRING       JSON {state: minutes}
 *    ebikes  : STRING       JSON
 *    docks   : STRING       JSON
 *    disabled: STRING       JSON
 *    pending : STRING       JSON
 *
 * Endpoint (mounted from `index.ts`):
 *   GET /api/avail-geo?from=&to=&bbox=&bin_budget=&cell_budget=
 */
import {
	type Pyramid,
} from 'pyrmts';
import { r2Storage } from 'pyrmts-cfw';
import { serveGeoQuery } from 'pyrmts-geo';

const METRICS = ['bikes', 'ebikes', 'docks', 'disabled', 'pending'] as const;

/** Common pyramid params; only `dims` differs between rollup + per-cell variants. */
function basePyramidProps(bucket: R2Bucket): Omit<Pyramid, 'dims'> {
	return {
		storage: r2Storage(bucket),
		keyTemplate: 'avail-geo/{tier}/{period}.parquet',
		axis: 'time',
		// `dt` is unix milliseconds (pyrmts time-axis convention). The build
		// script (`ctbk avail-geo-build`) multiplies the source seconds → ms.
		binCol: 'dt',
		metrics: METRICS.map((name) => ({ name, monoid: 'histogram' as const })),
		// Finest → coarsest per pyrmts convention.
		tiers: [
			{ name: 'h1', bin: '1h', shard: '1d' },
			{ name: 'd1', bin: '1d', shard: '1mo' },
			{ name: 'mo1', bin: '1mo', shard: '1y' },
		],
		geo: {
			cellCol: 'h3_cell',
			// Finest first. Each materialized resolution lives inside every shard;
			// planner picks one at query time based on bbox + cell budget.
			resolutions: [9, 7, 5],
		},
	};
}

/** Rollup pyramid — `dims: []` so `stitch` collapses all cells in the bbox
 *  into ONE row per time bucket (system-over-viewport trend). */
export function availGeoPyramid(bucket: R2Bucket): Pyramid {
	return { ...basePyramidProps(bucket), dims: [] };
}

/** Per-cell pyramid — `dims: ['h3_cell']` so `stitch` preserves one row per
 *  `(binStart, h3_cell)` (heatmap-on-map shape). Same underlying shards. */
export function availGeoCellsPyramid(bucket: R2Bucket): Pyramid {
	return { ...basePyramidProps(bucket), dims: [{ name: 'h3_cell', type: 'string' }] };
}

/** HTTP handler for `/api/avail-geo` — rollup over bbox. */
export async function serveAvailGeo(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoQuery({
		pyramid: availGeoPyramid(bucket),
		request,
		cors: corsOrigin !== null && corsOrigin !== undefined,
	});
}

/** HTTP handler for `/api/avail-geo/cells` — per-cell rows preserved. */
export async function serveAvailGeoCells(bucket: R2Bucket, request: Request, corsOrigin: string): Promise<Response> {
	return serveGeoQuery({
		pyramid: availGeoCellsPyramid(bucket),
		request,
		cors: corsOrigin !== null && corsOrigin !== undefined,
	});
}
