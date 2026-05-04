import { Command } from 'commander';
import { ensureCell } from '../../../lib/ensureCell.js';
import { LocalStore } from '../../../lib/storeLocal.js';
import { loadGrid } from '../loadGrid.js';
import { nodeParquetIO } from '../parquetIO.js';

interface RootOpts {
    store: 'r2' | 'local';
    config: string;
    dryRun?: boolean;
}

export function registerEnsure(program: Command): void {
    program
        .command('ensure')
        .description('Ensure one (agg, cons, period) shard exists; build from inputs if missing.')
        .requiredOption('--agg <A>', 'agg level (e.g. 1m, 5m, 1h, 1d)')
        .requiredOption('--cons <C>', 'cons level (e.g. 5m, 1h, 1d, 1w, 1mo)')
        .requiredOption('--period <P>', 'period start (e.g. 2026-05-04_1430, 202605, 2026)')
        .option('--root <path>', 'local store root (when --store=local)', 'r2/ctbk')
        .action(async (opts) => {
            const root = program.optsWithGlobals<RootOpts>();
            if (root.store !== 'local') {
                throw new Error('only --store=local is implemented in this step (R2Store coming next)');
            }
            const grid = await loadGrid(root.config);
            const store = new LocalStore(opts.root);
            const result = await ensureCell(
                store, nodeParquetIO, grid, opts.agg, opts.cons, opts.period,
                { dryRun: !!root.dryRun },
            );
            console.log(JSON.stringify(result, null, 2));
        });
}
