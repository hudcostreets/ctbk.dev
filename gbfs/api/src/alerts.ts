/** GBFS health rules plus a CAS-protected Slack delivery outbox.
 * The pollers live in separate workers; this module reads their timestamped
 * WALs through /api/health. Routine transitions edit a monthly health thread;
 * critical incidents broadcast once and are edited on resolution.
 */
import type { HealthR2, HealthSnapshot } from './health';
import { ALERTS_HEARTBEAT_KEY, getHealthSnapshot, HEALTH_SNAPSHOT_KEY } from './health';
import { updateHealthReport, reportDue, HealthSlackClient, type HealthReportState, type HealthSlack } from './healthReport';

export { isUsPop } from './health';

export interface Rule {
	id: string;
	severity?: 'warning' | 'critical';
	description: string;
	/** Pure function: given a snapshot, return `true` iff firing. */
	check: (s: HealthSnapshot, wasFiring?: boolean) => boolean;
	/** Slack message body when firing (rendered with mrkdwn). */
	firingText: (s: HealthSnapshot) => string;
}

/** Original incident details and delivery identity, retained until recovery. */
export interface FiringEntry {
	firingSince: string;     // ISO timestamp when this rule started firing
	threadTs: string;
	firingText: string;
	/** New delivery uses the monthly report; absent means an old standalone OP. */
	delivery?: 'report';
	incidentTs?: string;
}

export interface AlertState {
	/** Map of `ruleId` → `FiringEntry`. Absent ⇒ rule not currently firing. */
	firing: Record<string, FiringEntry>;
	/** Set while a run posts its transitions to Slack (see `runAlerts`). */
	claim?: { at: string };
	report?: HealthReportState;
	pending?: {
		at: string;
		firing: Record<string, FiringEntry>;
		events: Array<{ id: string; description: string; severity?: Rule['severity']; kind: TransitionKind; firingText?: string; priorEntry?: FiringEntry; delivered?: boolean }>;
	};
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
	return s.feed.coverage?.unexplained ?? s.feed.gaps?.unexplained ?? [];
}

/** Freshness uses the upstream timestamp, so re-uploading a frozen payload
 * cannot make either feed healthy. An unobserved backup is unknown/stale. */
export function feedAgeMinutes(s: HealthSnapshot, source: 'primary' | 'backup'): number {
	const ts = source === 'primary' ? s.feed.drift?.ts : s.feed.backup?.ts;
	if (ts !== undefined && ts !== null) {
		return Number.isFinite(ts) && ts <= Date.now() / 1000 ? (Date.now() / 1000 - ts) / 60 : Infinity;
	}
	return source === 'primary' ? feedStaleMinutes(s) : Infinity;
}

const combinedMissing = (s: HealthSnapshot) => s.feed.coverage?.recent.combined ?? s.feed.gaps?.recentMissing ?? [];
const sourceContext = (s: HealthSnapshot) => {
	const c = s.feed.coverage;
	if (!c || !c.complete) return 'backup coverage unknown';
	return c.recent.combined.length === 0 && c.complete
		? 'combined minute coverage intact across both feeds'
		: `${c.recent.combined.length} recent minute slot(s) absent from both feeds`;
};
const coverageUncertain = (s: HealthSnapshot) => s.feed.coverage?.complete === false || snapshotAgeMinutes(s) > SNAPSHOT_STALE_MIN;

export function feedPop(s: HealthSnapshot): string | null {
	return s.feed.drift?.pop ?? null;
}

/** Distinct health observations in the last ten minutes. Repeated reads of
 *  one LU do not constitute sustained trouble; ignore future/invalid points. */
export function recentFeedLags(s: HealthSnapshot): number[] {
	const now = Date.now() / 1000;
	const points = new Map<number, number>();
	for (const [t, lag] of s.feed.drift?.series ?? []) {
		if (t >= now - 600 && t <= now && Number.isFinite(lag) && lag >= 0) points.set(t, lag);
	}
	return [...points.values()].sort((a, b) => a - b);
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
// An LU remains live for about a minute. Several first sightings already a
// generation late indicate loss risk; POP location alone does not.
const FEED_LAG_RISK_S = 60;
const FEED_LAG_RECOVERY_S = 45;
const FEED_LAG_RISK_SAMPLES = 3;
/** Of D1's 10 GB hard cap (writes fail at the cap — the 2026-09 outage). */
const D1_SIZE_MAX_GB = 8;
const HOURLY_STALE_MIN = 90;
/** Max tip lag per served pyramid, by fill cadence: avail tiers extend every
 *  5 min (Lambda ticks), smg-v1
 *  daily after the ~05:00Z compaction, rides monthly after each tripdata
 *  drop (published ~2 weeks into the following month). */
const PYRAMID_TIP_MAX_HOURS: Record<string, number> = {
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
		severity: 'critical',
		description: `At least one feed observed within ${FEED_STALE_MIN} minutes`,
		check: (s, wasFiring = false) => coverageUncertain(s) ? wasFiring : Math.min(feedAgeMinutes(s, 'primary'), feedAgeMinutes(s, 'backup')) > FEED_STALE_MIN,
		firingText: (s) => {
			const mins = Math.min(feedAgeMinutes(s, 'primary'), feedAgeMinutes(s, 'backup'));
			const ageDesc = mins === Infinity ? 'ever' : `${mins.toFixed(1)} min`;
			return `:rotating_light: *Both GBFS feeds stale or unobserved* — freshest upstream observation ${ageDesc}; neither feed protects new data (threshold: ${FEED_STALE_MIN} min)`;
		},
	},
	{
		id: 'feed-missed-lus',
		severity: 'critical',
		description: 'No combined coverage holes adjacent to a skipped primary tick today',
		check: (s, wasFiring = false) => coverageUncertain(s) ? wasFiring : unexplainedGaps(s).length > 0,
		firingText: (s) => {
			const g = s.feed.gaps!;
			const holes = unexplainedGaps(s);
			const shown = holes.slice(0, 10).join(', ') + (holes.length > 10 ? ', …' : '');
			return `:rotating_light: *GBFS minutes possibly lost* — ${holes.length} minute slot(s) absent from both feeds next to a skipped primary tick (${shown}); ${g.cronSkips} skipped primary tick(s). Backup recovery has been accounted for`;
		},
	},
	{
		id: 'feed-lag',
		description: `At least 3 recent samples, with p90 first-seen lag < ${FEED_LAG_RECOVERY_S}s over the last 10 minutes`,
		check: (s, wasFiring = false) => {
			const lags = recentFeedLags(s);
			if (wasFiring) return lags.length < 3 || lags[Math.floor(lags.length * 0.9)] >= FEED_LAG_RECOVERY_S;
			return lags.filter((lag) => lag >= FEED_LAG_RISK_S).length >= FEED_LAG_RISK_SAMPLES;
		},
		firingText: (s) =>
			`:warning: *Primary GBFS feed delayed (1 of 2 feeds)* — ${recentFeedLags(s).filter((lag) => lag >= FEED_LAG_RISK_S).length} distinct observations first seen ≥ ${FEED_LAG_RISK_S}s late in the last 10 minutes; ${sourceContext(s)}. Minute coverage does not prove every upstream generation was captured` +
			(feedPop(s) ? ` (latest serving POP: ${feedPop(s)})` : ''),
	},
	{
		id: 'feed-generation-gaps',
		severity: 'critical',
		description: 'At most 1 combined coverage hole in the last 10 settled minutes',
		check: (s, wasFiring = false) => coverageUncertain(s) ? wasFiring : combinedMissing(s).length >= (wasFiring ? 2 : 3),
		firingText: (s) =>
			`:rotating_light: *GBFS combined coverage loss* — ${combinedMissing(s).length} minute slots absent from both feeds in the last 10 settled minutes (${combinedMissing(s).join(', ')}); backup recovery has been accounted for. Upstream omission, stale cache, or missed polls may be responsible`,
	},
	{
		id: 'feed-redundancy',
		description: 'Both feeds have timely observations and at most 1 recent missing minute each',
		check: (s, wasFiring = false) => {
			if (coverageUncertain(s)) return wasFiring;
			const c = s.feed.coverage;
			if (!c) return false;
			return Math.max(c.recent.primary.length, c.recent.backup.length) >= (wasFiring ? 2 : 3)
				|| Math.max(feedAgeMinutes(s, 'primary'), feedAgeMinutes(s, 'backup')) > FEED_STALE_MIN;
		},
		firingText: (s) => {
			const c = s.feed.coverage!;
			return `:warning: *GBFS feed redundancy degraded* — primary missing ${c.recent.primary.length}/10 recent minute slots, backup missing ${c.recent.backup.length}/10; ${sourceContext(s)}. Primary age ${fmtAge(feedAgeMinutes(s, 'primary') / 60)}, backup age ${fmtAge(feedAgeMinutes(s, 'backup') / 60)}`;
		},
	},
	{
		id: 'feed-coverage-unknown',
		severity: 'critical',
		description: 'Both feed listings are complete',
		check: (s) => s.feed.coverage?.complete === false,
		firingText: () => ':rotating_light: *GBFS coverage unknown* — a bounded feed listing was truncated; combined coverage cannot be certified',
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
		severity: 'critical',
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
		const isFiring = rule.check(snapshot, wasFiring);
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
	const parsed = await obj.json<unknown>() as { firing?: unknown; claim?: AlertState['claim']; report?: HealthReportState; pending?: AlertState['pending'] };
	const firing = (parsed.firing && typeof parsed.firing === 'object') ? parsed.firing as Record<string, unknown> : {};
	const out: AlertState = { firing: {}, ...(parsed.claim ? { claim: parsed.claim } : {}), ...(parsed.report ? { report: parsed.report } : {}), ...(parsed.pending ? { pending: parsed.pending } : {}) };
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
		opts?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
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

/** Serialize Slack changes with a conditional R2 lease. Delivery checkpoints
 * persist the monthly OP and daily reply before continuing, so partial failures
 * retry known message IDs instead of creating another thread. */
export async function runAlerts(
	r2: AlertR2,
	slackToken: string,
	rules: Rule[] = DEFAULT_RULES,
	db?: D1Database,
	slackClient?: HealthSlack,
): Promise<Transition[]> {
	const [snapshot, loaded] = await Promise.all([currentSnapshot(r2, db), readState(r2)]);
	const { state: prev } = loaded;
	let etag = loaded.etag;
	const transitions: Transition[] = prev.pending ? prev.pending.events.map((event) => ({
		rule: { id: event.id, description: event.description, severity: event.severity, check: () => false, firingText: () => event.firingText ?? '' },
		kind: event.kind, firingText: event.firingText, priorEntry: event.priorEntry,
	})) : diffRules(rules, prev, snapshot);
	const nowIso = new Date().toISOString();
	if (!prev.pending && transitions.length === 0 && !reportDue(prev.report, nowIso)) {
		await writeHeartbeat(r2, 0, Object.keys(prev.firing));
		return [];
	}
	if (prev.claim && Date.now() - Date.parse(prev.claim.at) < CLAIM_TTL_MS) return [];
	if (etag === null) {
		// Conditional creation is necessary too: two first-ever cron runs must
		// not overwrite one another before attempting their lease.
		etag = (await r2.put(STATE_KEY, JSON.stringify(prev), { onlyIf: { etagDoesNotMatch: '*' } }))?.etag ?? null;
		if (etag === null) return [];
	}
	let claimEtag = await writeState(r2, { ...prev, claim: { at: nowIso } }, etag);
	if (claimEtag === null) return [];
	const slack = slackClient ?? new HealthSlackClient({
		token: slackToken, channel: SLACK_CHANNEL, username: SLACK_USERNAME, iconEmoji: SLACK_ICON_EMOJI,
		fetch: (input, init) => fetch(input, init),
	});
	const next: AlertState = structuredClone(prev);
	delete next.claim;
	const checkpoint = async () => {
		const updated = await writeState(r2, { ...next, claim: { at: new Date().toISOString() } }, claimEtag!);
		if (updated === null) throw new Error('alerts: lost state lease; stopping Slack delivery');
		claimEtag = updated;
	};
	try {
		if (!next.pending) {
			const firing = structuredClone(prev.firing);
			for (const t of transitions) {
				if (t.kind === 'firing') firing[t.rule.id] = { firingSince: nowIso, threadTs: '', firingText: t.firingText!, delivery: 'report' };
				else delete firing[t.rule.id];
			}
			next.pending = { at: nowIso, firing, events: transitions.map((t) => ({
				id: t.rule.id, description: t.rule.description, severity: t.rule.severity,
				kind: t.kind, firingText: t.firingText, priorEntry: t.priorEntry,
			})) };
			await checkpoint();
		}
		const batch = next.pending;
		next.report = await updateHealthReport(slack, next.report, batch.firing, transitions, snapshot, batch.at, async (report) => {
			next.report = report;
			await checkpoint();
		});
		for (const event of batch.events) {
			if (event.delivered) continue;
			if (event.kind === 'firing') {
				const entry = batch.firing[event.id];
				entry.threadTs = next.report.threadTs!;
				if (event.severity === 'critical') entry.incidentTs = (await slack.postUrgent(entry.firingText, entry.threadTs)).id;
			} else {
				const prior = event.priorEntry!;
				const ts = prior.incidentTs ?? (prior.delivery === undefined ? prior.threadTs : undefined);
				if (ts) await slack.edit(ts, `${prior.firingText}\n:white_check_mark: *Resolved* — ${event.description} · ${batch.at.slice(0, 16).replace('T', ' ')} UTC`);
			}
			event.delivered = true;
			await checkpoint();
		}
		next.firing = batch.firing;
		delete next.pending;
		delete next.claim;
		if (await writeState(r2, next, claimEtag) === null) throw new Error('alerts: state lease expired');
		await writeHeartbeat(r2, 0, Object.keys(next.firing));
		return transitions;
	} catch (error) {
		console.error('alerts: report delivery failed', error);
		// Keep the last successful delivery checkpoint, release its lease.
		const loaded = await readState(r2);
		if (loaded.etag === claimEtag) {
			delete loaded.state.claim;
			await writeState(r2, loaded.state, claimEtag!);
		}
		await writeHeartbeat(r2, Math.max(1, transitions.length), Object.keys(loaded.state.firing));
		return [];
	}
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
