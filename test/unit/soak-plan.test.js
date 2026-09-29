// The compressed schedule has to fit an hour with every action in it. soak.mjs is a script, so its action
// names are read from its source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	COMPRESSED_MINUTES,
	DELIBERATE_STOP_MINUTES,
	END_MARGIN_MINUTES,
	QUIET_ROWS,
	STOP_CARRIERS,
	WARMUP_ROWS,
	compressedPlan,
	describePlan,
	planDoesNotFit,
} from "../../test/soak/soak-plan.mjs";
import { seededRandom } from "../../test/soak/soak-threads.mjs";

const source = readFileSync(
	fileURLToPath(new URL("../soak/soak.mjs", import.meta.url)),
	"utf-8"
);

/** The keys of an object literal in soak.mjs that opens with `const <name> = {`. */
function literalKeys(name) {
	const start = source.indexOf(`const ${name} = {`);
	assert.ok(start > -1, `soak.mjs has no ${name}`);
	const body = source.slice(start, source.indexOf("\n};", start));
	return [
		...body.matchAll(/^\t(?:async )?(?:"([\w-]+)"|([\w]+))(?:\(|: )/gm),
	].map((m) => m[1] ?? m[2]);
}

const ACTION_NAMES = [
	...literalKeys("ACTIONS"),
	...literalKeys("THREAD_ACTIONS"),
];

test("every action the harness can fire has a compressed slot, and every slot an action", () => {
	assert.deepEqual(
		[...ACTION_NAMES].sort(),
		Object.keys(COMPRESSED_MINUTES).sort()
	);
	assert.ok(ACTION_NAMES.includes("restart-workers"));
	assert.ok(ACTION_NAMES.includes("kill-trace-agent"));
	const actions = source.slice(
		source.indexOf("const ACTIONS = {"),
		source.indexOf("\n};", source.indexOf("const ACTIONS = {"))
	);
	assert.match(
		actions,
		/^\t\.\.\.THREAD_ACTIONS,$/m,
		"the thread actions are ones fireChaos can reach"
	);
});

test("the plan for one hour holds every action once and ends before the hour, for any seed", () => {
	for (let seed = 0; seed < 200; seed++) {
		const plan = compressedPlan(seededRandom(seed), ACTION_NAMES);
		assert.deepEqual(
			plan.steps.map((s) => s.name).sort(),
			[...ACTION_NAMES].sort(),
			`seed ${seed}`
		);
		assert.ok(plan.endsAtMin <= 60 - END_MARGIN_MINUTES, `seed ${seed}`);
		assert.equal(planDoesNotFit(plan, 1), null);
	}
});

test("each action's slot covers its own window and its recovery", () => {
	for (const [name, { slot, readback }] of Object.entries(COMPRESSED_MINUTES))
		if (readback !== undefined)
			assert.ok(readback < slot, `${name} is read back inside its own slot`);
	// The four windows the names promise, each with room after it.
	assert.ok(COMPRESSED_MINUTES["burst-10x-5min"].slot > 5);
	assert.ok(COMPRESSED_MINUTES["wrong-api-key-10min"].slot > 10);
	assert.ok(COMPRESSED_MINUTES["stop-trace-agent-60s"].slot > 1);
	assert.ok(COMPRESSED_MINUTES["pause-30s"].slot > 0.5);
});

test("no two actions overlap, and the first comes after the warm-up and the quiet rows", () => {
	const plan = compressedPlan(seededRandom(12345), ACTION_NAMES);
	assert.equal(plan.steps[0].atMin, WARMUP_ROWS + QUIET_ROWS);
	for (let i = 1; i < plan.steps.length; i++)
		assert.equal(
			plan.steps[i].atMin,
			plan.steps[i - 1].atMin + plan.steps[i - 1].minutes
		);
});

test("exactly one action carries the deliberate stop, one that replaces every worker with Harper up", () => {
	const carried = new Set();
	for (let seed = 0; seed < 100; seed++) {
		const plan = compressedPlan(seededRandom(seed), ACTION_NAMES);
		const stops = plan.steps.filter((s) => s.deliberateStop);
		assert.equal(stops.length, 1);
		assert.ok(STOP_CARRIERS.includes(stops[0].name));
		assert.equal(
			stops[0].minutes,
			COMPRESSED_MINUTES[stops[0].name].slot + DELIBERATE_STOP_MINUTES
		);
		carried.add(stops[0].name);
	}
	assert.deepEqual([...carried].sort(), [...STOP_CARRIERS].sort());
});

test("one seed gives one plan, and the plan is logged in its order", () => {
	const a = compressedPlan(seededRandom(42), ACTION_NAMES);
	const b = compressedPlan(seededRandom(42), ACTION_NAMES);
	const c = compressedPlan(seededRandom(43), ACTION_NAMES);
	assert.deepEqual(a, b);
	assert.notDeepEqual(
		a.steps.map((s) => s.name),
		c.steps.map((s) => s.name)
	);
	assert.match(describePlan(a), /^8\.00 [\w-]+/);
	assert.equal(describePlan(a).split(", ").length, ACTION_NAMES.length);
});

test("NEGATIVE: a run too short for the plan is refused, and an unknown action has no slot", () => {
	const plan = compressedPlan(seededRandom(1), ACTION_NAMES);
	assert.match(
		planDoesNotFit(plan, 0.5) ?? "",
		/needs \d+(\.\d+)? minutes and the run has 30/
	);
	assert.throws(
		() => compressedPlan(seededRandom(1), ["restart", "no-such-action"]),
		/no compressed slot for no-such-action/
	);
});
