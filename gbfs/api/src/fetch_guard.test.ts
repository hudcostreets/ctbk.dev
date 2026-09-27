import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFooterSlot, FetchBusyError, FOOTER_SLOT_LEASE_MS, resetFooterSlotsForTest } from './fetch_guard';

describe('acquireFooterSlot', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetFooterSlotsForTest();
	});
	afterEach(() => vi.useRealTimers());

	it('sheds a second caller while the slot is held, then admits it after release', async () => {
		const release = await acquireFooterSlot(1_000);
		const second = acquireFooterSlot(1_000);
		const rejected = expect(second).rejects.toBeInstanceOf(FetchBusyError);
		await vi.advanceTimersByTimeAsync(1_200);
		await rejected;
		release();
		const again = await acquireFooterSlot(1_000);
		again();
	});

	it('reclaims a slot leaked by a request that never ran its `finally`', async () => {
		// A cancelled request abandons its in-flight parse: the release never runs.
		await acquireFooterSlot(1_000);
		vi.advanceTimersByTime(FOOTER_SLOT_LEASE_MS + 1);
		const release = await acquireFooterSlot(1_000);
		release();
	});

	it("a reclaimed holder's late release doesn't free the new holder's slot", async () => {
		const stale = await acquireFooterSlot(1_000);
		vi.advanceTimersByTime(FOOTER_SLOT_LEASE_MS + 1);
		const fresh = await acquireFooterSlot(1_000);
		stale();
		const third = acquireFooterSlot(500);
		const rejected = expect(third).rejects.toBeInstanceOf(FetchBusyError);
		await vi.advanceTimersByTimeAsync(700);
		await rejected;
		fresh();
	});
});
