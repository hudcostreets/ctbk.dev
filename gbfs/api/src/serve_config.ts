/**
 * Serve-path inputs a data repair can swap: the rides pyramids' D1 registry
 * name, and the R2 keys of the station registry + rides id-map assets.
 *
 * Defaults are prod's. A candidate rollout (`specs/station-id-trailing-zero.md`
 * §Candidate rollout) points the dev worker at candidate data via `vars`
 * (`[env.dev.vars]` in `wrangler.toml`): content-addressed asset keys written
 * beside the live ones, and a `rides-next` registry name whose rows point at
 * the candidate build's (content-hashed) shards. Cutover flips prod the same
 * way, or copies the candidate assets onto the default keys.
 *
 * Module state, set per invocation by `configureServe(env)` at the top of each
 * handler: the values are per-deployment constants, so every request in an
 * isolate sets the same ones.
 */

export interface ServeEnv {
	/** D1 registry name base for `/api/rides*`: pyramids `${name}-{start,end}`
	 *  (R2 keys stay under `rides/{start,end}/`). */
	RIDES_PYRAMID?: string;
	/** `station-luc.json` (station → LUC registry). */
	STATION_LUC_KEY?: string;
	/** `stations/station-canonicalize-map.json` (rides `identityRollup.map`). */
	CANON_MAP_KEY?: string;
	/** `stations/rides-extra-stations.json` (rides vocab supplement). */
	EXTRA_STATIONS_KEY?: string;
}

export const DEFAULTS = {
	ridesPyramid: 'rides',
	stationLucKey: 'station-luc.json',
	canonMapKey: 'stations/station-canonicalize-map.json',
	extraStationsKey: 'stations/rides-extra-stations.json',
} as const;

let cfg: { ridesPyramid: string; stationLucKey: string; canonMapKey: string; extraStationsKey: string } = { ...DEFAULTS };

export function configureServe(env: ServeEnv): void {
	cfg = {
		ridesPyramid: env.RIDES_PYRAMID || DEFAULTS.ridesPyramid,
		stationLucKey: env.STATION_LUC_KEY || DEFAULTS.stationLucKey,
		canonMapKey: env.CANON_MAP_KEY || DEFAULTS.canonMapKey,
		extraStationsKey: env.EXTRA_STATIONS_KEY || DEFAULTS.extraStationsKey,
	};
}

export const ridesPyramidBase = () => cfg.ridesPyramid;
export const ridesPyramidName = (anchor: 'start' | 'end') => `${cfg.ridesPyramid}-${anchor}`;
export const stationLucKey = () => cfg.stationLucKey;
export const canonMapKey = () => cfg.canonMapKey;
export const extraStationsKey = () => cfg.extraStationsKey;
