import { Command } from 'commander';

export function registerEnsure(program: Command): void {
    program
        .command('ensure')
        .description('Ensure one (agg, cons, period) shard exists; build from inputs if missing.')
        .requiredOption('--agg <A>', 'agg level (e.g. 1m, 5m, 1h, 1d)')
        .requiredOption('--cons <C>', 'cons level (e.g. 5m, 1h, 1d, 1w, 1mo)')
        .requiredOption('--period <P>', 'period start (e.g. 2026-05-04_1430, 202605, 2026)')
        .option('-r, --recursive', 'recursively ensure missing inputs', false)
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 4');
        });
}
