import { describe, expect, test } from 'vitest';
import { alignToBucket, bucketStartMin, isSupportedCons, periodFor } from '../../lib/period.js';

const M = (s: string) => Math.floor(Date.parse(s) / 60_000);

describe('periodFor (encoding)', () => {
    test('1m → YYYY-MM-DD_HHMM', () => {
        expect(periodFor('1m', M('2026-05-04T14:30:00Z'))).toBe('2026-05-04_1430');
    });
    test('5m: aligned input → exact format', () => {
        expect(periodFor('5m', M('2026-05-04T14:30:00Z'))).toBe('2026-05-04_1430');
    });
    test('15m', () => {
        expect(periodFor('15m', M('2026-05-04T14:45:00Z'))).toBe('2026-05-04_1445');
    });
    test('1h → YYYY-MM-DD_HH', () => {
        expect(periodFor('1h', M('2026-05-04T14:00:00Z'))).toBe('2026-05-04_14');
    });
    test('3h', () => {
        expect(periodFor('3h', M('2026-05-04T15:00:00Z'))).toBe('2026-05-04_15');
    });
    test('8h', () => {
        expect(periodFor('8h', M('2026-05-04T08:00:00Z'))).toBe('2026-05-04_08');
    });
    test('1d → YYYY-MM-DD', () => {
        expect(periodFor('1d', M('2026-05-04T00:00:00Z'))).toBe('2026-05-04');
    });
    test('3d', () => {
        expect(periodFor('3d', M('2026-05-04T00:00:00Z'))).toBe('2026-05-04');
    });
    test('1w → ISO YYYY-Www: 2026-05-04 (Mon) is W19', () => {
        // 2026-05-04 is a Monday; ISO calendar puts it in week 19.
        expect(periodFor('1w', M('2026-05-04T00:00:00Z'))).toBe('2026-W19');
    });
    test('1w: 2025-12-29 (Mon) → 2026-W01 (week-of-Thursday rule crosses year)', () => {
        expect(periodFor('1w', M('2025-12-29T00:00:00Z'))).toBe('2026-W01');
    });
    test('calendar cons (1mo, 1y, 3y) throw not-implemented', () => {
        expect(() => periodFor('1mo', 0)).toThrow(/not implemented/);
        expect(() => periodFor('1y',  0)).toThrow(/not implemented/);
        expect(() => periodFor('3y',  0)).toThrow(/not implemented/);
    });
    test('unknown cons throws', () => {
        expect(() => periodFor('17q', 0)).toThrow(/unknown cons/);
    });
});

describe('bucketStartMin (decoding)', () => {
    test('1m round-trip', () => {
        const min = M('2026-05-04T14:30:00Z');
        expect(bucketStartMin('1m', periodFor('1m', min))).toBe(min);
    });
    test('1h round-trip', () => {
        const min = M('2026-05-04T14:00:00Z');
        expect(bucketStartMin('1h', periodFor('1h', min))).toBe(min);
    });
    test('1d round-trip', () => {
        const min = M('2026-05-04T00:00:00Z');
        expect(bucketStartMin('1d', periodFor('1d', min))).toBe(min);
    });
    test('1w round-trip: 2026-W19 → Monday 2026-05-04 00:00 UTC', () => {
        expect(bucketStartMin('1w', '2026-W19')).toBe(M('2026-05-04T00:00:00Z'));
    });
    test('1w round-trip: 2026-W01 → Monday 2025-12-29 00:00 UTC', () => {
        expect(bucketStartMin('1w', '2026-W01')).toBe(M('2025-12-29T00:00:00Z'));
    });
    test('rejects malformed periods', () => {
        expect(() => bucketStartMin('1m',  '2026-05-04')).toThrow();
        expect(() => bucketStartMin('1h',  '2026-05-04_14:00')).toThrow();
        expect(() => bucketStartMin('1d',  '20260504')).toThrow();
        expect(() => bucketStartMin('1w',  '2026-19')).toThrow();
    });
});

describe('alignToBucket', () => {
    test('1m: any minute is its own bucket', () => {
        const min = M('2026-05-04T14:37:00Z');
        expect(alignToBucket('1m', min)).toBe(min);
    });
    test('5m: rounds down', () => {
        expect(alignToBucket('5m', M('2026-05-04T14:37:00Z'))).toBe(M('2026-05-04T14:35:00Z'));
    });
    test('15m: rounds down to nearest quarter hour', () => {
        expect(alignToBucket('15m', M('2026-05-04T14:37:00Z'))).toBe(M('2026-05-04T14:30:00Z'));
    });
    test('1h: rounds down to top of hour', () => {
        expect(alignToBucket('1h', M('2026-05-04T14:37:00Z'))).toBe(M('2026-05-04T14:00:00Z'));
    });
    test('3h: 14:37 → 12:00 (aligned to 0,3,6,9,12,15,18,21)', () => {
        expect(alignToBucket('3h', M('2026-05-04T14:37:00Z'))).toBe(M('2026-05-04T12:00:00Z'));
    });
    test('8h: 14:37 → 08:00', () => {
        expect(alignToBucket('8h', M('2026-05-04T14:37:00Z'))).toBe(M('2026-05-04T08:00:00Z'));
    });
    test('1d: 14:37 → 00:00 same day', () => {
        expect(alignToBucket('1d', M('2026-05-04T14:37:00Z'))).toBe(M('2026-05-04T00:00:00Z'));
    });
    test('3d: anchored to unix epoch (1970-01-01 was Thursday)', () => {
        // 3-day strides from epoch: align should be deterministic, not
        // depending on calendar boundaries. Just round-trip via period.
        const aligned = alignToBucket('3d', M('2026-05-04T14:37:00Z'));
        expect(aligned).toBe(bucketStartMin('3d', periodFor('3d', aligned)));
        expect(aligned <= M('2026-05-04T14:37:00Z')).toBe(true);
        expect(aligned + 3 * 1440 > M('2026-05-04T14:37:00Z')).toBe(true);
    });
    test('1w: rounds down to Monday 00:00 UTC', () => {
        // 2026-05-08 is Friday → bucket starts Monday 2026-05-04
        expect(alignToBucket('1w', M('2026-05-08T15:00:00Z'))).toBe(M('2026-05-04T00:00:00Z'));
    });
});

describe('isSupportedCons', () => {
    test('integer-min cons supported', () => {
        for (const c of ['1m', '5m', '15m', '1h', '3h', '8h', '1d', '3d', '5d', '10d', '1w']) {
            expect(isSupportedCons(c), c).toBe(true);
        }
    });
    test('calendar cons not supported in v1', () => {
        for (const c of ['1mo', '2mo', '3mo', '1y', '3y']) {
            expect(isSupportedCons(c), c).toBe(false);
        }
    });
    test('unknown cons returns false', () => {
        expect(isSupportedCons('17q')).toBe(false);
    });
});
