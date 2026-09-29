/*
 * The pure half of the soak's worker-thread chaos, apart from soak.mjs so it has tests: the seeded draws, the
 * process census read inside the container, the worker probes, the per-slot exit budget and the operations.
 */

/**
 * A seeded generator in [0, 1), mulberry32: one seed gives one sequence, so a failing run can be replayed.
 *
 * @param {number} seed @returns {() => number}
 */
export function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Independent streams from one seed, so a draw added to one kind of choice cannot shift another's.
 *
 * @param {number} seed
 */
export function randomStreams(seed) {
	return {
		chaos: seededRandom(seed ^ 0x2545f491),
		threads: seededRandom(seed ^ 0x9e3779b9),
	};
}

/** A seed as the harness takes it: an unsigned 32-bit integer, or null for anything else. */
export function parseSeed(text) {
	const value = String(text ?? "").trim();
	if (!/^\d{1,10}$/.test(value)) return null;
	const seed = Number(value);
	return seed <= 0xffffffff ? seed : null;
}

/** @param {() => number} rng @param {number} lo @param {number} hi inclusive */
export const randomInt = (rng, lo, hi) =>
	lo + Math.floor(rng() * (hi - lo + 1));

/**
 * @template T
 * @param {() => number} rng @param {readonly T[]} items @returns {T[]}
 */
export function shuffled(rng, items) {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------
// The census: every process in the container, read from /proc because the agents' parent is Harper itself.

/** Prints each process's /proc/<pid>/stat on its own line; a process gone mid-read prints nothing. */
export const PROC_STAT_SCRIPT =
	'for f in /proc/[0-9]*/stat; do s=$(cat "$f" 2>/dev/null) && printf "%s\\n" "$s"; done';

/** `docker exec` argv for one census read of `container`. */
export const censusArgv = (container) => [
	"exec",
	container,
	"sh",
	"-c",
	PROC_STAT_SCRIPT,
];

/**
 * `docker exec` argv that sends `signal` to `pid` inside `container`. Refuses what is not a pid above 1.
 *
 * @param {string} container @param {number} pid @param {"TERM" | "KILL"} signal
 */
export function signalArgv(container, pid, signal) {
	if (!Number.isInteger(pid) || pid <= 1)
		throw new Error(
			`refusing to signal ${JSON.stringify(pid)}: not a pid above 1`
		);
	if (signal !== "TERM" && signal !== "KILL")
		throw new Error(`refusing to send ${JSON.stringify(signal)}`);
	return ["exec", container, "kill", `-${signal}`, String(pid)];
}

/**
 * @typedef {{ pid: number, comm: string, state: string, ppid: number, start: number | null }} Proc
 */

/**
 * The processes in `text`, one /proc/<pid>/stat per line. The comm is parenthesised and may hold spaces and
 * parentheses, so the state is the first field after the last ')', and the start time the twentieth.
 *
 * @param {string} text @returns {Proc[]}
 */
export function parseProcStat(text) {
	/** @type {Proc[]} */
	const procs = [];
	for (const line of String(text ?? "").split("\n")) {
		const open = line.indexOf("(");
		const close = line.lastIndexOf(")");
		if (open < 1 || close < open) continue;
		const pid = Number(line.slice(0, open).trim());
		const fields = line
			.slice(close + 1)
			.trim()
			.split(/\s+/);
		const [state, ppid] = fields;
		if (!Number.isInteger(pid) || !state || !/^\d+$/.test(ppid ?? "")) continue;
		const start = /^\d+$/.test(fields[19] ?? "") ? Number(fields[19]) : null;
		procs.push({
			pid,
			comm: line.slice(open + 1, close),
			state,
			ppid: Number(ppid),
			start,
		});
	}
	return procs;
}

/**
 * Which Harper process is running, as its pid and start time: a restarted container can hand Harper the
 * same pid, and the exit budget belongs to one process's life.
 *
 * @param {Proc[]} procs @param {string} hdbPidText the Harper root's hdb.pid
 */
export function harperIdentity(procs, hdbPidText) {
	const pid = Number(
		String(hdbPidText ?? "")
			.trim()
			.split(/\s+/)[0]
	);
	const proc = procs.find((p) => p.pid === pid);
	return proc ? `${pid}@${proc.start ?? "?"}` : null;
}

/**
 * The live pids of each named command and every zombie in the container.
 *
 * @param {Proc[]} procs @param {readonly string[]} comms
 */
export function census(procs, comms) {
	/** @type {Record<string, number[]>} */
	const live = Object.fromEntries(comms.map((comm) => [comm, []]));
	const zombies = [];
	for (const p of procs) {
		if (p.state.startsWith("Z")) zombies.push(p);
		else if (Object.hasOwn(live, p.comm)) live[p.comm].push(p.pid);
	}
	return { live, zombies };
}

/**
 * Zombies present in both reads, by pid and command: one read also catches a child between its exit and
 * its parent's wait, which is not a zombie anyone left behind.
 *
 * @param {Proc[]} first @param {Proc[]} second @returns {Proc[]}
 */
export function lastingZombies(first, second) {
	const earlier = new Set(first.map((z) => `${z.pid} ${z.comm}`));
	return second.filter((z) => earlier.has(`${z.pid} ${z.comm}`));
}

/**
 * What a census shows wrong against one live process per agent and no zombie. Empty when nothing is.
 *
 * @param {Record<string, number[]>} live @param {Proc[]} zombies Only those `lastingZombies` kept.
 * @returns {string[]}
 */
export function censusFailures(live, zombies) {
	const failures = [];
	for (const [comm, pids] of Object.entries(live))
		if (pids.length !== 1)
			failures.push(
				pids.length === 0
					? `no live ${comm}`
					: `${pids.length} live ${comm} (pids ${pids.join(", ")})`
			);
	for (const z of zombies)
		failures.push(`zombie ${z.comm} pid ${z.pid} (parent ${z.ppid})`);
	return failures;
}

/**
 * The most restarts any of `statuses` counts for the process `name`, and the first error one gives. Each
 * worker counts its own, so a check reads several.
 *
 * @param {readonly any[]} statuses @param {string} name
 * @returns {{ most: number | null, error: string | null }}
 */
export function restartsSeen(statuses, name) {
	let most = null;
	let error = null;
	for (const s of statuses) {
		const p = s?.processes?.find((/** @type {any} */ x) => x.name === name);
		if (!p) continue;
		if (Number.isInteger(p.restarts)) most = Math.max(most ?? 0, p.restarts);
		if (p.error && error === null) error = String(p.error);
	}
	return { most, error };
}

/**
 * Why the guard did not honour a deliberate stop, read from the restarts counted before the SIGTERM and after
 * its window, or null when it did. A guard that went back for the process did not honour it, started or not.
 *
 * @param {ReturnType<typeof restartsSeen>} before @param {ReturnType<typeof restartsSeen>} after
 * @param {string} name
 */
export function stopNotHonoured(before, after, name) {
	if (after.most === null)
		return `no status named ${name} after the window, so the guard's restarts were not read`;
	const went = after.most - (before.most ?? 0);
	return went > 0
		? `the guard went back for ${name} ${went} time(s) after the SIGTERM${after.error ? ` (${after.error})` : ""}`
		: null;
}

/**
 * Run `step`, and when it throws run `bringBack` before the error goes on, so no way out of a deliberate stop
 * leaves the stopped process down for a later check to be charged with.
 *
 * @template T
 * @param {() => Promise<T>} step
 * @param {() => Promise<unknown>} bringBack
 */
export async function bringBackOnThrow(step, bringBack) {
	try {
		return await step();
	} catch (error) {
		await bringBack();
		throw error;
	}
}

// ---------------------------------------------------------------------------------------------------
// Worker probes: the chaos component answers with the slot and thread that served the request.

/**
 * @typedef {{ threadId: number, workerIndex: number, workerCount: number, restartNumber: number,
 *   exiting?: boolean }} WorkerAnswer
 */

/** Whether `value` is an answer the chaos component gives. @returns {value is WorkerAnswer} */
export function isWorkerAnswer(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		Number.isInteger(value.threadId) &&
		Number.isInteger(value.workerIndex) &&
		Number.isInteger(value.workerCount) &&
		Number.isInteger(value.restartNumber)
	);
}

/**
 * The pool as a round of probes saw it: the thread serving each slot, and the count the workers were given.
 * A slot answered by two threads is mid-replacement, and the later answer wins.
 *
 * @param {readonly unknown[]} answers
 */
export function poolView(answers) {
	/** @type {Map<number, { threadId: number, restartNumber: number }>} */
	const slots = new Map();
	const counts = new Set();
	for (const answer of answers) {
		if (!isWorkerAnswer(answer)) continue;
		slots.set(answer.workerIndex, {
			threadId: answer.threadId,
			restartNumber: answer.restartNumber,
		});
		counts.add(answer.workerCount);
	}
	return { slots, workerCount: counts.size === 1 ? [...counts][0] : null };
}

/** The highest restart number a view holds: Harper raises it for every worker a restart starts. */
export const lastRestart = (/** @type {ReturnType<typeof poolView>} */ view) =>
	Math.max(0, ...[...view.slots.values()].map((s) => s.restartNumber));

/**
 * Whether every slot of a pool of `count` answered from a worker a later restart started than any `before`
 * saw: the whole pool was replaced and has come back. An exit's replacement keeps the old number.
 *
 * @param {ReturnType<typeof poolView>} before @param {ReturnType<typeof poolView>} now @param {number} count
 */
export function poolReplaced(before, now, count) {
	if (now.workerCount !== count || now.slots.size !== count) return false;
	const floor = lastRestart(before);
	return [...now.slots.values()].every((s) => s.restartNumber > floor);
}

/** The pool as one phrase for chaos.log. @param {ReturnType<typeof poolView>} view */
export const describePool = (view) =>
	[...view.slots.entries()]
		.sort(([a], [b]) => a - b)
		.map(([slot, s]) => `${slot}:t${s.threadId}/r${s.restartNumber}`)
		.join(" ") || "no worker answered";

// ---------------------------------------------------------------------------------------------------
// Check lines in chaos.log, written by the harness and counted by the evaluator.

/** A check's line: `#<n> <action> check <what>: passed`, or `: FAILED: <each failure>`. */
export function checkLine(n, action, what, failures) {
	if (what.includes(":")) throw new Error("a check's name holds no colon");
	return `#${n} ${action} check ${what}: ${failures.length ? `FAILED: ${failures.join("; ")}` : "passed"}`;
}
export const CHECK_LINE = /#\d+ [\w-]+ check [^:]+: (?:passed|FAILED)/;
export const CHECK_FAILED = /#\d+ [\w-]+ check [^:]+: FAILED/;
/** The line that opens an action, or says it was skipped or refused, and no other. */
export const ACTION_LINE =
	/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d #\d+ [\w-]+(?: \(pid \d+\))?(?: with a deliberate stop)?(?::| skipped| could not be applied)/;

// ---------------------------------------------------------------------------------------------------
// The exit budget. Harper stops replacing a slot after 50 unexpected exits in one process's life, so the
// soak ends each slot at most SLOT_EXIT_CAP times per Harper process and leaves the rest for real faults.

export const SLOT_EXIT_CAP = 10;
/** The most slots one exit action ends. */
export const EXITS_PER_ACTION = 3;

/**
 * The slots of a pool of `count` that may still be ended, given the ends already spent on each.
 *
 * @param {Record<number, number>} spent @param {number} count @param {number} [cap]
 */
export function slotsUnderCap(spent, count, cap = SLOT_EXIT_CAP) {
	const slots = [];
	for (let slot = 0; slot < count; slot++)
		if ((spent[slot] ?? 0) < cap) slots.push(slot);
	return slots;
}

/**
 * K random slots out of `eligible`, K itself random from 1 to `most`, in ascending order.
 *
 * @param {() => number} rng @param {readonly number[]} eligible @param {number} [most]
 */
export function chooseExits(rng, eligible, most = EXITS_PER_ACTION) {
	if (!eligible.length) return [];
	const k = randomInt(rng, 1, Math.min(most, eligible.length));
	return shuffled(rng, eligible)
		.slice(0, k)
		.sort((a, b) => a - b);
}

/**
 * A new worker count for the pool: from 2 up to one above the count the leg was installed with, never the
 * count it has now, so the pool grows or shrinks every time.
 *
 * @param {() => number} rng @param {number} current @param {number} installed
 */
export function chooseCount(rng, current, installed) {
	const choices = [];
	for (let n = 2; n <= Math.max(installed + 1, 3); n++)
		if (n !== current) choices.push(n);
	return choices[Math.floor(rng() * choices.length)];
}

// ---------------------------------------------------------------------------------------------------
// Operations, and the payload a redeploy sends.

export const ops = {
	restartWorkers: () => ({
		operation: "restart_service",
		service: "http_workers",
	}),
	/** @param {string} payload base64 tar @param {true | "rolling"} restart */
	deploy: (payload, restart) => ({
		operation: "deploy_component",
		project: "soak-chaos",
		payload,
		restart,
	}),
	/** @param {string} file @param {string} payload */
	setFile: (file, payload) => ({
		operation: "set_component_file",
		project: "soak-chaos",
		file,
		payload,
	}),
	/** @param {string} file */
	dropFile: (file) => ({
		operation: "drop_component",
		project: "soak-chaos",
		file,
		restart: true,
	}),
	/** @param {string} id */
	job: (id) => ({ operation: "get_job", id }),
	/** @param {number} count */
	setThreads: (count) => ({
		operation: "set_configuration",
		threads_count: count,
	}),
};

/** The one job `get_job` answered, or null. @param {unknown} answer */
export function jobOf(answer) {
	const job = Array.isArray(answer) ? answer[0] : null;
	return job && typeof job === "object" && typeof job.status === "string"
		? { status: job.status, message: String(job.message ?? "") }
		: null;
}

/**
 * A ustar archive of `files`, each a relative name under 100 bytes, owned by uid and gid 0.
 *
 * @param {ReadonlyArray<{ name: string, data: string | Buffer }>} files
 * @param {number} [mtime] seconds since the epoch, stamped on every entry
 * @returns {Buffer}
 */
export function tarFiles(files, mtime = 0) {
	const blocks = [];
	for (const { name, data } of files) {
		const body = Buffer.from(data);
		if (Buffer.byteLength(name) >= 100 || name.startsWith("/"))
			throw new Error(
				`a tar entry needs a relative name under 100 bytes, not ${name}`
			);
		const header = Buffer.alloc(512);
		const put = (text, at, length) => header.write(text, at, length, "ascii");
		const octal = (n, width) => n.toString(8).padStart(width - 1, "0");
		put(name, 0, 100);
		put(octal(0o644, 8), 100, 8);
		put(octal(0, 8), 108, 8);
		put(octal(0, 8), 116, 8);
		put(octal(body.length, 12), 124, 12);
		put(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12);
		put("        ", 148, 8);
		put("0", 156, 1);
		put("ustar\u000000", 257, 8);
		let sum = 0;
		for (const byte of header) sum += byte;
		put(`${octal(sum, 7)}\u0000 `, 148, 8);
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}
