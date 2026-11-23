/** Split a parquet file's row groups into contiguous `[rowStart, rowEnd)`
 *  ranges of whole row groups, each ≤ `maxRows` rows (a single row group
 *  larger than `maxRows` gets its own range). */
export function rowGroupBatches(rgRows: number[], maxRows: number): { rowStart: number; rowEnd: number }[] {
	const out: { rowStart: number; rowEnd: number }[] = [];
	let start = 0;
	let end = 0;
	for (const n of rgRows) {
		if (end > start && end - start + n > maxRows) {
			out.push({ rowStart: start, rowEnd: end });
			start = end;
		}
		end += n;
	}
	if (end > start) out.push({ rowStart: start, rowEnd: end });
	return out;
}
