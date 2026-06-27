/**
 * Station-LUC chain builder.
 *
 * Loads `gbfs/station-luc.json` from R2 once per isolate and builds a
 * `station_id (uuid) → S2 cell chain` lookup. The chain is `[L10..L(luc_level)]`
 * — coarsest-to-finest S2 ancestor cells anchored on each station's LUC.
 *
 * Per `ctbk/pyramid_cascade/avail_ingester.py`: cells L10..L(luc_level-1)
 * are computed from the station's lat/lng via `s2Index.latLngToCell`; the
 * stored `cell` at `luc_level` is the canonical anchor (preserves
 * boundary-disambiguation that lat/lng → cell at `luc_level` would lose).
 *
 * If a station_id (uuid) isn't in the LUC denorm, it's skipped at lookup
 * time (caller filters out the resulting `null`s). Real failure mode: a
 * new station spun up since the last LUC refresh — its data lags one
 * refresh, not catastrophic.
 */
import { s2Index } from 'pyrmts-geo';

export const COARSEST_LEVEL = 10;
export const FINEST_LEVEL = 15;
export const STATION_LUC_KEY = 'gbfs/station-luc.json';

interface LucEntry {
	cell: string;
	level: number;
	lat: number;
	lng: number;
	uuid: string;
}

interface StationLucFile {
	by_short_name: Record<string, LucEntry>;
	by_uuid: Record<string, string>;
}

export interface LucIndex {
	/** uuid → [L10cell, L11cell, ..., L(luc_level)cell]. Length varies per
	 *  station (luc_level ranges over 10..15). */
	chains: Map<string, string[]>;
}

let _lucPromise: Promise<LucIndex> | null = null;

/** Load the station-LUC denorm from R2 and build the per-station chains.
 *  Module-level singleton: one network fetch + transform per isolate. */
export function getLucIndex(bucket: R2Bucket): Promise<LucIndex> {
	if (_lucPromise === null) {
		_lucPromise = loadAndBuild(bucket).catch((err) => {
			_lucPromise = null;
			throw err;
		});
	}
	return _lucPromise;
}

async function loadAndBuild(bucket: R2Bucket): Promise<LucIndex> {
	const obj = await bucket.get(STATION_LUC_KEY);
	if (!obj) throw new Error(`station-luc missing at R2 key ${STATION_LUC_KEY}`);
	const data = (await obj.json()) as StationLucFile;
	return buildChains(data);
}

export function buildChains(data: StationLucFile): LucIndex {
	const chains = new Map<string, string[]>();
	for (const [uuid, shortName] of Object.entries(data.by_uuid)) {
		const entry = data.by_short_name[shortName];
		if (!entry) continue;
		const chain: string[] = [];
		// Compute coarser ancestors via lat/lng. Range [COARSEST_LEVEL, luc_level).
		for (let lvl = COARSEST_LEVEL; lvl < entry.level; lvl++) {
			chain.push(s2Index.latLngToCell(entry.lat, entry.lng, lvl));
		}
		// Pin the LUC anchor itself (handles boundary disambiguation).
		chain.push(entry.cell);
		chains.set(uuid, chain);
	}
	return { chains };
}
