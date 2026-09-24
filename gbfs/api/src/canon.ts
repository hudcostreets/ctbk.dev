/**
 * Serve-side station selection over materialized canonicalization
 * (`specs/materialized-canonicalization.md` task 4).
 *
 * The `rides/` pyramids store one raw `s:<reported id>` leaf per reported
 * station id, plus — for each *merged* cluster (a canonical station with >1
 * reported id) — a materialized `c:<canonical>` row summing its members
 * (`pyrmts-engine canonicalize`). S2 cell rows are unchanged: they roll up
 * rides by their canonical station's location.
 *
 * Vocab covers (`vocabCover` over the `station-luc.json` registry) emit
 * `s:<short_name>` leaves keyed by canonical short_name, so serving is a
 * rewrite of those leaves against the same map the shards were built with:
 *
 *   - canonical (default): a merged canonical's leaf → its `c:` row; an
 *     unmerged station's leaf is its own raw row, unchanged.
 *   - raw (`?raw=1`): a merged canonical's leaf → each member's raw `s:`
 *     leaf, so `/cells` returns the constituents separately.
 *
 * Either way, a leaf whose id is an *alias* folded into a different
 * canonical is dropped: its rides are already counted under that canonical
 * (in its `c:` row, and in the S2 cells at the canonical's location), so
 * keeping it would double-count inside a region cover. Under `rides-v5`
 * such leaves matched no rows at all, so dropping them is behavior-neutral.
 */

/** Bucket key of the id-map the rides pyramids' `identityRollup.map`
 *  declares (`configs/pyramids/rides-{start,end}.yaml`). */
export const CANON_MAP_KEY = 'stations/station-canonicalize-map.json';

/** Canonicals `station-luc.json` lacks that the rides build places in
 *  vocab cells (`ctbk rides-canonicalize-map`); the rides vocab graph adds
 *  them so partial-cell covers can emit their leaves. */
export const EXTRA_STATIONS_KEY = 'stations/rides-extra-stations.json';

export type LeafMode = 'canonical' | 'raw';

export interface CanonMap {
	/** `s:<raw>` → `c:<canonical>`, merged clusters only (incl. the member
	 *  whose raw id is the canonical id itself). */
	toCanon: Map<string, string>;
	/** `c:<canonical>` → its members' `s:<raw>` leaves, in map order. */
	members: Map<string, string[]>;
}

export function parseCanonMap(obj: Record<string, string>): CanonMap {
	const toCanon = new Map<string, string>();
	const members = new Map<string, string[]>();
	for (const [raw, canon] of Object.entries(obj)) {
		toCanon.set(raw, canon);
		const ms = members.get(canon);
		if (ms) ms.push(raw);
		else members.set(canon, [raw]);
	}
	return { toCanon, members };
}

/** Rewrite a cover's `s:` leaves for `mode` (see module doc). Non-`s:`
 *  terms (S2 cells, explicit `c:` rows) pass through. Order-preserving,
 *  deduplicated. */
export function selectLeaves(include: string[], m: CanonMap, mode: LeafMode): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (t: string) => {
		if (!seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	};
	for (const t of include) {
		if (!t.startsWith('s:')) {
			push(t);
			continue;
		}
		const canon = m.toCanon.get(t);
		if (canon === undefined) {
			push(t);  // unmerged: the raw leaf is the station's only row
		} else if (canon !== `c:${t.slice(2)}`) {
			continue;  // alias of another canonical: counted there
		} else if (mode === 'canonical') {
			push(canon);
		} else {
			for (const raw of m.members.get(canon)!) push(raw);
		}
	}
	return out;
}

let _canonMap: { value: Promise<CanonMap>; ts: number } | null = null;
const CANON_MAP_TTL_MS = 10 * 60_000;

/** The declared id-map from R2, cached per isolate with a TTL (same policy
 *  as the station registry); failures aren't cached. */
export function loadCanonMap(bucket: R2Bucket): Promise<CanonMap> {
	const now = Date.now();
	if (_canonMap && now - _canonMap.ts < CANON_MAP_TTL_MS) return _canonMap.value;
	const value = (async (): Promise<CanonMap> => {
		const obj = await bucket.get(CANON_MAP_KEY);
		if (!obj) throw new Error(`${CANON_MAP_KEY} not found on R2`);
		return parseCanonMap(await obj.json<Record<string, string>>());
	})();
	_canonMap = { value, ts: now };
	value.catch(() => { _canonMap = null; });
	return value;
}
