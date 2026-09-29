/*
 * The run clock, apart from soak.mjs so the parse has a test. It survives a restart: the start time lives in a
 * `started` file rather than in the process.
 */

/** Now, as the logs write it: UTC, with the zone stripped because every line in the file is UTC. */
export const stamp = () =>
	new Date().toISOString().slice(0, 19).replace("T", " ");

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A stamp this file wrote, back to a time. The text names no offset and `Date.parse` would read it as local,
 * so it is marked UTC first; an anchor that carries a zone, as a hand-written one may, is left alone.
 *
 * @param {string} written @returns {number} ms since the epoch, or NaN when the text is not a time
 */
export function parseStamp(written) {
	const text = String(written).trim().replace(" ", "T");
	return Date.parse(ZONED.test(text) ? text : `${text}Z`);
}
