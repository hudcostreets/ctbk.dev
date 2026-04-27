import { describe, expect, test } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { buildColumnData } from './index';

describe('row-group pruning by station_id', () => {
	test('per-station read touches one row group, not the full file', async () => {
		// Synthetic shard: 100 stations × 60 minutes = 6,000 rows
		const snapshots = Array.from({ length: 60 }, (_, m) => ({
			ts: 1700000000 + m * 60,
			polled_at: 1700000000 + m * 60 + 5,
			stations: Array.from({ length: 100 }, (_, s) => ({
				station_id: 's' + String(s).padStart(3, '0'),
				num_bikes_available: s,
				num_ebikes_available: 0,
				num_docks_available: 30 - s,
				num_bikes_disabled: 0,
				num_docks_disabled: 0,
				is_installed: 1,
				is_renting: 1,
				is_returning: 1,
				last_reported: 1700000000 + m * 60 - 30,
			})),
		}));
		const buf = parquetWriteBuffer({
			columnData: buildColumnData(snapshots),
			rowGroupSize: 60,
		});
		const file = {
			byteLength: buf.byteLength,
			slice: (s: number, e?: number) => buf.slice(s, e),
		};

		const meta = await parquetMetadataAsync(file);
		// 6,000 rows / 60 = 100 row groups, one per station
		expect(meta.row_groups).toHaveLength(100);

		// station_id stats per row group: each row group's min == max for one station
		const target = 's042';
		let targetGroupIdx = -1;
		let rowOffset = 0;
		const rowOffsets: number[] = [];
		for (let i = 0; i < meta.row_groups.length; i++) {
			rowOffsets.push(rowOffset);
			const rg = meta.row_groups[i];
			const sidCol = rg.columns.find((c) => c.meta_data?.path_in_schema?.[0] === 'station_id')!;
			const stats = sidCol.meta_data?.statistics;
			if (stats && stats.min_value === target && stats.max_value === target) {
				targetGroupIdx = i;
			}
			rowOffset += Number(rg.num_rows);
		}
		expect(targetGroupIdx).toBeGreaterThanOrEqual(0);

		// Read JUST that row group's row range
		const rgRowStart = rowOffsets[targetGroupIdx];
		const rgRows = Number(meta.row_groups[targetGroupIdx].num_rows);
		const rows = (await parquetReadObjects({
			file,
			rowStart: rgRowStart,
			rowEnd: rgRowStart + rgRows,
		})) as Record<string, unknown>[];

		expect(rows).toHaveLength(60);
		for (const r of rows) {
			expect(r.station_id).toBe(target);
		}
		// Sanity: the rows are timestamp-ordered within the group
		const tsValues = rows.map((r) => Number(r.ts));
		expect([...tsValues].sort((a, b) => a - b)).toEqual(tsValues);
	});
});
