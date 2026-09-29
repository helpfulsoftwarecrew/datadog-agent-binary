// Whether one soak run passed, asked by the soak driver. Read as a module (`checkLeg`) or run as a CLI:
// `node soak-check.mjs <leg-dir> [--expect-sup guard]`.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** A leg is judged on the supervisor, which is what the matrix measures. */
const RULES = {
	/** A request that failed while nothing was being done to the node. */
	failuresOutsideChaos: "requests failed with no chaos in flight",
	/** The supervision path changed, or was never what this leg is meant to exercise. */
	wrongSupervision: "the supervision path is not the one this leg runs",
	/** Verification degraded while nothing was being done to the node. */
	verificationOutsideChaos:
		"an agent stopped verifying with no chaos in flight",
	/** A pipeline counter stopped climbing outside a chaos window. */
	pipelineStall: "a delivery pipeline stopped while nothing was being done",
	/** A chaos action could not be applied, so the leg tested less than it claims. */
	chaosNotApplied: "a chaos action could not be applied",
	/** The run ended early: fewer rows than a minute-per-row run of this length should produce. */
	endedEarly: "the run produced far fewer rows than its duration",
	/** Resident memory grew across the run beyond what a steady node does. */
	memoryGrowth: "resident memory grew across the run",
};

/**
 * How fast RSS may climb once warmed before it is a leak rather than noise, as a fraction of the run's own
 * median RSS per hour: 2% lets a run near 1 GiB drift 20 MiB an hour.
 */
const MEMORY_GROWTH_PER_HOUR = 0.02;
/**
 * How much of a run is warm-up, excluded before the trend is measured: the greater of a quarter of the run and
 * this many hours, since a quarter of a short run is still climbing.
 */
const WARMUP_FRACTION = 0.25;
const WARMUP_MIN_HOURS = 2.5;
/**
 * How much warmed data a trend needs before it means anything. Below this the check reports that it did not
 * measure rather than guessing; no leak worth the name shows in an hour.
 */
const MEMORY_MIN_WARMED_HOURS = 1.5;
/** One-minute load above which a failure is more likely a starved box than a broken node, for four cores. */
const LOAD_SUSPECT = 8;
/** A row is "quiet" when its chaos column says nothing is in flight or the last action is well past. */
const QUIET_AFTER_MIN = 12;

const toGiB = (v) => {
	const m = /^([\d.]+)\s*(GiB|MiB|KiB|B)?$/.exec(String(v).trim());
	if (!m) return null;
	const n = Number(m[1]);
	return { GiB: n, MiB: n / 1024, KiB: n / 1048576, B: n / 1073741824 }[
		m[2] ?? "GiB"
	];
};

/** Whether nothing was being done to the node when this row was written. */
export function rowIsQuiet(chaosCell) {
	const cell = String(chaosCell ?? "").trim();
	if (!cell || cell === "none" || cell === "-") return true;
	// The harness marks the rows it held the node down for, and that is authoritative; the minute count below is a
	// fallback for rows recorded without the marker.
	if (/\bbusy\b/.test(cell)) return false;
	const ago = /(\d+)m ago\b/.exec(cell);
	return ago ? Number(ago[1]) >= QUIET_AFTER_MIN : false;
}

/**
 * Judge one leg's output directory.
 *
 * @param {string} dir The leg's SOAK_OUT.
 * @param {{ expectSup?: string, hours?: number, strictDelivery?: boolean }} [options]
 * @returns {{ pass: boolean, failures: string[], warnings: string[], stats: Record<string, any> }}
 */
export function checkLeg(dir, options = {}) {
	const failures = [];
	const warnings = [];
	const stats = {};

	const tsv = join(dir, "status.tsv");
	if (!existsSync(tsv))
		return {
			pass: false,
			failures: ["no status.tsv: the run produced nothing"],
			warnings,
			stats,
		};

	const lines = readFileSync(tsv, "utf-8").trim().split("\n");
	const header = lines[0].split("\t");
	const col = (name) => header.indexOf(name);
	const rows = lines.slice(1).map((l) => l.split("\t"));
	stats.rows = rows.length;
	if (!rows.length)
		return {
			pass: false,
			failures: ["status.tsv has a header and no rows"],
			warnings,
			stats,
		};

	const iSup = col("sup"),
		iVer = col("verified"),
		iFail = col("fail");
	const iChaos = col("chaos"),
		iMem = col("mem"),
		iUp = col("up");

	// The steady reading is whatever the leg held for most of its quiet rows; a leg is judged against
	// itself rather than against a hardcoded TTTTT, because a macOS leg has two agents and a container five.
	const tally = {};
	for (const r of rows)
		if (rowIsQuiet(r[iChaos]) && r[iVer] && r[iVer] !== "-")
			tally[r[iVer]] = (tally[r[iVer]] ?? 0) + 1;
	const steady = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
	stats.steady = steady;

	const iLoad = col("load");
	/** One-minute load on each row that was counted as a failure outside chaos. */
	const loadAt = [];
	let failRows = 0,
		failReqs = 0,
		verDeviations = 0,
		supDeviations = 0;
	for (const r of rows) {
		const quiet = rowIsQuiet(r[iChaos]);
		if (quiet && Number(r[iFail]) > 0) {
			failRows++;
			failReqs += Number(r[iFail]);
			const l = iLoad >= 0 ? Number(r[iLoad]) : NaN;
			if (Number.isFinite(l)) loadAt.push(l);
		}
		if (quiet && r[iVer] && r[iVer] !== "-" && steady && r[iVer] !== steady)
			verDeviations++;
		if (
			options.expectSup &&
			r[iSup] &&
			r[iSup] !== "-" &&
			r[iSup] !== options.expectSup
		)
			supDeviations++;
	}
	stats.failRowsOutsideChaos = failRows;
	stats.failReqsOutsideChaos = failReqs;
	if (failRows) {
		// Name the box's load when they happened: the verdict stays a failure, and the reason is in the output.
		const loaded = loadAt.length
			? ` (one-minute load on those rows: ${Math.min(...loadAt).toFixed(1)} to ${Math.max(...loadAt).toFixed(1)}` +
				`${Math.max(...loadAt) >= LOAD_SUSPECT ? "; the box was busy enough that this is more likely starvation than a defect" : ""})`
			: "";
		failures.push(
			`${RULES.failuresOutsideChaos}: ${failReqs} across ${failRows} row(s)${loaded}`
		);
	}
	if (verDeviations)
		failures.push(
			`${RULES.verificationOutsideChaos}: ${verDeviations} row(s) away from ${steady}`
		);
	if (supDeviations)
		failures.push(
			`${RULES.wrongSupervision}: ${supDeviations} row(s) not '${options.expectSup}'`
		);

	// Memory, judged on a least-squares slope after the node has warmed, since the first tenth of a run is always its
	// coldest. The bar scales with the run's median RSS: host mode sits near 1 GiB and a container near 2.4.
	const memPts = [];
	for (const r of rows) {
		const m = toGiB(r[iMem]);
		const h = Number(String(r[iUp] ?? "").replace("h", ""));
		if (typeof m === "number" && m > 0 && Number.isFinite(h))
			memPts.push([h, m]);
	}
	if (memPts.length >= 10) {
		// Drop the warm-up, by wall clock as well as by proportion.
		const runHours = memPts.at(-1)[0];
		const cutoff = Math.max(runHours * WARMUP_FRACTION, WARMUP_MIN_HOURS);
		const warmed = memPts.filter(([h]) => h >= cutoff);
		const warmedHours = warmed.length ? warmed.at(-1)[0] - warmed[0][0] : 0;
		if (warmed.length < 10 || warmedHours < MEMORY_MIN_WARMED_HOURS) {
			stats.memTrend = `not measured: ${warmedHours.toFixed(2)}h warmed, needs ${MEMORY_MIN_WARMED_HOURS}h`;
		} else {
			const sorted = warmed.map(([, m]) => m).sort((a, b) => a - b);
			const median = sorted[Math.floor(sorted.length / 2)];
			const mh = warmed.reduce((a, [h]) => a + h, 0) / warmed.length;
			const mm = warmed.reduce((a, [, m]) => a + m, 0) / warmed.length;
			const den = warmed.reduce((a, [h]) => a + (h - mh) ** 2, 0);
			// A window too short to span any time cannot have a trend; say nothing rather than divide by zero.
			const slope =
				den > 0
					? warmed.reduce((a, [h, m]) => a + (h - mh) * (m - mm), 0) / den
					: 0;
			stats.memMedianGiB = Number(median.toFixed(3));
			stats.memSlopeMiBPerHour = Number((slope * 1024).toFixed(1));
			if (slope > median * MEMORY_GROWTH_PER_HOUR)
				failures.push(
					`${RULES.memoryGrowth}: +${(slope * 1024).toFixed(1)} MiB/hour sustained across ` +
						`${warmedHours.toFixed(1)}h of warmed running, against a median of ${median.toFixed(2)} GiB`
				);
		}
	}

	// The run has to have lasted: a row a minute, so a 1h rung owes roughly 60.
	const finalUp = Number(String(rows.at(-1)[iUp] ?? "").replace("h", "")) || 0;
	stats.hours = finalUp;
	if (options.hours && finalUp < options.hours * 0.9)
		failures.push(
			`${RULES.endedEarly}: reached ${finalUp}h of ${options.hours}h`
		);

	// The harness's own alarms, which know things this file cannot re-derive.
	const log = existsSync(join(dir, "nohup.log"))
		? readFileSync(join(dir, "nohup.log"), "utf-8")
		: "";
	const stallLines = log
		.split("\n")
		.filter(
			(l) => l.includes("STALL:") && !l.includes("delivery has read rejected")
		);
	stats.pipelineStalls = stallLines.length;
	if (stallLines.length)
		failures.push(`${RULES.pipelineStall}: ${stallLines.length} flagged`);

	const chaosLog = existsSync(join(dir, "chaos.log"))
		? readFileSync(join(dir, "chaos.log"), "utf-8")
		: "";
	const notApplied = chaosLog
		.split("\n")
		.filter((l) => l.includes("could not be applied"));
	stats.chaosNotApplied = notApplied.length;
	if (notApplied.length)
		failures.push(`${RULES.chaosNotApplied}: ${notApplied.length}`);
	stats.chaosActions = chaosLog
		.split("\n")
		.filter((l) => /^\d{4}-/.test(l) && !l.includes("after 2 min")).length;

	// Delivery refused outside chaos is recorded and by default is not a failure, since container DNS can fail while
	// the host resolves; --strict-delivery makes it one.
	const deliveryStalls = log
		.split("\n")
		.filter((l) => l.includes("delivery has read rejected"));
	stats.deliveryStalls = deliveryStalls.length;
	if (deliveryStalls.length)
		(options.strictDelivery ? failures : warnings).push(
			`delivery read rejected with no chaos in flight (${deliveryStalls.length} flagged); check the trace-agent log before blaming this node`
		);

	return { pass: failures.length === 0, failures, warnings, stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [dir, ...rest] = process.argv.slice(2);
	if (!dir) {
		console.error(
			"usage: soak-check.mjs <leg-dir> [--expect-sup guard|harper] [--hours N] [--strict-delivery]"
		);
		process.exit(2);
	}
	const arg = (name) => {
		const i = rest.indexOf(name);
		return i === -1 ? undefined : rest[i + 1];
	};
	const result = checkLeg(dir, {
		expectSup: arg("--expect-sup"),
		hours: arg("--hours") ? Number(arg("--hours")) : undefined,
		strictDelivery: rest.includes("--strict-delivery"),
	});
	console.log(`  ${result.pass ? "PASS" : "FAIL"}  ${dir}`);
	for (const [k, v] of Object.entries(result.stats))
		console.log(`    ${k}: ${v}`);
	for (const f of result.failures) console.log(`    FAIL: ${f}`);
	for (const w of result.warnings) console.log(`    warn: ${w}`);
	process.exit(result.pass ? 0 : 1);
}
