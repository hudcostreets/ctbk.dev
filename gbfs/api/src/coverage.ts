/**
 * Fleet-wide observed-minute coverage — the "lost minutes" signal for `/health`.
 *
 * Source: `empty-v1p/coverage/<YYYY-MM-DD>.json`, one per UTC day, written by
 * `ctbk gbfs empty build` from the `observed` bit plane (see
 * `specs/avail-empty-bitmaps.md` §9.2). Each carries the day's live-station
 * count, per-minute observed-station counts, and the gap runs (minutes where
 * fewer than half the live stations were observed) as `[start, length, minCount]`.
 * Unlike the poll-file count, it sees partial-feed minutes and distinguishes a
 * continuous outage from a sagging `last_updated` cadence (many 1-minute runs).
 *
 *   GET /api/coverage?from=YYYY-MM-DD&to=YYYY-MM-DD[&counts=1]
 *   GET /api/coverage/YYYY-MM-DD
 */

export const COVERAGE_PREFIX = 'empty-v1p/coverage';
/** First day with a daily status parquet (and so a coverage doc). */
export const COVERAGE_GENESIS = '2026-04-07';
/** Range cap: `all history` stays a single request for a few years. */
export const MAX_DAYS = 1500;

export interface CoverageDay {
	day: string;
	/** Stations with ≥1 observation that day. */
	live: number;
	/** Minutes with ≥50% of live stations observed. */
	observed_minutes: number;
	/** `[start_minute, length, min_observed_count]` runs below the 50% threshold. */
	gaps: Array<[number, number, number]>;
	/** Per-minute observed-station counts (1440); only when requested. */
	counts?: number[];
}

export interface CoverageRange {
	from: string;
	to: string;
	days: CoverageDay[];
	/** Days in range with no coverage doc yet (today, or a day whose build hasn't run). */
	missing: string[];
}

export function coverageKey(day: string): string {
	return `${COVERAGE_PREFIX}/${day}.json`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(s: string): boolean {
	return DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function utcDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
	return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
}

/** Inclusive `[from, to]` as UTC day strings. Throws on malformed / inverted / oversized ranges. */
export function daysBetween(from: string, to: string): string[] {
	if (!isDay(from) || !isDay(to)) throw new Error(`bad day: from=${from} to=${to}`);
	const n = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
	if (n < 1) throw new Error(`from > to: ${from} > ${to}`);
	if (n > MAX_DAYS) throw new Error(`range too large: ${n} days > ${MAX_DAYS}`);
	return Array.from({ length: n }, (_, i) => addDays(from, i));
}

/** Default window: the 30 days ending yesterday (UTC) — today has no doc until the daily build. */
export function defaultCoverageRange(now: Date = new Date()): { from: string; to: string } {
	const to = addDays(utcDay(now), -1);
	return { from: addDays(to, -29), to };
}

export async function coverageRange(
	get: (key: string) => Promise<CoverageDay | null>,
	from: string,
	to: string,
	withCounts = false,
): Promise<CoverageRange> {
	const days = daysBetween(from, to);
	const docs = await Promise.all(days.map((d) => get(coverageKey(d))));
	const out: CoverageDay[] = [];
	const missing: string[] = [];
	docs.forEach((doc, i) => {
		if (!doc) {
			missing.push(days[i]);
			return;
		}
		const { counts, ...rest } = doc;
		out.push(withCounts ? { ...rest, counts } : rest);
	});
	return { from, to, days: out, missing };
}
