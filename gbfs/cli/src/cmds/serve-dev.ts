import { Command } from 'commander';

export function registerServeDev(program: Command): void {
    program
        .command('serve-dev')
        .description('Local dev server: serves the planner against the configured store + manifest.')
        .option('--port <P>', 'listen port', '8787')
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 10');
        });
}
