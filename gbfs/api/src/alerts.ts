/** GBFS health alerting — every-5-minutes cron evaluates rules against the
 *  same `/api/health` snapshot, posts to Slack on firing/resolved transitions.
 *
 *  Design constraints (from user):
 *    1. NEVER block / interfere with the /1min poller (which lives in a
 *       different worker — `gbfs/worker/`). This module reads R2 only.
 *    2. Easy to tweak thresholds (declarative rules below).
 *    3. No false-positive flood — dedupe via R2 state object; only
 *       message on edges (clear→firing, firing→clear); resolved replies
 *       go in the firing message's Slack thread.
 *
 *  Slack transport uses `@rdub/thrds`'s `SlackClient.sync()` so the
 *  firing→resolved transition reads as a thread (OP = firing message,
 *  reply = resolved). State tracks `threadTs` + the original firing
 *  text so the resolve-side `sync()` can pass the right desired-thread.
 *
 *  See `specs/done/slack-notifications.md` for the manual GHA pings;
 *  this module covers the dynamic side (scraper health).
 */
import { SlackClient } from '@rdub/thrds';
import type { HealthR2, HealthSnapshot } from './health';
import { ALERTS_HEARTBEAT_KEY, getHealthSnapshot, HEALTH_SNAPSHOT_KEY } from './health';

export interface Rule {
	id: string;
	description: string;
	/** Pure function: given a snapshot, return `true` iff firing. */
	check: (s: HealthSnapshot) => boolean;
	/** Slack message body when firing (rendered with mrkdwn). */
	firingText: (s: HealthSnapshot) => string;
}

/** Per-rule firing record. Captures the original `firingText` so the
 *  resolved-transition `slack.sync()` can pass `[firingText, resolvedText]`
 *  as the desired thread state (thrds diffs vs existing → SKIP[0]+POST[1]). */
export interface FiringEntry {
	firingSince: string;     // ISO timestamp when this rule started firing
	threadTs: string;        // Slack `ts` of the firing OP — also the thread parent
	firingText: string;      // Frozen at firing time; resolved-sync needs it
}

export interface AlertState {
	/** Map of `ruleId` → `FiringEntry`. Absent ⇒ rule not currently firing. */
	firing: Record<string, FiringEntry>;
	/** Set while a run posts its transitions to Slack (see `runAlerts`). */
	claim?: { at: string };
}

/** R2 key for the dedup state JSON. */
const STATE_KEY = 'gbfs/alerts/state.json';

/** A claim older than this is a run that died mid-post; the next run may
 *  take over (and re-post — at-least-once beats a stuck alert). */
const CLAIM_TTL_MS = 5 * 60_000;

/** Slack channel — kept in code (not secret) for grep-ability. */
const SLACK_CHANNEL = 'C0B5MKF28NP';

/** Bot identity overrides for `#ctbk-bot`. Requires `chat:write.customize`. */
const SLACK_USERNAME = 'ctbk-bot';
const SLACK_ICON_EMOJI = ':bike:';

/** Minutes between "now" and the latest WAL poll. Uses snapshot's
 *  `latestPoll.uploadedAt`. Returns Infinity if no poll observed. */
export function feedStaleMinutes(s: HealthSnapshot): number {
	const latest = s.feed.latestPoll?.uploadedAt;
	if (!latest) return Infinity;
	return (Date.now() - new Date(latest).getTime()) / 60_000;
}

/** Today's WAL holes the poller may have missed (adjacent to a skipped
 *  cron tick) — see `FeedGaps`. Upstream-skipped generations are excluded.
 *  Empty for a snapshot that predates the field. */
export function unexplainedGaps(s: HealthSnapshot): string[] {
	return s.feed.gaps?.unexplained ?? [];
}

/** p90 first-seen lag (`polled_at − ts`, s) over the trailing hour of the
 *  drift series; 0 with too few points to judge. Healthy sampling sees a new
 *  LU within ~15s; a lag near 60s means samples are hitting a stale cache,
 *  and LUs superseded before the cache refreshes are never seen (the
 *  2026-09 SIN CloudFront-cache gaps). */
/** CloudFront POP codes are IATA airport codes + a suffix (`IAD12-P5`).
 *  From non-US POPs Lyft's 2.3 feed lags and skips updates, so the pollers
 *  fetch via a US-placed proxy (`gbfs/fetcher/`); a non-US serving POP means
 *  that path broke. */
const US_POP_PREFIXES = new Set([
	'IAD', 'JFK', 'EWR', 'BOS', 'PHL', 'BWI', 'PIT', 'CLT', 'RDU', 'ATL', 'MIA', 'TPA', 'JAX', 'MCO',
	'ORD', 'DTW', 'CMH', 'IND', 'MSP', 'MCI', 'OMA', 'STL', 'BNA', 'MEM', 'DFW', 'IAH', 'AUS', 'SAT',
	'DEN', 'SLC', 'PHX', 'LAS', 'LAX', 'SFO', 'SJC', 'SEA', 'PDX', 'HIO', 'ANC', 'HNL',
]);

export function feedPop(s: HealthSnapshot): string | null {
	return s.feed.drift?.pop ?? null;
}

export function isUsPop(pop: string): boolean {
	return US_POP_PREFIXES.has(pop.slice(0, 3).toUpperCase());
}

export function feedLagP90Seconds(s: HealthSnapshot): number {
	const series = s.feed.drift?.series ?? [];
	const cutoff = Date.now() / 1000 - 3600;
	const lags = series.filter(([t]) => t >= cutoff).map(([, lag]) => lag).sort((a, b) => a - b);
	if (lags.length < 10) return 0;
	return lags[Math.min(lags.length - 1, Math.floor(0.9 * lags.length))];
}

/** Serving-D1 size in GB; 0 when unknown. */
export function d1SizeGB(s: HealthSnapshot): number {
	return (s.d1?.sizeBytes ?? 0) / 1e9;
}

/** Minutes since most recent hourly compaction (`gbfs/avail/h1/<date>/HH.parquet`). */
export function hourlyCompactionStaleMinutes(s: HealthSnapshot): number {
	const latest = s.compactions.hourly.latestKey;
	if (!latest) return Infinity;
	// Key shape: gbfs/avail/h1/YYYY-MM-DD/HH.parquet
	const m = latest.match(/h1\/(\d{4}-\d{2}-\d{2})\/(\d{2})\.parquet$/);
	if (!m) return Infinity;
	const [_, date, hour] = m;
	// Hour key is the END of the compacted hour, so add 1h for actual coverage cutoff.
	const compactedThroughMs = new Date(`${date}T${hour}:00:00Z`).getTime() + 3_600_000;
	return (Date.now() - compactedThroughMs) / 60_000;
}

/** Hours between "now" and the pyramid's newest registered `period_end`
 *  (`pyramidTips`, dust rungs included) — how far its fill lags. Infinity
 *  if it has no shards; 0 for a snapshot that predates the field. (Not the
 *  cover `segments`: those mark only max-rung boundaries `present`, lagging
 *  a healthy 5-min fill by up to 12h — the 2026-09-25 false alarms.) */
export function pyramidTipAgeHours(s: HealthSnapshot, name: string): number {
	if (s.pyramidTips === undefined) return 0;
	const t = s.pyramidTips[name];
	return t ? (Date.now() - t) / 3_600_000 : Infinity;
}

/** Hours since the loader last upserted `stations` (daily
 *  `station_information`). Infinity if unknown; 0 for a snapshot that
 *  predates the field (cached by a pre-deploy worker version). */
export function stationsStaleHours(s: HealthSnapshot): number {
	if (s.stations === undefined) return 0;
	const t = s.stations?.lastUpdatedAt;
	return t ? (Date.now() / 1000 - t) / 3600 : Infinity;
}

/** Minutes since the snapshot was computed (the minute cron refreshes it). */
export function snapshotAgeMinutes(s: HealthSnapshot): number {
	return (Date.now() / 1000 - s.generatedAt) / 60;
}

/** Default rule set. To tweak thresholds, edit constants here. */
const FEED_STALE_MIN = 5;
const FEED_LAG_P90_MAX_S = 30;
/** Of D1's 10 GB hard cap (writes fail at the cap — the 2026-09 outage). */
const D1_SIZE_MAX_GB = 8;
const HOURLY_STALE_MIN = 90;
/** Max tip lag per served pyramid, by fill cadence: avail tiers extend every
 *  5 min (Lambda ticks), smg-v1
 *  daily after the ~05:00Z compaction, rides monthly after each tripdata
 *  drop (published ~2 weeks into the following month). */
const PYRAMID_TIP_MAX_HOURS: Record<string, number> = {
	'avail-v5': 1,
	'avail-v6': 1,
	'smg-v1': 36,
	'rides-start': 50 * 24,
	'rides-end': 50 * 24,
};
const STATIONS_STALE_HOURS = 36;
const SNAPSHOT_STALE_MIN = 15;

const fmtAge = (h: number) => (h === Infinity ? 'never' : h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(0)}d ago`);

export const DEFAULT_RULES: Rule[] = [
	{
		id: 'feed-stale',
		description: `No WAL poll observed in the last ${FEED_STALE_MIN} minutes`,
		check: (s) => feedStaleMinutes(s) > FEED_STALE_MIN,
		firingText: (s) => {
			const mins = feedStaleMinutes(s);
			const ageDesc = mins === Infinity ? 'ever' : `${mins.toFixed(1)} min`;
			return `:rotating_light: *GBFS feed stale* — no WAL poll in ${ageDesc} (threshold: ${FEED_STALE_MIN} min)`;
		},
	},
	{
		id: 'feed-missed-lus',
		description: 'No WAL holes adjacent to a skipped poller tick today',
		check: (s) => unexplainedGaps(s).length > 0,
		firingText: (s) => {
			const g = s.feed.gaps!;
			const shown = g.unexplained.slice(0, 10).join(', ') + (g.unexplained.length > 10 ? ', …' : '');
			return `:rotating_light: *GBFS minutes possibly lost* — ${g.unexplained.length} WAL hole(s) today next to a skipped poller tick (${shown}); ${g.cronSkips} skipped tick(s), ${g.missing - g.unexplained.length} upstream-skipped generation(s)`;
		},
	},
	{
		id: 'feed-lag',
		description: `p90 first-seen LU lag ≤ ${FEED_LAG_P90_MAX_S}s over the last hour`,
		check: (s) => feedLagP90Seconds(s) > FEED_LAG_P90_MAX_S,
		firingText: (s) =>
			`:warning: *GBFS feed lag* — p90 first-seen lag ${feedLagP90Seconds(s)}s over the last hour (threshold: ${FEED_LAG_P90_MAX_S}s); the poller is likely reading a stale cache and can miss LUs` +
			(feedPop(s) ? ` (serving POP: ${feedPop(s)})` : ''),
	},
	{
		id: 'feed-pop',
		description: 'The 2.3 poller\'s latest snapshot came from a US CloudFront POP',
		check: (s) => { const pop = feedPop(s); return pop !== null && !isUsPop(pop); },
		firingText: (s) =>
			`:rotating_light: *GBFS poller reading a non-US edge* — latest snapshot served by CloudFront \`${feedPop(s)}\`; from non-US POPs Lyft's 2.3 feed skips updates. Check the \`ctbk-gbfs-fetch\` proxy + the pollers' \`FETCH\` binding`,
	},
	{
		id: 'hourly-compaction-stale',
		description: `Hourly compaction has not run in over ${HOURLY_STALE_MIN} minutes`,
		check: (s) => hourlyCompactionStaleMinutes(s) > HOURLY_STALE_MIN,
		firingText: (s) => {
			const mins = hourlyCompactionStaleMinutes(s);
			const ageDesc = mins === Infinity ? 'ever' : `${mins.toFixed(0)} min ago`;
			return `:warning: *Hourly compaction stale* — last shard ${ageDesc} (threshold: ${HOURLY_STALE_MIN} min)`;
		},
	},
	...Object.entries(PYRAMID_TIP_MAX_HOURS).map(([name, maxH]): Rule => ({
		id: `pyramid-tip-stale:${name}`,
		description: `\`${name}\` tip lags more than ${fmtAge(maxH).replace(' ago', '')}`,
		check: (s) => pyramidTipAgeHours(s, name) > maxH,
		firingText: (s) =>
			`:warning: *Pyramid tip stale* — \`${name}\` newest shard ends ${fmtAge(pyramidTipAgeHours(s, name))} (threshold: ${fmtAge(maxH).replace(' ago', '')}); its filler (cascade Lambda / Batch fill / monthly ingest) may be down`,
	})),
	{
		id: 'stations-stale',
		description: `D1 \`stations\` upserted within ${STATIONS_STALE_HOURS}h`,
		check: (s) => stationsStaleHours(s) > STATIONS_STALE_HOURS,
		firingText: (s) =>
			`:warning: *Stations table stale* — loader's daily \`station_information\` upsert last landed ${fmtAge(stationsStaleHours(s))} (threshold: ${STATIONS_STALE_HOURS}h)`,
	},
	{
		id: 'd1-size',
		description: `Serving D1 under ${D1_SIZE_MAX_GB} GB (10 GB hard cap)`,
		check: (s) => d1SizeGB(s) > D1_SIZE_MAX_GB,
		firingText: (s) =>
			`:warning: *D1 near its size cap* — ${d1SizeGB(s).toFixed(2)} GB of 10 GB (threshold: ${D1_SIZE_MAX_GB} GB); writes fail at the cap — prune (\`ctbk gbfs manifest prune\`) or drop superseded rows`,
	},
	{
		id: 'health-snapshot-stale',
		description: `/api/health snapshot refreshed within ${SNAPSHOT_STALE_MIN} min`,
		check: (s) => snapshotAgeMinutes(s) > SNAPSHOT_STALE_MIN,
		firingText: (s) =>
			`:rotating_light: *Health snapshot stale* — last computed ${snapshotAgeMinutes(s).toFixed(0)} min ago; the api worker's minute cron (snapshot / registry reconcile) is failing`,
	},
];

export type TransitionKind = 'firing' | 'resolved';
export interface Transition {
	rule: Rule;
	kind: TransitionKind;
	/** For `firing`: the text to post as the new thread OP. */
	firingText?: string;
	/** For `resolved`: the prior `FiringEntry` so we can re-issue the OP +
	 *  add the resolved reply via `slack.sync()`. */
	priorEntry?: FiringEntry;
}

/** Pure: given previous state + current snapshot, classify each rule's
 *  edge transition (firing / resolved / no-op). Does NOT mutate state —
 *  the integration code applies state changes after Slack succeeds. */
export function diffRules(
	rules: Rule[],
	prev: AlertState,
	snapshot: HealthSnapshot,
): Transition[] {
	const transitions: Transition[] = [];
	for (const rule of rules) {
		const wasFiring = prev.firing[rule.id] !== undefined;
		const isFiring = rule.check(snapshot);
		if (isFiring && !wasFiring) {
			transitions.push({
				rule,
				kind: 'firing',
				firingText: rule.firingText(snapshot),
			});
		} else if (!isFiring && wasFiring) {
			transitions.push({
				rule,
				kind: 'resolved',
				priorEntry: prev.firing[rule.id],
			});
		}
	}
	// A rule removed or renamed while firing would otherwise stay in state
	// (and the heartbeat's `firing`) forever: resolve its thread.
	const ids = new Set(rules.map((r) => r.id));
	for (const [id, priorEntry] of Object.entries(prev.firing)) {
		if (ids.has(id)) continue;
		const retired: Rule = { id, description: `\`${id}\` rule retired`, check: () => false, firingText: () => '' };
		transitions.push({ rule: retired, kind: 'resolved', priorEntry });
	}
	return transitions;
}

export function resolvedText(rule: Rule): string {
	return `:white_check_mark: *Resolved* — ${rule.description}`;
}

/** State plus its R2 etag (`null` when the object doesn't exist yet). */
export async function readState(r2: AlertR2): Promise<{ state: AlertState; etag: string | null }> {
	const obj = await r2.get(STATE_KEY);
	if (!obj) return { state: { firing: {} }, etag: null };
	const parsed = await obj.json<unknown>() as { firing?: unknown; claim?: AlertState['claim'] };
	const firing = (parsed.firing && typeof parsed.firing === 'object') ? parsed.firing as Record<string, unknown> : {};
	const out: AlertState = { firing: {}, ...(parsed.claim ? { claim: parsed.claim } : {}) };
	for (const [id, raw] of Object.entries(firing)) {
		// Tolerate legacy entries (`firing[id]: string`) — drop them; next
		// firing of the same rule will rebuild a proper entry.
		if (raw && typeof raw === 'object' && 'threadTs' in raw && 'firingText' in raw) {
			out.firing[id] = raw as FiringEntry;
		}
	}
	return { state: out, etag: obj.etag };
}

/** R2 binding shape extended with etags and conditional `put` (R2 returns
 *  `null` when `onlyIf` fails). */
export interface AlertR2 extends Omit<HealthR2, 'get' | 'put'> {
	get(key: string): Promise<{ etag: string; json<T = unknown>(): Promise<T> } | null>;
	put(
		key: string,
		body: string,
		opts?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches: string } },
	): Promise<{ etag: string } | null>;
}

/** Write `state` iff the object still has `etag`; returns the new etag, or
 *  `null` if another run wrote in between. */
export async function writeState(r2: AlertR2, state: AlertState, etag: string): Promise<string | null> {
	const obj = await r2.put(STATE_KEY, JSON.stringify(state), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: { etagMatches: etag },
	});
	return obj?.etag ?? null;
}

/** Apply a transition via Slack. Returns the state mutation to merge in
 *  (or `null` if Slack failed — caller decides whether to update state).
 *  Throws nothing — Slack errors are logged + swallowed so one bad rule
 *  doesn't block others. */
export async function applyTransition(
	slack: Pick<SlackClient, 'sync'>,
	t: Transition,
	nowIso: string,
): Promise<{ kind: 'firing'; id: string; entry: FiringEntry } | { kind: 'resolved'; id: string } | null> {
	try {
		if (t.kind === 'firing') {
			const firingText = t.firingText!;
			const result = await slack.sync({ messages: [firingText] });
			return {
				kind: 'firing',
				id: t.rule.id,
				entry: {
					firingSince: nowIso,
					threadTs: result.threadId,
					firingText,
				},
			};
		}
		// resolved: re-state OP + add reply via thrds diff (existing=[OP],
		// desired=[OP, resolved] ⇒ SKIP[0]+POST[1]).
		const prior = t.priorEntry!;
		await slack.sync(
			{ messages: [prior.firingText, resolvedText(t.rule)] },
			{ threadTs: prior.threadTs },
		);
		return { kind: 'resolved', id: t.rule.id };
	} catch (e) {
		console.error(`slack sync failed for rule=${t.rule.id} kind=${t.kind}:`, e);
		return null;
	}
}

/** Entry point for the scheduled handler. Returns the transitions whose
 *  Slack syncs succeeded — useful for tests and logging.
 *
 *  Minute crons overlap (a run can outlast the next tick by a minute), so
 *  two runs can see the same transition. Before posting, a run claims the
 *  state object with a conditional write; a run that loses the race, or
 *  finds a live claim, posts nothing and leaves the transition to the
 *  claimant (2026-10-10: one `feed-missed-lus` firing posted twice, 1.5 s
 *  apart, from overlapping runs). */
export async function runAlerts(
	r2: AlertR2,
	slackToken: string,
	rules: Rule[] = DEFAULT_RULES,
	db?: D1Database,
	slackClient?: Pick<SlackClient, 'sync'>,
): Promise<Transition[]> {
	let [snapshot, { state: prev, etag }] = await Promise.all([
		currentSnapshot(r2, db),
		readState(r2),
	]);
	const transitions = diffRules(rules, prev, snapshot);
	if (transitions.length === 0) {
		await writeHeartbeat(r2, 0, Object.keys(prev.firing));
		return [];
	}
	if (prev.claim && Date.now() - Date.parse(prev.claim.at) < CLAIM_TTL_MS) {
		console.log(`alerts: state claimed at ${prev.claim.at} by another run; skipping`);
		return [];
	}
	if (etag === null) {
		// First run ever: create the object so there's an etag to claim against.
		etag = (await r2.put(STATE_KEY, JSON.stringify(prev)))!.etag;
	}
	const nowIso = new Date().toISOString();
	const claimEtag = await writeState(r2, { ...prev, claim: { at: nowIso } }, etag);
	if (claimEtag === null) {
		console.log('alerts: lost the state claim to another run; skipping');
		return [];
	}

	const slack = slackClient ?? new SlackClient({
		token: slackToken,
		channel: SLACK_CHANNEL,
		username: SLACK_USERNAME,
		iconEmoji: SLACK_ICON_EMOJI,
		// thrds stores `globalThis.fetch` and calls it as `this.fetchImpl(…)`;
		// Workers' fetch throws "Illegal invocation" when `this` isn't the global.
		fetch: (input, init) => fetch(input, init),
	});

	const next: AlertState = { firing: { ...prev.firing } };
	const succeeded: Transition[] = [];
	for (const t of transitions) {
		const result = await applyTransition(slack, t, nowIso);
		if (!result) continue;
		if (result.kind === 'firing') {
			next.firing[result.id] = result.entry;
		} else {
			delete next.firing[result.id];
		}
		succeeded.push(t);
	}
	// Always written (even with every Slack sync failed): it releases the claim.
	if (await writeState(r2, next, claimEtag) === null) {
		console.error('alerts: state changed under our claim (expired mid-post?); overwrote nothing');
	}
	await writeHeartbeat(r2, transitions.length - succeeded.length, Object.keys(next.firing));
	return succeeded;
}

/** The minute cron's cached snapshot, at any age (a stale one is what
 *  `health-snapshot-stale` detects); computed live only if absent. Live
 *  compute without `db` would lack the D1-backed sections (pyramids,
 *  stations), so rules on them would misfire — pass `db`. */
async function currentSnapshot(r2: AlertR2, db?: D1Database): Promise<HealthSnapshot> {
	const cached = await r2.get(HEALTH_SNAPSHOT_KEY);
	return cached ? cached.json<HealthSnapshot>() : getHealthSnapshot(r2, db);
}

async function writeHeartbeat(r2: AlertR2, slackFailures: number, firing: string[]): Promise<void> {
	await r2.put(ALERTS_HEARTBEAT_KEY, JSON.stringify({ ranAt: new Date().toISOString(), slackFailures, firing }), {
		httpMetadata: { contentType: 'application/json' },
	});
}
