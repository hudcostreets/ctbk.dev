/**
 * YAML loader for the grid spec. Lives here (not in lib/) because the
 * `yaml` dep is Node-only; lib must stay CFW-importable.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { validateGrid, type GridSpec } from '../../lib/grid.js';

export async function loadGrid(path: string): Promise<GridSpec> {
    const text = await readFile(path, 'utf-8');
    const raw = parseYaml(text) as GridSpec;
    return validateGrid(raw);
}
