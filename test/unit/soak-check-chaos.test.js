// The evaluator reads chaos.log for the checks the thread actions write, and counts an action once however
// many lines it writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLeg } from "../soak/soak-check.mjs";

/** A healthy leg of 20 quiet rows with `chaos` as its chaos.log. */
function legWithChaos(chaos) {
	const dir = mkdtempSync(join(tmpdir(), "soak-check-chaos-"));
	const rows = ["time\tup\tmem\tfail\tsup\tverified\tchaos"];
	for (let i = 0; i < 20; i++)
		rows.push(
			`2026-09-29 18:${String(i).padStart(2, "0")}:00\t${(i / 60).toFixed(2)}h\t2.0GiB\t0\tguard\tTTTTF\tnone`
		);
	writeFileSync(join(dir, "status.tsv"), rows.join("\n") + "\n");
	writeFileSync(join(dir, "chaos.log"), chaos.join("\n") + "\n");
	return dir;
}

const PASSED = [
	"2026-09-29 18:11:02 #1 restart-workers with a deliberate stop: restart_service replaces every HTTP worker",
	"2026-09-29 18:11:10 #1 restart-workers check pool replaced: passed",
	"2026-09-29 18:11:46 #1 restart-workers check agents: passed",
	"2026-09-29 18:11:46 #1 restart-workers deliberate stop sent SIGTERM to trace-agent pid 661; it must stay down 60 s",
	"2026-09-29 18:12:47 #1 restart-workers check deliberate stop honoured: passed",
	"2026-09-29 18:14:16 #2 kill-trace-agent (pid 700): the guard restarts it under a new pid and it verifies",
	"2026-09-29 18:15:31 #2 kill-trace-agent after 1.25 min: {}",
];

test("checks that passed leave the leg passing, and each action is counted once", () => {
	const result = checkLeg(legWithChaos(PASSED));
	assert.equal(result.pass, true, result.failures.join("; "));
	assert.equal(result.stats.chaosActions, 2);
	assert.equal(result.stats.chaosChecks, 3);
	assert.equal(result.stats.chaosChecksFailed, 0);
});

test("NEGATIVE: one failed check fails the leg, and says how many of how many", () => {
	const result = checkLeg(
		legWithChaos([
			...PASSED,
			"2026-09-29 18:14:01 #1 restart-workers check agents after the operator restart: FAILED: no live trace-agent; zombie trace-agent pid 661 (parent 7)",
		])
	);
	assert.equal(result.pass, false);
	assert.deepEqual(result.failures, ["a chaos check failed: 1 of 4"]);
	assert.equal(result.stats.chaosChecksFailed, 1);
});

test("NEGATIVE: an action the compressed plan never reached fails the leg as one not applied", () => {
	const result = checkLeg(
		legWithChaos([
			...PASSED,
			"2026-09-29 19:00:00 #- burst-10x-5min could not be applied: the run ended before it fired",
		])
	);
	assert.deepEqual(result.failures, ["a chaos action could not be applied: 1"]);
	assert.equal(result.stats.chaosActions, 2);
});
