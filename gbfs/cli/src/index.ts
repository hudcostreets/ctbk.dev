/**
 * `gbfs` CLI — entry point for all multi-scale grid operations.
 *
 * One binary, many subcmds. Invoked from:
 *   - dev shell (`pnpm gbfs <cmd>`, or `./bin/gbfs <cmd>` after symlink)
 *   - GHA workflows (`pnpm gbfs <cmd>`, dispatched from CFW)
 *   - CFW workers don't shell out — they import the cmd modules directly
 *
 * See specs/avail-grid.md.
 */

import { Command } from 'commander';
import { registerEnsure } from './cmds/ensure.js';
import { registerBackfill } from './cmds/backfill.js';
import { registerPlan } from './cmds/plan.js';
import { registerGc } from './cmds/gc.js';
import { registerManifest } from './cmds/manifest.js';
import { registerServeDev } from './cmds/serve-dev.js';

const program = new Command()
    .name('gbfs')
    .description('GBFS multi-scale grid CLI — manage avail/agg=*/cons=*/dt=* shards')
    .version('0.1.0')
    // Global flags surface on every subcmd that opts in via `program.opts()`.
    .option('--store <r2|local>', 'shard store backend', 'r2')
    .option('--manifest <d1|local>', 'manifest backend', 'd1')
    .option('--config <path>', 'grid spec yaml', 'gbfs/grid.yaml')
    .option('-n, --dry-run', 'print actions without writing', false);

registerEnsure(program);
registerBackfill(program);
registerPlan(program);
registerGc(program);
registerManifest(program);
registerServeDev(program);

program.parseAsync(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
