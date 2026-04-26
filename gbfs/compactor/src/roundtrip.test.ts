import { describe, expect, test } from 'vitest';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { parquetReadObjects } from 'hyparquet';
import { buildColumnData } from './index';

describe('parquet round-trip', () => {
	test('snapshots → buffer → readback matches', async () => {
		const snapshots = [
			{
				ts: 1700000000,
				polled_at: 1700000005,
				stations: [
					{
						station_id: 'A',
						num_bikes_available: 5,
						num_ebikes_available: 2,
						num_docks_available: 10,
						num_bikes_disabled: 0,
						num_docks_disabled: 1,
						is_installed: 1,
						is_renting: 1,
						is_returning: 1,
						last_reported: 1699999990,
					},
					{
						station_id: 'B',
						num_bikes_available: 0,
						num_ebikes_available: 0,
						num_docks_available: 12,
						num_bikes_disabled: 3,
						num_docks_disabled: 0,
						is_installed: 1,
						is_renting: 0,
						is_returning: 1,
						last_reported: 1699999985,
					},
				],
			},
			{
				ts: 1700000060,
				polled_at: 1700000065,
				stations: [
					{
						station_id: 'A',
						num_bikes_available: 4,
						num_ebikes_available: 2,
						num_docks_available: 11,
						num_bikes_disabled: 0,
						num_docks_disabled: 1,
						is_installed: 1,
						is_renting: 1,
						is_returning: 1,
						last_reported: 1700000050,
					},
					{
						station_id: 'B',
						num_bikes_available: 0,
						num_ebikes_available: 0,
						num_docks_available: 12,
						num_bikes_disabled: 3,
						num_docks_disabled: 0,
						is_installed: 1,
						is_renting: 0,
						is_returning: 1,
						last_reported: 1699999985,
					},
				],
			},
		];

		const columnData = buildColumnData(snapshots);
		const buf = parquetWriteBuffer({ columnData });
		expect(buf.byteLength).toBeGreaterThan(0);

		const file = {
			byteLength: buf.byteLength,
			slice: (start: number, end?: number) => buf.slice(start, end),
		};
		const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
		// Coerce BigInt to Number to match JSON-shaped expectations.
		for (const r of rows) {
			for (const k of Object.keys(r)) {
				if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
			}
		}

		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual({
			station_id: 'A',
			ts: 1700000000,
			polled_at: 1700000005,
			num_bikes_available: 5,
			num_ebikes_available: 2,
			num_docks_available: 10,
			num_bikes_disabled: 0,
			num_docks_disabled: 1,
			is_installed: 1,
			is_renting: 1,
			is_returning: 1,
			last_reported: 1699999990,
		});
		expect(rows[1].station_id).toBe('B');
		expect(rows[2]).toEqual(
			expect.objectContaining({ station_id: 'A', ts: 1700000060, num_bikes_available: 4 }),
		);
		expect(rows[3].station_id).toBe('B');
	});

	test('plausible byte size for 60 snapshots × 2,360 stations', async () => {
		// Simulate one hour of polls at typical Citi Bike scale.
		const N_STATIONS = 2360;
		const N_MIN = 60;
		const baseTs = 1700000000;

		const snapshots = Array.from({ length: N_MIN }, (_, m) => ({
			ts: baseTs + m * 60,
			polled_at: baseTs + m * 60 + 5,
			stations: Array.from({ length: N_STATIONS }, (_, s) => ({
				station_id: `s${s.toString().padStart(4, '0')}`,
				// Vary a bit so compression isn't a degenerate case.
				num_bikes_available: (s + m) % 20,
				num_ebikes_available: (s + m) % 5,
				num_docks_available: 30 - ((s + m) % 20),
				num_bikes_disabled: (s + m) % 3,
				num_docks_disabled: (s + m) % 2,
				is_installed: 1,
				is_renting: 1,
				is_returning: 1,
				last_reported: baseTs + m * 60 - 30,
			})),
		}));

		const columnData = buildColumnData(snapshots);
		const buf = parquetWriteBuffer({ columnData });
		// Daily compaction (24×) lands at ~12-18 MB → expect hourly < 2 MB.
		expect(buf.byteLength).toBeLessThan(2_000_000);
		// Sanity: should be well above the empty-file overhead.
		expect(buf.byteLength).toBeGreaterThan(50_000);
	}, 30_000);
});
