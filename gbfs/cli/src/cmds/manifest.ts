import { Command } from 'commander';

export function registerManifest(program: Command): void {
    const manifest = program
        .command('manifest')
        .description('Manifest operations (D1 in prod; SQLite locally).');

    manifest
        .command('sync')
        .description('Rebuild manifest from a full ShardStore listing (recovery).')
        .action(async () => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 5');
        });

    manifest
        .command('list')
        .description('List manifest entries, optionally filtered.')
        .option('--agg <A>')
        .option('--cons <C>')
        .option('--state <S>', "'present' | 'subsumed' | 'deleted'")
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 5');
        });

    manifest
        .command('get')
        .description('Get one manifest entry by (agg, cons, period).')
        .requiredOption('--agg <A>')
        .requiredOption('--cons <C>')
        .requiredOption('--period <P>')
        .action(async (_opts) => {
            throw new Error('not implemented yet — see specs/avail-grid.md step 5');
        });
}
