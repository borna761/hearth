// HTTP byte-range parsing for streaming audio to a Cast receiver (docs/phase-7-music-
// plan.md) — genuinely new to this app; nothing here mirrors an existing pattern (photos
// are small enough to serve whole, audio isn't). Kept as a pure function, independent of
// any real file, so the route handler itself only has to wire up createReadStream with
// whatever this returns.

export interface RangeResult {
	status: 200 | 206 | 416;
	/** Inclusive byte offsets — meaningless when status is 416. */
	start: number;
	end: number;
	headers: Record<string, string>;
}

/** Parses a `Range: bytes=...` header per RFC 7233's single-range form (a Cast receiver
 *  has no reason to send a multi-range request, so that's not supported here). `null`
 *  means no Range header was sent at all — a receiver's very first request often has
 *  none, hence the full-200-with-Accept-Ranges response rather than always requiring one. */
export function computeRange(rangeHeader: string | null, totalSize: number): RangeResult {
	if (rangeHeader === null) {
		return {
			status: 200,
			start: 0,
			end: totalSize - 1,
			headers: { 'accept-ranges': 'bytes', 'content-length': String(totalSize) }
		};
	}

	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!match || (match[1] === '' && match[2] === '')) {
		return invalidRange(totalSize);
	}

	let start: number;
	let end: number;
	if (match[1] === '') {
		// Suffix range: "bytes=-500" means the last 500 bytes.
		const suffixLength = Number(match[2]);
		start = Math.max(0, totalSize - suffixLength);
		end = totalSize - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === '' ? totalSize - 1 : Math.min(Number(match[2]), totalSize - 1);
	}

	if (start >= totalSize || start > end) {
		return invalidRange(totalSize);
	}

	return {
		status: 206,
		start,
		end,
		headers: {
			'accept-ranges': 'bytes',
			'content-range': `bytes ${start}-${end}/${totalSize}`,
			'content-length': String(end - start + 1)
		}
	};
}

function invalidRange(totalSize: number): RangeResult {
	return {
		status: 416,
		start: 0,
		end: -1,
		headers: { 'content-range': `bytes */${totalSize}` }
	};
}
