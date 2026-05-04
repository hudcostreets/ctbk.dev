/**
 * Node-side ParquetIO impl for the CLI. Wraps `hyparquet` (read) and
 * `hyparquet-writer` (write). The CFW workers will provide their own
 * (functionally identical) impls in step 7 cutover.
 */

import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
import type { ParquetIO } from '../../lib/ensureCell.js';
import type { ColumnSource } from '../../lib/avail-monoid.js';

export const nodeParquetIO: ParquetIO = {
    async read(buf: ArrayBuffer): Promise<Record<string, unknown>[]> {
        const file = { byteLength: buf.byteLength, slice: (s: number, e?: number) => buf.slice(s, e) };
        return (await parquetReadObjects({ file })) as Record<string, unknown>[];
    },
    write(cols: ColumnSource[], rowGroupSize: number): Uint8Array {
        const buf = parquetWriteBuffer({ columnData: cols, rowGroupSize });
        return new Uint8Array(buf);
    },
};
