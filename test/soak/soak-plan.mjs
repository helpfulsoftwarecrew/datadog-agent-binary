/*
 * The compressed schedule: every chaos action at least once in a short run, in a seeded order, each given its own
 * window and its recovery before the next begins. Apart from soak.mjs so the fit has a test.
 */
import { shuffled } from "./soak-threads.mjs";

/**
 * Minutes each action holds the node in a compressed run, and when its outcome is read. A thread action checks
 * itself before it returns, so it has no readback, and its slot is a floor that a slow check extends.
 *
 * @type {Record<string, { slot: number, readback?: number }>}
 */
export const COMPRESSED_MINUTES = {
	"kill-trace-agent": { slot: 1.5, readback: 1.25 },
	"kill-core-agent": { slot: 1.5, readback: 1.25 },
	"kill-reaper": { slot: 1.5, readback: 1.25 },
	restart: { slot: 3, readback: 2 },
	"restart-seeded-pid-1": { slot: 3, readback: 2 },
	"stop-trace-agent-60s": { slot: 2, readback: 1.75 },
	"pause-30s": { slot: 1.5, readback: 1.25 },
	"burst-10x-5min": { slot: 6, readback: 2 },
	"wrong-api-key-10min": { slot: 13, readback: 2 },
	"restart-workers": { slot: 1.5 },
	"exit-random-workers": { slot: 2 },
	"redeploy-restart": { slot: 1.5 },
	"redeploy-rolling": { slot: 1 },
	"drop-file-restart": { slot: 1.5 },
	"resize-workers": { slot: 3.5 },
};

/** Thread actions that replace every worker while Harper stays up; one of them carries the deliberate stop. */
export const STOP_CARRIERS = [
	"restart-workers",
	"redeploy-restart",
	"drop-file-restart",
];
/** What the deliberate stop adds: its window, the operator's restart and the checks after it. */
export const DELIBERATE_STOP_MINUTES = 3;
/** Rows before the first action: the evaluator's warm-up, then quiet rows to read traces and the steady state. */
export const WARMUP_ROWS = 3;
export const QUIET_ROWS = 5;
/** Room left at the end for actions that ran over their slot. */
export const END_MARGIN_MINUTES = 5;

/**
 * @typedef {{ name: string, atMin: number, minutes: number, deliberateStop: boolean }} Step
 */

/**
 * Every action in `names` once, in an order `rng` draws, spaced by its slot from the first action on.
 *
 * @param {() => number} rng @param {readonly string[]} names
 * @returns {{ steps: Step[], firstAtMin: number, endsAtMin: number }}
 */
export function compressedPlan(rng, names) {
	const unknown = names.filter(
		(name) => !Object.hasOwn(COMPRESSED_MINUTES, name)
	);
	if (unknown.length)
		throw new Error(`no compressed slot for ${unknown.join(", ")}`);
	const order = shuffled(rng, names);
	const carriers = order.filter((name) => STOP_CARRIERS.includes(name));
	const carrier = carriers.length
		? carriers[Math.floor(rng() * carriers.length)]
		: null;
	const firstAtMin = WARMUP_ROWS + QUIET_ROWS;
	let at = firstAtMin;
	/** @type {Step[]} */
	const steps = [];
	for (const name of order) {
		const deliberateStop = name === carrier;
		const minutes =
			COMPRESSED_MINUTES[name].slot +
			(deliberateStop ? DELIBERATE_STOP_MINUTES : 0);
		steps.push({ name, atMin: at, minutes, deliberateStop });
		at += minutes;
	}
	return { steps, firstAtMin, endsAtMin: at };
}

/** Why a plan does not fit a run of `hours`, or null when it does. @param {{ endsAtMin: number }} plan @param {number} hours */
export function planDoesNotFit(plan, hours) {
	const room = hours * 60 - END_MARGIN_MINUTES;
	return plan.endsAtMin <= room
		? null
		: `the compressed plan needs ${plan.endsAtMin + END_MARGIN_MINUTES} minutes and the run has ${hours * 60}`;
}

/** The plan as one line for chaos.log. @param {{ steps: Step[] }} plan */
export const describePlan = (plan) =>
	plan.steps
		.map(
			(step) =>
				`${step.atMin.toFixed(2)} ${step.name}${step.deliberateStop ? "+stop" : ""}`
		)
		.join(", ");
