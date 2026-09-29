// The thread chaos's pure half. The census fixture has the shape of /proc/<pid>/stat in a Harper container,
// with the trace-agent left a zombie after the worker that spawned it was replaced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ACTION_LINE,
	CHECK_FAILED,
	CHECK_LINE,
	PROC_STAT_SCRIPT,
	SLOT_EXIT_CAP,
	bringBackOnThrow,
	census,
	censusArgv,
	censusFailures,
	checkLine,
	chooseCount,
	chooseExits,
	harperIdentity,
	isWorkerAnswer,
	jobOf,
	lastingZombies,
	ops,
	parseProcStat,
	parseSeed,
	poolReplaced,
	poolView,
	randomStreams,
	restartsSeen,
	seededRandom,
	signalArgv,
	slotsUnderCap,
	stopNotHonoured,
	tarFiles,
} from "../../test/soak/soak-threads.mjs";

const stat = (pid, comm, state, ppid, start = 900) =>
	`${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 12 0 ${start} 1000 200`;

const PROC = [
	stat(1, "tini", "S", 0, 100),
	stat(7, "MainThread", "S", 1, 120),
	stat(661, "trace-agent", "Z", 7),
	stat(670, "datadog-agent", "S", 7),
	stat(679, "system-probe", "S", 7),
	stat(686, "process-agent", "S", 7),
	stat(707, "security-agent", "S", 7),
	stat(708, "MainThread", "S", 7),
].join("\n");

const AGENTS = [
	"trace-agent",
	"datadog-agent",
	"system-probe",
	"process-agent",
	"security-agent",
];

test("a stat line is read for pid, command, state, parent and start time", () => {
	const procs = parseProcStat(PROC);
	assert.equal(procs.length, 8);
	assert.deepEqual(procs[2], {
		pid: 661,
		comm: "trace-agent",
		state: "Z",
		ppid: 7,
		start: 900,
	});
});

test("a command holding spaces and parentheses does not move the state", () => {
	const [p] = parseProcStat(stat(42, "a (b) c", "R", 7));
	assert.equal(p.comm, "a (b) c");
	assert.equal(p.state, "R");
	assert.equal(p.ppid, 7);
});

test("NEGATIVE: lines that are not stat lines are dropped, not read as processes", () => {
	assert.deepEqual(
		parseProcStat("\nnot a stat line\n12 no-parens S 1\n(x) S 1\n"),
		[]
	);
});

test("the census counts live agents by command and every zombie apart", () => {
	const { live, zombies } = census(parseProcStat(PROC), AGENTS);
	assert.deepEqual(live["trace-agent"], [], "a zombie is not a live agent");
	assert.deepEqual(live["datadog-agent"], [670]);
	assert.deepEqual(
		zombies.map((z) => z.pid),
		[661]
	);
});

test("NEGATIVE: a dead agent, a second copy and a lasting zombie each fail the census", () => {
	const procs = parseProcStat(`${PROC}\n${stat(990, "datadog-agent", "S", 7)}`);
	const { live, zombies } = census(procs, AGENTS);
	assert.deepEqual(censusFailures(live, zombies), [
		"no live trace-agent",
		"2 live datadog-agent (pids 670, 990)",
		"zombie trace-agent pid 661 (parent 7)",
	]);
});

test("one live process per agent and no zombie passes the census", () => {
	const healthy = PROC.replace("(trace-agent) Z", "(trace-agent) S");
	const { live, zombies } = census(parseProcStat(healthy), AGENTS);
	assert.deepEqual(censusFailures(live, zombies), []);
});

test("a zombie seen once is a child between exit and wait; one seen twice is kept", () => {
	const first = [
		{ pid: 661, comm: "trace-agent", state: "Z", ppid: 7, start: 1 },
		{ pid: 900, comm: "sh", state: "Z", ppid: 7, start: 2 },
	];
	const second = [
		{ pid: 661, comm: "trace-agent", state: "Z", ppid: 7, start: 1 },
	];
	assert.deepEqual(
		lastingZombies(first, second).map((z) => z.pid),
		[661]
	);
	assert.deepEqual(lastingZombies([], second), []);
});

test("the census script prints one stat line per process and skips one that went away", (t) => {
	if (process.platform === "win32")
		return t.skip(
			"sh strips the backslashes of the C:\\ temp path the script is pointed at"
		);
	assert.deepEqual(censusArgv("leg"), [
		"exec",
		"leg",
		"sh",
		"-c",
		PROC_STAT_SCRIPT,
	]);
	// The script as the container runs it, pointed at a stand-in /proc so it runs on any host.
	const root = mkdtempSync(join(tmpdir(), "soak-proc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [pid, line] of [
		[7, stat(7, "MainThread", "S", 1, 120)],
		[661, stat(661, "trace-agent", "Z", 7)],
	]) {
		mkdirSync(join(root, String(pid)));
		writeFileSync(join(root, String(pid), "stat"), `${line}\n`);
	}
	mkdirSync(join(root, "900"));
	const out = execFileSync(
		"sh",
		["-c", PROC_STAT_SCRIPT.replaceAll("/proc/", `${root}/`)],
		{ encoding: "utf8" }
	);
	assert.deepEqual(
		parseProcStat(out).map((p) => [p.pid, p.state]),
		[
			[661, "Z"],
			[7, "S"],
		]
	);
});

test("the signal argv names one pid above 1 and one of the two signals", () => {
	assert.deepEqual(signalArgv("leg", 661, "TERM"), [
		"exec",
		"leg",
		"kill",
		"-TERM",
		"661",
	]);
	for (const pid of [0, 1, -1, 1.5, NaN, "661"])
		assert.throws(() => signalArgv("leg", /** @type {any} */ (pid), "TERM"));
	assert.throws(() => signalArgv("leg", 661, /** @type {any} */ ("HUP")));
});

test("Harper's identity changes with its start time even when a restart reuses its pid", () => {
	const before = harperIdentity(parseProcStat(PROC), "7\n");
	const after = harperIdentity(
		parseProcStat(stat(7, "MainThread", "S", 1, 5000)),
		"7"
	);
	assert.equal(before, "7@120");
	assert.equal(after, "7@5000");
	assert.equal(harperIdentity(parseProcStat(PROC), "4242"), null);
});

const answer = (workerIndex, threadId, restartNumber, workerCount = 3) => ({
	threadId,
	workerIndex,
	workerCount,
	restartNumber,
	exiting: false,
});

test("a round of probes is read as the thread serving each slot, the later answer winning", () => {
	const view = poolView([
		answer(0, 1, 1),
		answer(1, 2, 1),
		null,
		{ error: "timeout" },
		answer(1, 9, 1),
	]);
	assert.equal(view.workerCount, 3);
	assert.deepEqual([...view.slots.keys()].sort(), [0, 1]);
	assert.equal(view.slots.get(1)?.threadId, 9);
	assert.equal(isWorkerAnswer({ threadId: 1 }), false);
});

test("the pool counts as replaced only when every slot answers from a later restart", () => {
	const before = poolView([answer(0, 1, 1), answer(1, 2, 1), answer(2, 3, 1)]);
	const all = poolView([answer(0, 11, 2), answer(1, 12, 2), answer(2, 13, 2)]);
	assert.equal(poolReplaced(before, all, 3), true);
	const oneLeft = poolView([
		answer(0, 11, 2),
		answer(1, 2, 1),
		answer(2, 13, 2),
	]);
	assert.equal(
		poolReplaced(before, oneLeft, 3),
		false,
		"slot 1 still runs the old worker"
	);
	const unseen = poolView([answer(0, 11, 2), answer(2, 13, 2)]);
	assert.equal(poolReplaced(before, unseen, 3), false, "slot 1 did not answer");
	// An unexpected exit's replacement keeps the restart number, so it is not a restart of the pool.
	const exitOnly = poolView([
		answer(0, 1, 1),
		answer(1, 22, 1),
		answer(2, 3, 1),
	]);
	assert.equal(poolReplaced(before, exitOnly, 3), false);
});

test("a seed gives one sequence, and a different seed another", () => {
	const a = seededRandom(12345);
	const b = seededRandom(12345);
	const c = seededRandom(12346);
	const first = [a(), a(), a()];
	assert.deepEqual([b(), b(), b()], first);
	assert.notDeepEqual([c(), c(), c()], first);
	for (const x of first) assert.ok(x >= 0 && x < 1);
});

test("the chaos and thread streams of one seed are independent of each other's draws", () => {
	const one = randomStreams(7);
	const two = randomStreams(7);
	two.threads();
	two.threads();
	assert.equal(one.chaos(), two.chaos());
});

test("a seed is an unsigned 32-bit integer and nothing else", () => {
	assert.equal(parseSeed("0"), 0);
	assert.equal(parseSeed("4294967295"), 4294967295);
	for (const bad of [
		"",
		" ",
		"-1",
		"1.5",
		"4294967296",
		"12abc",
		"0x10",
		undefined,
	])
		assert.equal(parseSeed(bad), null, String(bad));
});

test("exits are drawn from the slots under the cap, at least one and at most three", () => {
	const spent = { 0: SLOT_EXIT_CAP, 2: SLOT_EXIT_CAP - 1 };
	assert.deepEqual(slotsUnderCap(spent, 4), [1, 2, 3]);
	const rng = seededRandom(99);
	for (let i = 0; i < 200; i++) {
		const chosen = chooseExits(rng, [1, 2, 3, 5, 8]);
		assert.ok(chosen.length >= 1 && chosen.length <= 3);
		assert.equal(new Set(chosen).size, chosen.length);
		for (const slot of chosen) assert.ok([1, 2, 3, 5, 8].includes(slot));
	}
	assert.deepEqual(chooseExits(rng, []), []);
});

test("NEGATIVE: a slot at the cap is never drawn, so no slot nears Harper's fifty", () => {
	const rng = seededRandom(5);
	const spent = {};
	for (let i = 0; i < 500; i++)
		for (const slot of chooseExits(rng, slotsUnderCap(spent, 4)))
			spent[slot] = (spent[slot] ?? 0) + 1;
	for (let slot = 0; slot < 4; slot++) assert.equal(spent[slot], SLOT_EXIT_CAP);
});

test("a new worker count always differs from the current one and stays in range", () => {
	const rng = seededRandom(3);
	for (let i = 0; i < 300; i++) {
		const current = 2 + (i % 9);
		const next = chooseCount(rng, current, 9);
		assert.notEqual(next, current);
		assert.ok(next >= 2 && next <= 10);
	}
});

test("the operations are named as Harper 5.2.9 validates them", () => {
	assert.deepEqual(ops.restartWorkers(), {
		operation: "restart_service",
		service: "http_workers",
	});
	assert.deepEqual(ops.deploy("QUJD", "rolling"), {
		operation: "deploy_component",
		project: "soak-chaos",
		payload: "QUJD",
		restart: "rolling",
	});
	assert.deepEqual(ops.dropFile("drop-me.txt"), {
		operation: "drop_component",
		project: "soak-chaos",
		file: "drop-me.txt",
		restart: true,
	});
	assert.deepEqual(ops.setThreads(4), {
		operation: "set_configuration",
		threads_count: 4,
	});
	assert.deepEqual(
		jobOf([{ status: "ERROR", message: "Replication not implemented." }]),
		{
			status: "ERROR",
			message: "Replication not implemented.",
		}
	);
	assert.equal(jobOf({ message: "nope" }), null);
});

test("the tar a redeploy sends unpacks with tar to the same files", (t) => {
	if (process.platform === "win32")
		return t.skip("shells out to tar and cat with a C:\\ temp path");
	const dir = mkdtempSync(join(tmpdir(), "soak-tar-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const files = [
		{ name: "config.yaml", data: "rest: true\n" },
		{ name: "resources.js", data: "export const x = 1;\n".repeat(40) },
		{ name: "empty.txt", data: "" },
	];
	writeFileSync(join(dir, "a.tar"), tarFiles(files, 1_790_000_000));
	const listed = execFileSync("tar", ["-tvf", join(dir, "a.tar")], {
		encoding: "utf8",
	});
	for (const { name } of files)
		assert.match(listed, new RegExp(name.replace(".", "\\.")));
	execFileSync("tar", ["-xf", join(dir, "a.tar"), "-C", dir]);
	const read = (name) =>
		execFileSync("cat", [join(dir, name)], { encoding: "utf8" });
	for (const { name, data } of files) assert.equal(read(name), data);
	assert.throws(() => tarFiles([{ name: "/etc/passwd", data: "" }]));
	assert.throws(() => tarFiles([{ name: "x".repeat(100), data: "" }]));
});

test("a check line is found by the evaluator's patterns, and a failed one only by the failed pattern", () => {
	const passed = `2026-09-29 18:11:10 ${checkLine(1, "restart-workers", "pool replaced", [])}`;
	const failed = `2026-09-29 18:11:10 ${checkLine(4, "exit-random-workers", "agents", ["no live trace-agent", "zombie trace-agent pid 661 (parent 7)"])}`;
	assert.match(passed, CHECK_LINE);
	assert.doesNotMatch(passed, CHECK_FAILED);
	assert.match(failed, CHECK_FAILED);
	assert.match(
		failed,
		/FAILED: no live trace-agent; zombie trace-agent pid 661/
	);
	assert.throws(() => checkLine(1, "x", "a: b", []));
});

test("a recovery is not a check, and the check after its restart is one", () => {
	const recovery =
		"2026-09-29 20:10:52 #5 redeploy-restart recovery: restarting the node, since the check of agents after the operator restart failed";
	assert.doesNotMatch(recovery, CHECK_LINE);
	assert.match(
		`2026-09-29 20:12:01 ${checkLine(5, "redeploy-restart", "agents after the recovery restart", [])}`,
		CHECK_LINE
	);
});

test("only the line that opens an action is counted as one", () => {
	const lines = {
		"2026-09-29 18:11:02 #1 restart-workers with a deliberate stop: restart_service replaces": true,
		"2026-09-29 18:11:02 #2 kill-trace-agent (pid 661): the guard restarts it": true,
		"2026-09-29 18:11:02 #3 kill-reaper skipped: no reaper pid": true,
		"2026-09-29 18:11:02 #3 redeploy-rolling could not be applied: exit 1": true,
		"2026-09-29 18:11:02 #2 kill-trace-agent after 1.25 min: {}": false,
		"2026-09-29 18:11:02 #2 kill-trace-agent after 2 min: {}": false,
		"2026-09-29 18:11:10 #1 restart-workers check pool replaced: passed": false,
		"2026-09-29 18:11:46 #1 restart-workers deliberate stop sent SIGTERM to trace-agent pid 661": false,
		"2026-09-29 18:11:46 #5 exit-random-workers ended slots 2 t13->t40 of 9": false,
		"2026-09-29 18:11:46 #6 redeploy-rolling harper said its restart job ended ERROR": false,
		"2026-09-29 20:10:52 #5 redeploy-restart recovery: restarting the node, since the check of agents after the operator restart failed": false,
		"2026-09-29 20:10:53 #5 redeploy-restart recovery restart failed: exit 1": false,
		"2026-09-29 20:10:53 #5 redeploy-restart deliberate stop not sent: the node was restarted after the agents check failed": false,
		"2026-09-29 18:10:31 plan: seed 12345, schedule compressed": false,
		"2026-09-29 18:10:31 #- burst-10x-5min could not be applied: the run ended before it fired": false,
	};
	for (const [line, counted] of Object.entries(lines))
		assert.equal(ACTION_LINE.test(line), counted, line);
});

const statusWith = (restarts, error) => ({
	processes: [
		{ name: "datadog-agent", pid: 877, restarts, ...(error ? { error } : {}) },
		{ name: "datadog-trace-agent", pid: 871, restarts: 0 },
	],
});

test("the restarts a check reads are the most any worker counted, with the first error given", () => {
	assert.deepEqual(
		restartsSeen(
			[statusWith(0), null, statusWith(5, "died 6 times"), statusWith(2)],
			"datadog-agent"
		),
		{ most: 5, error: "died 6 times" }
	);
	assert.deepEqual(restartsSeen([null, {}], "datadog-agent"), {
		most: null,
		error: null,
	});
});

test("a deliberate stop the guard left alone is honoured", () => {
	const before = restartsSeen([statusWith(0), statusWith(0)], "datadog-agent");
	const after = restartsSeen([statusWith(0), statusWith(0)], "datadog-agent");
	assert.equal(stopNotHonoured(before, after, "datadog-agent"), null);
});

test("NEGATIVE: a guard that went back for the stopped agent did not honour the stop, started or not", () => {
	const before = restartsSeen([statusWith(0)], "datadog-agent");
	const after = restartsSeen(
		[
			statusWith(
				5,
				"died 6 times (a liveness poll found the pid dead); not restarting it again"
			),
		],
		"datadog-agent"
	);
	assert.equal(
		stopNotHonoured(before, after, "datadog-agent"),
		"the guard went back for datadog-agent 5 time(s) after the SIGTERM (died 6 times (a liveness poll found the pid dead); not restarting it again)"
	);
	assert.match(
		stopNotHonoured(
			before,
			restartsSeen([null], "datadog-agent"),
			"datadog-agent"
		) ?? "",
		/no status named datadog-agent after the window/
	);
});

test("NEGATIVE: a deliberate stop that throws brings the agent back before its error goes on", async () => {
	const order = [];
	const refused = new Error("restart_service answered 500");
	await assert.rejects(
		bringBackOnThrow(
			async () => {
				order.push("sigterm");
				throw refused;
			},
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push("brought back");
			}
		),
		(error) => {
			order.push("error");
			return error === refused;
		}
	);
	assert.deepEqual(order, ["sigterm", "brought back", "error"]);
});

test("a deliberate stop that finishes is not brought back a second time", async () => {
	let broughtBack = 0;
	const failures = await bringBackOnThrow(
		async () => ["security-agent does not verify"],
		async () => {
			broughtBack++;
		}
	);
	assert.deepEqual(failures, ["security-agent does not verify"]);
	assert.equal(broughtBack, 0);
});
