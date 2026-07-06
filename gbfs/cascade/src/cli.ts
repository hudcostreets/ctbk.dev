#!/usr/bin/env tsx
/**
 * Node CLI adapter for `converge()` / `gcSweep()`. Same TypeScript
 * primitives the CFW cron uses — different Env bindings (S3-compat R2
 * client + D1 HTTP client). Handles `too_large` rungs the CFW can't
 * fit in its 128 MB isolate, and one-shot GC catch-up bursts.
 *
 * Usage:
 *   pnpm cli converge [--tiers T[,U]] [--shard-durs SD[,SD]]
 *                     [--time-budget-ms N] [--max-ops N]
 *                     [--dry-run] [--loop] [--parallelism N]
 *   pnpm cli gc       [--tiers T[,U]] [--grace-minutes N]
 *                     [--time-budget-ms N] [--max-ops N]
 *                     [--dry-run] [--loop]
 *
 * `--loop` keeps invoking the primitive until it reports no work
 * remaining (`totalMissing === 0` for converge; `totalEligible === 0`
 * for gc). Useful for bootstrap / catch-up bursts on `e` or laptop.
 *
 * Env (read at startup; see adapter files for details):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN — D1 HTTP auth
 *   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY     — R2 S3-compat auth
 *   R2_BUCKET (default `ctbk`)
 *   D1_DATABASE_ID (default: the ctbk-gbfs binding from wrangler.toml)
 */
import { s3R2 } from './adapters/r2-s3';
import { HttpD1 } from './adapters/d1-http';
import { converge, gcSweep } from './avail3/cascade';

interface ParsedArgs {
	cmd: 'converge' | 'gc';
	tiers?: string[];
	shardDurs?: string[];
	timeBudgetMs?: number;
	maxOps?: number;
	graceMinutes?: number;
	dryRun: boolean;
	loop: boolean;
	now?: Date;
}

function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		cmd: 'converge',
		dryRun: false,
		loop: false,
	};
	const positional = argv.slice(2);
	if (positional[0] === 'converge' || positional[0] === 'gc') {
		args.cmd = positional[0];
		positional.shift();
	}
	for (let i = 0; i < positional.length; i++) {
		const a = positional[i]!;
		const next = () => positional[++i];
		if (a === '--tiers' || a === '-t') {
			args.tiers = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
		} else if (a === '--shard-durs' || a === '-d') {
			args.shardDurs = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
		} else if (a === '--time-budget-ms') {
			args.timeBudgetMs = Number(next());
		} else if (a === '--max-ops') {
			args.maxOps = Number(next());
		} else if (a === '--grace-minutes' || a === '-g') {
			args.graceMinutes = Number(next());
		} else if (a === '--dry-run' || a === '-n') {
			args.dryRun = true;
		} else if (a === '--loop' || a === '-L') {
			args.loop = true;
		} else if (a === '--now') {
			args.now = new Date(next()!);
		} else if (a === '--help' || a === '-h') {
			console.log('usage: cli {converge|gc} [--tiers T,U] [--shard-durs SD] [--time-budget-ms N] [--max-ops N] [--grace-minutes N] [--dry-run] [--loop] [--now ISO]');
			process.exit(0);
		} else {
			throw new Error(`unknown arg: ${a}`);
		}
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const r2 = s3R2();
	const db = new HttpD1();
	let iter = 0;
	let cumWrote = 0, cumDeleted = 0;
	const started = Date.now();

	while (true) {
		iter++;
		if (args.cmd === 'converge') {
			const report = await converge(r2 as never, db as never, {
				now: args.now,
				tiers: args.tiers,
				shardDurs: args.shardDurs,
				timeBudgetMs: args.timeBudgetMs,
				maxOps: args.maxOps,
				dryRun: args.dryRun,
			});
			const wrote = report.stats['wrote'] ?? 0;
			cumWrote += wrote;
			console.log(`converge iter=${iter} missing=${report.totalMissing} results=${report.results.length} stats=${JSON.stringify(report.stats)} stopped=${report.stoppedReason ?? '-'}`);
			if (!args.loop || report.totalMissing === 0 || (report.results.length === 0 && !report.stoppedReason)) break;
			// Avoid infinite tight loop if a call did no useful work
			if (wrote === 0 && !report.stoppedReason) break;
		} else {
			const report = await gcSweep(r2 as never, db as never, {
				now: args.now,
				tiers: args.tiers,
				graceMinutes: args.graceMinutes,
				timeBudgetMs: args.timeBudgetMs,
				maxOps: args.maxOps,
				dryRun: args.dryRun,
			});
			const del = report.deleted.length;
			cumDeleted += del;
			console.log(`gc iter=${iter} eligible=${report.totalEligible} deleted=${del} skipped=${report.skipped.length} stats=${JSON.stringify(report.stats)} stopped=${report.stoppedReason ?? '-'}`);
			if (!args.loop || report.totalEligible === 0 || (del === 0 && !report.stoppedReason)) break;
		}
	}
	const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
	console.log(`done in ${iter} iter(s), ${elapsedS}s — cumWrote=${cumWrote} cumDeleted=${cumDeleted}`);
}

main().catch((err) => {
	console.error('cli error:', err);
	process.exit(1);
});
