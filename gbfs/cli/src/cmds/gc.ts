import { Command } from 'commander';

export function registerGc(program: Command): void {
    program
        .command('gc')
        .description('Delete subsumed shards older than --grace; updates manifest state to "deleted".')
        .option('--grace <duration>', 'minimum age since subsumed_at (e.g. 24h, 7d)', '24h')
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 5');
        });
}
