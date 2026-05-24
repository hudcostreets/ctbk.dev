/** GBFS health alerting — every-5-minutes cron evaluates rules against the
 *  same `/api/health` snapshot, posts to Slack on firing/resolved transitions.
 *
 *  Design constraints (from user):
 *    1. NEVER block / interfere with the /1min poller (which lives in a
 *       different worker — `gbfs/worker/`). This module reads R2 only.
 *    2. Easy to tweak thresholds (declarative rules below).
 *    3. No false-positive flood — dedupe via R2 state object, only
 *       message on edges (clear→firing, firing→clear).
 *
 *  See `specs/done/slack-notifications.md` for the manual GHA pings;
 *  this module covers the dynamic side (scraper health).
 */
import type { HealthR2, HealthSnapshot } from './health';
import { getHealthSnapshot } from './health';

export interface Rule {
	id: string;
	description: string;
	/** Pure function: given a snapshot, return `true` iff firing. */
	check: (s: HealthSnapshot) => boolean;
	/** Slack message body when firing (rendered with mrkdwn). */
	firingText: (s: HealthSnapshot) => string;
}

export interface AlertState {
	/** Map of `ruleId` → ISO timestamp of when it started firing. Absent ⇒ not firing. */
	firing: Record<string, string>;
}

/** R2 key for the dedup state JSON. */
const STATE_KEY = 'gbfs/alerts/state.json';

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

/** Minutes missing in the trailing-hour window. `todayCount`/`todayExpected`
 *  are full-day stats — for hour-level granularity we approximate via:
 *  `expected_in_hour - actual_in_hour`. Since the snapshot doesn't expose
 *  hour-bucketed counts, we use a coarser proxy: how many minutes from
 *  the last hour are missing relative to wall-clock. */
export function trailingHourMissing(s: HealthSnapshot): number {
	// Coarse estimate: total minutes elapsed today − total polls today.
	// In a healthy state this should be ≤1 (the in-flight minute).
	const missing = s.feed.todayExpected - s.feed.todayCount;
	return Math.max(0, missing);
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

/** Default rule set. To tweak thresholds, edit constants here. */
const FEED_STALE_MIN = 5;
const MISSING_MINUTES_MAX = 3;
const HOURLY_STALE_MIN = 90;

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
		id: 'feed-missing-minutes',
		description: `≥${MISSING_MINUTES_MAX} minutes missing from today's WAL polls`,
		check: (s) => trailingHourMissing(s) >= MISSING_MINUTES_MAX,
		firingText: (s) =>
			`:warning: *GBFS poll gaps* — ${trailingHourMissing(s)} minutes missing today (threshold: ${MISSING_MINUTES_MAX})`,
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
];

export interface Transition {
	rule: Rule;
	kind: 'firing' | 'resolved';
	firingSince?: string;       // For 'resolved' — when it had been firing since
	text: string;               // Pre-rendered Slack message
}

/** Pure: given previous state + current snapshot, return new state and the
 *  edge transitions to notify. */
export function diffRules(
	rules: Rule[],
	prev: AlertState,
	snapshot: HealthSnapshot,
	nowIso: string,
): { next: AlertState; transitions: Transition[] } {
	const next: AlertState = { firing: { ...prev.firing } };
	const transitions: Transition[] = [];
	for (const rule of rules) {
		const wasFiring = prev.firing[rule.id] !== undefined;
		const isFiring = rule.check(snapshot);
		if (isFiring && !wasFiring) {
			next.firing[rule.id] = nowIso;
			transitions.push({
				rule,
				kind: 'firing',
				text: rule.firingText(snapshot),
			});
		} else if (!isFiring && wasFiring) {
			transitions.push({
				rule,
				kind: 'resolved',
				firingSince: prev.firing[rule.id],
				text: `:white_check_mark: *Resolved* — ${rule.description}`,
			});
			delete next.firing[rule.id];
		}
	}
	return { next, transitions };
}

export async function readState(r2: HealthR2): Promise<AlertState> {
	const obj = await r2.get(STATE_KEY);
	if (!obj) return { firing: {} };
	const parsed = await obj.json<AlertState>();
	return { firing: parsed.firing ?? {} };
}

/** R2 binding shape extended with `put` for state writes. */
export interface AlertR2 extends HealthR2 {
	put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export async function writeState(r2: AlertR2, state: AlertState): Promise<void> {
	await r2.put(STATE_KEY, JSON.stringify(state), {
		httpMetadata: { contentType: 'application/json' },
	});
}

export async function postToSlack(token: string, text: string): Promise<void> {
	const resp = await fetch('https://slack.com/api/chat.postMessage', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json; charset=utf-8',
		},
		body: JSON.stringify({
			channel: SLACK_CHANNEL,
			text,
			username: SLACK_USERNAME,
			icon_emoji: SLACK_ICON_EMOJI,
			unfurl_links: false,
		}),
	});
	const body = await resp.json<{ ok: boolean; error?: string }>();
	if (!body.ok) {
		throw new Error(`slack postMessage failed: ${body.error ?? 'unknown'}`);
	}
}

/** Entry point for the scheduled handler. Returns the transitions
 *  notified, useful for tests and logging. */
export async function runAlerts(
	r2: AlertR2,
	slackToken: string,
	rules: Rule[] = DEFAULT_RULES,
): Promise<Transition[]> {
	const [snapshot, prev] = await Promise.all([
		getHealthSnapshot(r2),
		readState(r2),
	]);
	const { next, transitions } = diffRules(rules, prev, snapshot, new Date().toISOString());
	for (const t of transitions) {
		// Don't let one Slack failure block other notifications — log and continue.
		try {
			await postToSlack(slackToken, t.text);
		} catch (e) {
			console.error(`slack post failed for rule=${t.rule.id} kind=${t.kind}:`, e);
		}
	}
	if (transitions.length > 0) {
		await writeState(r2, next);
	}
	return transitions;
}
