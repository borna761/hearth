// The photo's actual capture time, for DESIGN.md §7.1's "pairs prefer photos taken on the
// same day". A bulk-imported library (the normal way a NAS photo folder gets populated —
// copying years of camera roll at once, not one photo per day) makes file mtime a poor
// proxy for capture date: every photo copied in one sitting would get the same mtime and
// look "same day" regardless of when they were actually taken. Read the real EXIF capture
// date instead, falling back to mtime only when a photo genuinely has none (screenshots,
// or files that have had their metadata stripped).

import exifr from 'exifr';

/**
 * @param {Buffer} buffer
 * @param {Date} fallbackMtime
 * @returns {Promise<Date>}
 */
export async function extractTakenAt(buffer, fallbackMtime) {
	try {
		const exif = await exifr.parse(buffer, ['DateTimeOriginal', 'CreateDate']);
		const date = exif?.DateTimeOriginal ?? exif?.CreateDate;
		if (date instanceof Date && !Number.isNaN(date.getTime())) {
			return date;
		}
	} catch {
		// Malformed or unreadable EXIF — a stray corrupt file in a bulk-imported library is
		// realistic, and one bad photo must not take the whole nightly job down.
	}
	return fallbackMtime;
}
