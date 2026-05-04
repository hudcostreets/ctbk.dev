import { Command } from 'commander';

export function registerBackfill(program: Command): void {
    program
        .command('backfill')
        .description('Walk the grid spec and ensureCell every cell in [from, to]; recursive by default.')
        .requiredOption('--from <P>', 'inclusive lower bound (date or period)')
        .requiredOption('--to <P>', 'inclusive upper bound')
        .option('--agg <A>', 'limit to one agg series')
        .option('--cons <C>', 'limit to one cons within --agg')
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 6');
        });
}
