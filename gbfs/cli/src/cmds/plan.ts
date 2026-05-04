import { Command } from 'commander';

export function registerPlan(program: Command): void {
    program
        .command('plan')
        .description('Preview the planner output for a query window: agg-tier choice + file list.')
        .requiredOption('--from-s <S>', 'unix-s lower bound', Number)
        .requiredOption('--to-s <S>', 'unix-s upper bound', Number)
        .option('--bin-s <S>', 'requested bin size in seconds', Number)
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 10');
        });
}
