#!/usr/bin/env node
// A long run against a real Harper container: steady load on the shop, chaos on a randomly staggered schedule,
// and one status row a minute from the agents' own intake counters and the container's resource use.

import { execFile, execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Harper's own self-signed certificate on the app port.

const run = promisify(execFile);
const CONTAINER = process.env.SOAK_CONTAINER ?? "harper-demo";
const VOLUME = process.env.SOAK_VOLUME ?? "harper-demo-vol";
const IMAGE = process.env.SOAK_IMAGE ?? "harperfast/harper:5.2.9";
// Parameterised with CONTAINER and VOLUME, so two runs can drive two containers on two ports.
const PORT = Number(process.env.SOAK_PORT ?? 9926);
/** The port inside the container, which the host port above is published onto. Irrelevant in host mode. */
const PORT_IN_CONTAINER = Number(process.env.SOAK_CONTAINER_PORT ?? 9926);
const BASE = `https://localhost:${PORT}`;
const AUTH = "Basic " + Buffer.from("admin:password").toString("base64");
/** The node's data root, where the pid locks live. In host mode, wherever that Harper was installed. */
const ROOT = process.env.SOAK_ROOT ?? "/home/harperdb/harper";
// The three pid files a restart seeds, by the names the plugin locks on. Retyped here rather than imported
// because this runs against a container from outside it, with no dependency on this checkout's runtime/.
const NAMES = ["datadog-trace-agent", "datadog-agent", "datadog-agent-reaper"];
import { parseStamp, stamp } from "./soak-clock.mjs";
import { mountsPath, runRecreate, runSpec } from "./soak-container.mjs";

const HOURS = Number(process.env.SOAK_HOURS ?? 48);
const RPS = Number(process.env.SOAK_RPS ?? 20);
const KEY_MIN = Number(process.env.SOAK_KEY_MIN ?? 10);
const [GAP_MIN, GAP_MAX] = (process.env.SOAK_GAP_MIN ?? "10,30")
	.split(",")
	.map(Number);
const OUT = process.env.SOAK_OUT ?? join(process.cwd(), "soak-out");
mkdirSync(OUT, { recursive: true });
const STATUS_TSV = join(OUT, "status.tsv");
const CHAOS_LOG = join(OUT, "chaos.log");

const log = (line) => console.log(`${stamp()} ${line}`);
const chaosLog = (line) => {
	log(`CHAOS ${line}`);
	appendFileSync(CHAOS_LOG, `${stamp()} ${line}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A failure as it may be logged. An execFile error's message and `cmd` open with the whole argv, so a failed
 * command is reduced to its exit status and first stderr line rather than trusting every argv to hold no secret.
 *
 * @param {unknown} error @returns {string}
 */
function failure(error) {
	const e =
		/** @type {{ cmd?: unknown, code?: unknown, signal?: unknown, stderr?: unknown }} */ (
			error ?? {}
		);
	if (typeof e === "object" && ("cmd" in e || "stderr" in e)) {
		const line =
			String(e.stderr ?? "")
				.split("\n")
				.map((text) => text.trim())
				.find(Boolean) ?? "no stderr";
		return `${e.signal ? `signal ${e.signal}` : `exit ${e.code ?? "unknown"}`}: ${line}`;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Where the node under test runs: a container driven through docker, or in host mode this machine's Harper,
 * driven through its own CLI. Measurements from the two modes are not comparable with each other.
 */
const HOST_MODE = (process.env.SOAK_MODE ?? "docker") === "host";
const sh = async (cmd) =>
	HOST_MODE
		? (await run("sh", ["-c", cmd], { maxBuffer: 8 << 20 })).stdout
		: (
				await run("docker", ["exec", CONTAINER, "sh", "-c", cmd], {
					maxBuffer: 8 << 20,
				})
			).stdout;
const docker = (...args) => run("docker", args, { maxBuffer: 8 << 20 });
/** The Harper CLI drives host mode the way `docker` drives a container. */
const harperCli = (...args) => run("harper", args, { maxBuffer: 8 << 20 });

/**
 * The environment the host's Harper runs with, captured before anything restarts it, since `harper start`
 * inherits only this process's. Values are never logged; the names are, so a missing one shows.
 */
let hostEnv = null;
async function captureHostEnv() {
	// Every candidate, not the first: `ps | grep harper` matches anything carrying the word, and the Harper that
	// matters is the one whose environment holds the agents' variables.
	for (const pid of await hostHarperPids()) {
		try {
			// `ps -E` prints the environment after the command; macOS has no /proc to read it from.
			const out = await run(
				"ps",
				["-Ewww", "-o", "command=", "-p", String(pid)],
				{
					maxBuffer: 8 << 20,
				}
			);
			const captured = {};
			for (const token of out.stdout.split(/\s+/)) {
				const eq = token.indexOf("=");
				if (eq <= 0) continue;
				const name = token.slice(0, eq);
				// Only what configures the agents. Replaying PATH or HOME would fight the restarting shell.
				if (/^(DD_|HDB_|TC_|LOGGING_|OPERATIONSAPI_)/.test(name))
					captured[name] = token.slice(eq + 1);
			}
			if (Object.keys(captured).length) return captured;
		} catch {
			// unreadable, or gone between the listing and the read; try the next candidate
		}
	}
	return null;
}

/** Every pid of the host's Harper, the main process first. Empty when it is not running. */
async function hostHarperPids() {
	try {
		const out = await sh(
			"ps -eo pid,command | grep -i '[h]arper' | grep -v ' grep ' | awk '{print $1}'"
		);
		return out.trim().split(/\s+/).filter(Boolean).map(Number).filter(Boolean);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------------------------------
// Load: a fixed rate spread over a handful of workers, paths discovered from the shop's own listing.

const load = { sent: 0, ok: 0, failed: 0, latencyMs: [], multiplier: 1 };
let paths = ["/", "/products"];
async function discoverPaths() {
	try {
		const html = await (await fetch(`${BASE}/products`)).text();
		const found = [
			...new Set(
				[...html.matchAll(/href="(\/products\/[^"?#]+)"/g)].map((m) => m[1])
			),
		];
		if (found.length) paths = ["/", "/products", ...found.slice(0, 8)];
	} catch {
		// The next discovery gets it.
	}
}
async function hit() {
	const path = paths[Math.floor(Math.random() * paths.length)];
	const started = Date.now();
	load.sent++;
	try {
		const response = await fetch(`${BASE}${path}`, {
			signal: AbortSignal.timeout(15_000),
		});
		if (response.ok) load.ok++;
		else load.failed++;
		await response.arrayBuffer();
	} catch {
		load.failed++;
	}
	load.latencyMs.push(Date.now() - started);
}
function startLoad(stop) {
	let inFlight = 0;
	const tick = () => {
		if (stop.stopped) return;
		const wanted = Math.round((RPS * load.multiplier) / 10); // ten ticks a second
		for (let i = 0; i < wanted && inFlight < 200; i++) {
			inFlight++;
			hit().finally(() => inFlight--);
		}
	};
	const timer = setInterval(tick, 100);
	const discover = setInterval(discoverPaths, 60_000);
	discoverPaths();
	return () => {
		clearInterval(timer);
		clearInterval(discover);
	};
}

// ---------------------------------------------------------------------------------------------------
// Reads: the plugin's own status, both agents' expvars, container resource use.

/**
 * The node's own /DatadogStatus/, or null when it did not answer. A long run reads this every minute and a
 * read that lands during a restart answers null, which is an ordinary result rather than a failure.
 *
 * @returns {Promise<any>}
 */
async function status() {
	try {
		const response = await fetch(`${BASE}/DatadogStatus/`, {
			headers: { authorization: AUTH },
			signal: AbortSignal.timeout(10_000),
		});
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}
/** @returns {Promise<{ core: any, trace: any }>} */
async function expvars() {
	try {
		const out = await sh(
			"curl -s -m 5 http://127.0.0.1:5000/debug/vars; echo; echo ---SPLIT---; curl -sk -m 5 https://127.0.0.1:5012/debug/vars"
		);
		const [core, trace] = out.split("---SPLIT---").map((part) => {
			try {
				return JSON.parse(part.trim());
			} catch {
				return null;
			}
		});
		return { core, trace };
	} catch {
		return { core: null, trace: null };
	}
}
async function containerStats() {
	if (HOST_MODE) {
		try {
			// The node's own process tree rather than a container's cgroup: %cpu is per-process and summed,
			// rss likewise. Not the same measurement as docker's, and not compared against it.
			const out = await sh(
				"ps -eo pcpu,rss,command | grep -i '[h]arper' | grep -v ' grep ' | " +
					"awk '{c+=$1; r+=$2} END {printf \"%.2f%% %.3fGiB\", c, r/1048576}'"
			);
			const [cpu, mem] = out.trim().split(/\s+/);
			return { cpu: cpu || "-", mem: mem || "-" };
		} catch {
			return { cpu: "-", mem: "-" };
		}
	}
	try {
		const { stdout } = await docker(
			"stats",
			"--no-stream",
			"--format",
			"{{json .}}",
			CONTAINER
		);
		const s = JSON.parse(stdout);
		return { cpu: s.CPUPerc, mem: s.MemUsage.split(" / ")[0] };
	} catch {
		return { cpu: "-", mem: "-" };
	}
}
async function rss(pids) {
	if (HOST_MODE) {
		// macOS has no /proc. `ps -o rss=` prints kibibytes, which is what the /proc branch converts to.
		return Promise.all(
			pids.map(async (pid) => {
				if (!Number(pid)) return "-";
				try {
					const out = await sh(`ps -o rss= -p ${Number(pid)}`);
					const kb = Number(out.trim());
					return kb ? String(Math.round(kb / 1024)) : "-";
				} catch {
					return "-";
				}
			})
		);
	}
	try {
		// One token per pid, whatever happens to it.
		const out = await sh(
			`for pid in ${pids.map((pid) => Number(pid) || 0).join(" ")}; do ` +
				`v=$(awk '/VmRSS/{printf "%d", $2/1024}' /proc/$pid/status 2>/dev/null); ` +
				`printf '%s ' "\${v:--}"; done`
		);
		const columns = out.trim().split(/\s+/);
		// Never fewer than asked for: a short row is what silently mislabels the two agents' memory.
		return pids.map((_, index) => columns[index] ?? "-");
	} catch {
		return pids.map(() => "-");
	}
}

/** The box's one-minute load average on every row, so a starved node can be told from a broken one later. */
const loadAverage = () => {
	try {
		return loadavg()[0];
	} catch {
		return null;
	}
};

/**
 * Restart the node under test. In host mode that is a stop and a start, since `harper restart` exits 4 while
 * Harper is up; the stop may fail, because a node already down is what the start wants.
 */
const restartNode = async () => {
	if (!HOST_MODE) {
		await docker("restart", CONTAINER);
		return claimRestartWindow();
	}
	await harperCli("stop").catch(() => {});
	// Replayed, not inherited (see captureHostEnv); what this process sets itself wins, which is how the key swaps.
	if (hostEnv)
		for (const [k, v] of Object.entries(hostEnv)) process.env[k] ??= v;
	await harperCli("start");
	return claimRestartWindow();
};

/**
 * Claim a window in which the node is deliberately disrupted, so nothing it refuses is charged to it. It only
 * ever extends, and every claim comes through here, so the longest wins.
 *
 * @param {number} minutes
 */
const claimWindow = (minutes) => {
	chaos.at = Date.now();
	chaos.busyUntil = Math.max(chaos.busyUntil, Date.now() + minutes * 60_000);
};

/** Every restart claims a window: `harper start` returns long before the node serves and its agents verify. */
const claimRestartWindow = () => claimWindow(HOST_MODE ? 15 : 3);

/**
 * Hold the node still: `docker pause`, or SIGSTOP to Harper's own tree in host mode. The agents keep running,
 * since the action is an unresponsive node rather than dead agents.
 */
async function pauseNode() {
	if (!HOST_MODE) return docker("pause", CONTAINER);
	for (const pid of await hostHarperPids())
		try {
			process.kill(pid, "SIGSTOP");
		} catch {
			// gone between the listing and the signal
		}
}
async function resumeNode() {
	if (!HOST_MODE) return docker("unpause", CONTAINER);
	for (const pid of await hostHarperPids())
		try {
			process.kill(pid, "SIGCONT");
		} catch {
			// gone between the listing and the signal
		}
}

// ---------------------------------------------------------------------------------------------------
// Chaos: one action at a time, chosen at random without an immediate repeat, on gaps drawn at random.

const chaos = {
	last: "none",
	at: null,
	count: 0,
	results: [],
	busyUntil: 0,
	pending: [],
};

/** The least time any chaos action is assumed to disturb the node; host mode settles far more slowly. */
const MIN_DISRUPTION_MIN_HOST = 12;
const MIN_DISRUPTION_MIN_DOCKER = 3;
const STALL_ROWS = 3;
/** How long a pipeline may sit at zero after its agent restarted before that counts as stalled. */
const WARMING_ROWS = 15;
/** Counters that must keep climbing under load, and what the last row saw of each. */
const pipelines = {
	// Payload counts, not line counts: the logs agent batches, so a quiet three minutes is ordinary and only
	// a much longer silence means anything. Ten minutes under continuous load sending no log payload is not.
	logsSent: { label: "logs", last: null, quiet: 0, warming: 0, rows: 10 },
	fwdOK: {
		label: "metrics and everything else the core agent ships",
		last: null,
		quiet: 0,
		warming: 0,
		rows: STALL_ROWS,
	},
	series: {
		label: "metric series",
		last: null,
		quiet: 0,
		warming: 0,
		rows: STALL_ROWS,
	},
};
const stalls = { flagged: 0, verdictRows: 0, byPipeline: {} };
const pidOf = (s, kind) => s?.processes?.find((p) => p.kind === kind)?.pid;

/**
 * The pid of a running agent, waited for rather than read once.
 *
 * @param {"trace"|"core"} kind
 * @returns {Promise<number|undefined>}
 */
async function livePid(kind, attempts = 6) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const pid = pidOf(await status(), kind);
		if (Number.isInteger(pid) && pid > 0) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	return undefined;
}

/** What an action returns when the thing it perturbs is not there to perturb. */
const notApplicable = (why) => ({ skip: why });

const ACTIONS = {
	async "kill-trace-agent"() {
		const pid = await livePid("trace");
		if (!pid) return notApplicable("no trace-agent pid in the status to kill");
		await sh(`kill -9 ${pid}`);
		return {
			expect: "the guard restarts it under a new pid and it verifies",
			check: async (before) =>
				(await status())?.processes?.find((p) => p.kind === "trace"),
			before: pid,
		};
	},
	async "kill-core-agent"() {
		const pid = await livePid("core");
		if (!pid) return notApplicable("no core agent pid in the status to kill");
		await sh(`kill -9 ${pid}`);
		return {
			expect: "the guard restarts it under a new pid and it verifies",
			check: async () =>
				(await status())?.processes?.find((p) => p.kind === "core"),
			before: pid,
		};
	},
	async "kill-reaper"() {
		// Guarded like every other kill: a status publishing no reaper pid would run `kill -9 undefined` and pass.
		const pid = (await status())?.reaper?.pid;
		if (!pid) return notApplicable("no reaper pid in the status to kill");
		await sh(`kill -9 ${pid}`);
		return {
			expect:
				"the agents keep running and a replacement reaper comes up under a new pid",
			check: async () => (await status())?.reaper,
			before: pid,
		};
	},
	async restart() {
		await restartNode();
		return {
			expect: "both agents come back verified after the restart",
			check: async () => (await status())?.processes,
		};
	},
	async "restart-seeded-pid-1"() {
		// The seeded lock is a stale one, so the agents it names must be gone first. In host mode they survive the
		// restart, and a lock naming pid 1 beside a live agent is a different case from the stale file.
		if (HOST_MODE) await harperCli("stop").catch(() => {});
		await sh(
			`for n in ${NAMES.join(" ")}; do printf '1\\n' > ${ROOT}/pids/$n.pid; done`
		);
		await restartNode();
		return {
			expect:
				"the plugin removes Harper's three pid files naming pid 1 and both agents come back verified",
			check: async () => (await status())?.processes,
		};
	},
	async "stop-trace-agent-60s"() {
		const pid = await livePid("trace");
		if (!pid) return notApplicable("no trace-agent pid in the status to stop");
		await sh(`kill -STOP ${pid}`);
		claimWindow(1.5);
		chaos.pending.push(() => sh(`kill -CONT ${pid}`).catch(() => {}));
		setTimeout(() => sh(`kill -CONT ${pid}`).catch(() => {}), 60_000);
		return {
			expect:
				"delivery reads unavailable or idle while stopped, then recovers after SIGCONT",
			check: async () => (await status())?.delivery?.verdict,
		};
	},
	async "pause-30s"() {
		await pauseNode();
		claimWindow(1);
		chaos.pending.push(() => resumeNode().catch(() => {}));
		setTimeout(() => resumeNode().catch(() => {}), 30_000);
		return {
			expect: "requests fail for 30 s, then everything resumes with no restart",
			check: async () => (await status())?.processes,
		};
	},
	async "burst-10x-5min"() {
		load.multiplier = 10;
		claimWindow(6);
		chaos.pending.push(() => (load.multiplier = 1));
		setTimeout(() => (load.multiplier = 1), 5 * 60_000);
		return {
			expect: "latency rises, nothing restarts, traces keep flowing",
			check: async () => (await status())?.delivery?.verdict,
		};
	},
	async "wrong-api-key-10min"() {
		await recreate("0".repeat(32));
		claimWindow(KEY_MIN + 3);
		// Restoring the key is a SECOND full restart, ten minutes after the window stamped above. It needs
		// no bookkeeping here: recreate() restarts the node, and the restart claims its own window.
		const restore = () =>
			recreate(realApiKey()).catch((error) =>
				chaosLog(`restore failed: ${failure(error)}`)
			);
		chaos.pending.push(restore);
		setTimeout(restore, KEY_MIN * 60_000);
		return {
			expect:
				"delivery reads rejected within a few minutes; after the key is restored it reads delivering or traces-unconfirmed",
			check: async () => (await status())?.delivery?.verdict,
		};
	},
};

const realApiKey = () =>
	readFileSync(join(homedir(), ".config", "datadog", "API_KEY"), "utf8").trim();

/**
 * The `docker run` that would recreate the container as it actually is, read off the container itself.
 */
async function captureContainerSpec() {
	// promisify(execFile) resolves {stdout, stderr}, and this caller alone reads .stdout.
	const result = await docker(
		"inspect",
		"--format",
		"{{json .}}",
		CONTAINER
	).catch(() => null);
	if (!result?.stdout) return null;
	return runSpec(JSON.parse(result.stdout), CONTAINER, IMAGE);
}

/** What a recreate replays. Null until startup captures it, and a recreate refuses rather than guessing. */
let containerSpec = null;

/**
 * Remove the container and wait for its name to be free.
 */
const REMOVE_ROUNDS = 60;
const REMOVE_ROUND_MS = 1_000;
async function removeContainer() {
	for (let round = 0; round < REMOVE_ROUNDS; round++) {
		const refused = await docker("rm", "-f", CONTAINER).then(
			() => null,
			(error) => failure(error)
		);
		const found = await docker(
			"ps",
			"-aq",
			"--filter",
			`name=^${CONTAINER}$`
		).catch(() => ({ stdout: "" }));
		if (!found?.stdout?.trim()) {
			if (round > 0)
				chaosLog(`${CONTAINER} removed after ${round + 1} rm attempts`);
			return;
		}
		if (round === 0 && refused)
			chaosLog(`removing ${CONTAINER} failed, retrying: ${refused}`);
		await sleep(REMOVE_ROUND_MS);
	}
	throw new Error(
		`${CONTAINER} still holds its name after ${REMOVE_ROUNDS} docker rm -f attempts; nothing can recreate it`
	);
}

/**
 * Put the container back if a chaos action left it down.
 */
async function restoreContainerIfDown(after) {
	if (HOST_MODE) {
		const up = await harperCli("status")
			.then(({ stdout }) => /status:\s*running/.test(stdout))
			.catch(() => false);
		if (up) return;
		chaosLog(
			`the host leg's Harper is not running after ${after}; starting it`
		);
		await harperCli("start").catch((error) =>
			chaosLog(`could not start it: ${failure(error)}`)
		);
		return;
	}
	const running = await docker(
		"ps",
		"-q",
		"--filter",
		`name=^${CONTAINER}$`
	).catch(() => ({ stdout: "" }));
	if (running?.stdout?.trim()) return;
	chaosLog(`${CONTAINER} is not running after ${after}; recreating it`);
	try {
		await recreate(realApiKey());
		chaosLog(`${CONTAINER} recreated; the run continues`);
	} catch (error) {
		chaosLog(
			`${CONTAINER} could not be recreated: ${failure(error)}. Every row from ` +
				"here reads a container that is not there, and the failed-request count is the harness, not " +
				"the plugin."
		);
	}
}

async function recreate(apiKey) {
	if (HOST_MODE) {
		// In host mode the key moves in the environment Harper restarts with; a restart without DD_API_KEY renders an
		// empty key and silently stops delivering.
		process.env.DD_API_KEY = apiKey;
		await restartNode();
		return;
	}
	if (!containerSpec)
		throw new Error(
			"no container spec was captured at startup, so a recreate would build a container that is not " +
				"the one under test; refusing rather than replacing it with a guess"
		);
	// Without the root mount docker satisfies the image's VOLUME with a fresh anonymous one, and every row after
	// reads a container with no plugin in it as though the plugin were healthy.
	if (!mountsPath(containerSpec.args, ROOT))
		throw new Error(
			`the captured spec mounts nothing at ${ROOT}, so a recreate would start Harper on an empty ` +
				"volume with no component installed; refusing rather than testing a container that carries nothing"
		);
	await removeContainer();
	await run("docker", [
		"run",
		"--rm",
		"--entrypoint",
		"sh",
		"-v",
		`${VOLUME}:${ROOT}`,
		IMAGE,
		"-c",
		`rm -f ${ROOT}/hdb.pid`,
	]);
	await runRecreate(run, containerSpec, apiKey);
}

async function fireChaos() {
	const skipped = (process.env.SOAK_SKIP ?? "").split(",").filter(Boolean);
	const names = Object.keys(ACTIONS).filter(
		(name) => name !== chaos.last && !skipped.includes(name)
	);
	const pool = names.length
		? names
		: Object.keys(ACTIONS).filter((n) => !skipped.includes(n));
	const name = pool[Math.floor(Math.random() * pool.length)];
	chaos.count++;
	chaos.last = name;
	// The floor: every action claims at least this before it runs, and one that needs longer extends it.
	claimWindow(HOST_MODE ? MIN_DISRUPTION_MIN_HOST : MIN_DISRUPTION_MIN_DOCKER);
	try {
		const { expect, check, before, skip } = await ACTIONS[name]();
		// Nothing was perturbed, so there is nothing to read back in two minutes. Counted and logged rather
		// than silent: a run whose chaos keeps skipping is a run that is not testing what it claims to.
		if (skip) {
			chaos.results.push({ name, summary: `skipped: ${skip}` });
			chaosLog(`#${chaos.count} ${name} skipped: ${skip}`);
			return;
		}
		chaosLog(
			`#${chaos.count} ${name}${before ? ` (pid ${before})` : ""}: ${expect}`
		);
		// Read the outcome after the world has had time to move; two minutes covers a restart and a verify,
		// and a read that lands inside a pause is retried for a minute more.
		setTimeout(async () => {
			// Before reading the outcome, not only after a throw: `docker restart` can report success and leave the
			// container down. Two minutes in, no action is still holding it down on purpose.
			await restoreContainerIfDown(`#${chaos.count} ${name}`);
			let observed;
			for (let attempt = 0; attempt < 6; attempt++) {
				observed = await check(before).catch(
					(error) => `read failed: ${failure(error)}`
				);
				if (observed !== undefined && observed !== null) break;
				await sleep(10_000);
			}
			const summary =
				JSON.stringify(observed, [
					"name",
					"pid",
					"verified",
					"restarts",
					"started",
					"verdict",
				]) ?? String(observed);
			chaos.results.push({ name, summary });
			chaosLog(`#${chaos.count} ${name} after 2 min: ${summary.slice(0, 300)}`);
		}, 120_000);
	} catch (error) {
		chaosLog(`#${chaos.count} ${name} could not be applied: ${failure(error)}`);
		// An action that threw may have got as far as taking the container down. Recovered here as well
		// as at the readback, so an action that fails outright does not wait two minutes for it.
		await restoreContainerIfDown(`#${chaos.count} ${name} failed`);
	}
}
const nextGap = () => (GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN)) * 60_000;

// ---------------------------------------------------------------------------------------------------
// The status row.

const COLUMNS = [
	["time", 19],
	["up", 7],
	["cpu%", 8],
	["mem", 9],
	["harperMB", 8],
	["traceMB", 7],
	["coreMB", 6],
	["req/s", 5],
	["fail", 5],
	["p95ms", 6],
	["sup", 6],
	["load", 5],
	["verified", 8],
	// Five agents joined by "/" is 9 at one digit each, and a chaos run reaches two digits on some of them.
	["restarts", 11],
	["verdict", 19],
	["traces", 7],
	["spans", 6],
	["statsOK", 7],
	["statsErr", 8],
	["traceOK", 7],
	["traceErr", 8],
	["fwdOK", 6],
	["series", 7],
	["logsSent", 8],
	["logsErr", 7],
	["chaos", 32],
];
/** What a writer reports turned away, as errors/retries: a zero in either alone hides a wrong key. */
const refusals = (writer) =>
	writer ? `${writer.errors ?? "-"}/${writer.retries ?? "-"}` : "-";

const header = () =>
	COLUMNS.map(([name, width]) => String(name).padEnd(Number(width))).join(" ");
/** Columns already reported as too narrow, so one rotted width is one line and not one per minute. */
const truncated = new Set();

const row = (/** @type {Record<string, any>} */ values) =>
	COLUMNS.map(([name, rawWidth]) => {
		const width = Number(rawWidth);
		const value = String(values[name] ?? "-");
		// Silent truncation would drop the `%` off a CPU reading over 100; the TSV has the value whole, so say so once.
		if (value.length > width && !truncated.has(String(name))) {
			truncated.add(String(name));
			console.log(
				`soak: the ${name} column is ${width} wide and ${JSON.stringify(value)} needs ${value.length}. ` +
					`status.tsv has it whole; widen COLUMNS.`
			);
		}
		return value.slice(0, width).padEnd(width);
	}).join(" ");
let rows = 0;
/**
 * When this run's clock started, which is not when this process started. A restart to load a fix is part of
 * the test, not the end of it, so the clock has to survive one.
 */
function anchorStart(dir) {
	const file = join(dir, "started");
	try {
		const written = readFileSync(file, "utf-8").trim();
		const at = parseStamp(written);
		if (Number.isFinite(at)) {
			log(
				`soak: resuming the clock from ${written}, which this directory already carries`
			);
			return at;
		}
		log(
			`soak: ${file} reads "${written}", which is not a time; starting the clock now`
		);
	} catch {
		// No anchor here, so this is the first run into this directory.
	}
	writeFileSync(file, `${stamp()}\n`);
	return Date.now();
}

const startedAt = anchorStart(OUT);
let lastLoad = { sent: 0, ok: 0, failed: 0 };

/**
 * Put the container back if it is not running, whatever killed it. Chaos gaps run to 30 minutes, so recovery
 * cannot hang off the chaos schedule; it runs after the row, so the row still records the outage.
 */
async function watchdog() {
	if (chaos.busyUntil > Date.now()) return; // an action is deliberately holding the container down
	await restoreContainerIfDown("the status watchdog");
}

/**
 * Whether the node is far enough from the last chaos action for a stalled pipeline to mean something: a kill
 * or a recreate stops every counter for a minute or two.
 */
const quietNow = () =>
	chaos.busyUntil <= Date.now() &&
	(chaos.at === null || Date.now() - chaos.at > 3 * 60_000);

/**
 * Flag a pipeline that has stopped moving, or a trace verdict that reads refused, while nothing is being done
 * to the node. Counted rather than thrown, and reported in the run summary.
 *
 * @param {Record<string, any>} values The row just written.
 */
function assertPipelinesMoving(values) {
	if (!quietNow()) {
		for (const p of Object.values(pipelines)) p.quiet = 0;
		return;
	}
	for (const [column, p] of Object.entries(pipelines)) {
		const now = values[column];
		if (typeof now !== "number") continue;
		// A counter that went backwards is an agent that restarted: re-baseline, then give it WARMING_ROWS to send
		// something before it can be called stalled, since a restarted agent sits at zero until its first flush.
		if (p.last !== null && now < p.last) {
			p.quiet = 0;
			p.warming = WARMING_ROWS;
		} else if (p.warming > 0 && now > 0) {
			// It has sent something since the reset, so normal detection resumes.
			p.warming = 0;
			p.quiet = 0;
		} else if (p.warming > 0) {
			p.warming -= 1;
			p.quiet = 0;
		} else {
			p.quiet = p.last !== null && now === p.last ? p.quiet + 1 : 0;
		}
		p.last = now;
		if (p.quiet === p.rows) {
			stalls.flagged++;
			stalls.byPipeline[column] = (stalls.byPipeline[column] ?? 0) + 1;
			log(
				`STALL: ${p.label} has not moved for ${p.rows} minutes with no chaos in flight ` +
					`(${column} held at ${now}). The pipeline is down and this is not a chaos window.`
			);
		}
	}
	if (values.verdict === "rejected") {
		stalls.verdictRows++;
		if (stalls.verdictRows % STALL_ROWS === 0)
			log(
				`STALL: delivery has read rejected for ${stalls.verdictRows} rows with no chaos in flight. ` +
					`Check the trace-agent log for the reason; a name-resolution failure and a client timeout ` +
					`both read this way, and neither is this node's doing.`
			);
	} else {
		stalls.verdictRows = 0;
	}
}

async function statusRow() {
	const [s, vars, stats] = await Promise.all([
		status(),
		expvars(),
		containerStats(),
	]);
	const tracePid = pidOf(s, "trace");
	const corePid = pidOf(s, "core");
	// Harper's own node process is the biggest one; pid 1 is a one-megabyte shim in front of it. In host mode
	// there is no /proc and no shim, so the biggest Harper process is found through ps.
	const harperPid = HOST_MODE
		? await sh(
				"ps -eo rss,pid,command | grep -i '[h]arper' | grep -v ' grep ' | sort -rn | head -1 | awk '{print $2}'"
			)
				.then((out) => Number(out.trim()) || 0)
				.catch(() => 0)
		: await sh(
				`for d in /proc/[0-9]*; do p=$(basename $d); awk -v p=$p '/VmRSS/{print $2, p}' $d/status; done | sort -n | tail -1 | awk '{print $2}'`
			)
				.then((out) => Number(out.trim()) || 0)
				.catch(() => 0);
	const [harperMB, traceMB, coreMB] = await rss([
		harperPid,
		tracePid ?? 0,
		corePid ?? 0,
	]);
	const sent = load.sent - lastLoad.sent;
	const failed = load.failed - lastLoad.failed;
	lastLoad = { sent: load.sent, ok: load.ok, failed: load.failed };
	const sorted = load.latencyMs.splice(0).sort((a, b) => a - b);
	const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : "-";
	// The metrics hop: SeriesFlushed climbing is the aggregator handing series to the forwarder, and the
	// forwarder's own Success count is that hop landing.
	const series = vars.core?.aggregator?.SeriesFlushed;
	const forwarder = vars.core?.forwarder?.Transactions ?? {};
	const fwdOK =
		Object.values(forwarder.Success ?? {}).reduce(
			(sum, n) => sum + (Number(n) || 0),
			0
		) || forwarder.Success;
	const logs = vars.core?.["logs-agent"] ?? {};
	const d = s?.delivery ?? {};
	const values = {
		time: stamp(),
		up: `${((Date.now() - startedAt) / 3_600_000).toFixed(2)}h`,
		"cpu%": stats.cpu,
		mem: stats.mem,
		harperMB,
		traceMB,
		coreMB,
		"req/s": (sent / 60).toFixed(1),
		fail: failed,
		load: (loadAverage() ?? 0).toFixed(1),
		p95ms: p95,
		sup: s?.supervision ?? "-",
		verified: s
			? s.processes
					.map((p) =>
						p.verified === true ? "T" : p.verified === false ? "F" : "?"
					)
					.join("")
			: "-",
		restarts: s ? s.processes.map((p) => p.restarts).join("/") : "-",
		verdict: d.verdict ?? "-",
		traces: d.receiver?.tracesReceived ?? "-",
		spans: d.receiver?.spansReceived ?? "-",
		statsOK: d.statsWriter?.payloads ?? "-",
		// errors/retries, because the verdict reads both and a retry is what a wrong key produces first.
		statsErr: refusals(d.statsWriter),
		traceOK: d.traceWriter?.payloads ?? "-",
		traceErr: refusals(d.traceWriter),
		fwdOK: typeof fwdOK === "number" ? fwdOK : "-",
		series: typeof series === "number" ? series : "-",
		logsSent: logs.LogsSent ?? "-",
		logsErr: logs.DestinationErrors ?? "-",
		// The harness states when it holds the node busy, so the evaluator reads this marker rather than inferring it
		// from elapsed minutes.
		chaos: chaos.at
			? `${chaos.last} ${Math.round((Date.now() - chaos.at) / 60_000)}m ago${
					chaos.busyUntil > Date.now() ? " busy" : ""
				}`
			: "none",
	};
	if (rows++ % 20 === 0) console.log(header());
	console.log(row(values));
	assertPipelinesMoving(values);
	appendFileSync(
		STATUS_TSV,
		(rows === 1 ? COLUMNS.map(([n]) => n).join("\t") + "\n" : "") +
			COLUMNS.map(([n]) => values[n]).join("\t") +
			"\n"
	);
}

/**
 * Ask Datadog what it received for this run, which no local reading can establish. Needs an application key at
 * ~/.config/datadog/APP_KEY, since the intake key is refused by every read endpoint.
 */
async function confirmAtDatadog() {
	const site = process.env.DD_SITE ?? "datadoghq.com";
	let appKey;
	let apiKey;
	try {
		appKey = readFileSync(
			join(homedir(), ".config/datadog/APP_KEY"),
			"utf-8"
		).trim();
		apiKey = readFileSync(
			join(homedir(), ".config/datadog/API_KEY"),
			"utf-8"
		).trim();
	} catch {
		log(
			"soak: no application key at ~/.config/datadog/APP_KEY, so nothing was asked of Datadog. Every " +
				"delivery figure above is the agents' own accounting of what they believe they sent, and traces " +
				"are unrefuted rather than confirmed."
		);
		return;
	}
	const from = Math.floor(startedAt / 1000);
	const to = Math.floor(Date.now() / 1000);
	const host = process.env.DD_HOSTNAME ?? CONTAINER;
	const ask = async (label, path, body) => {
		try {
			const res = await fetch(`https://api.${site}${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"DD-API-KEY": apiKey,
					"DD-APPLICATION-KEY": appKey,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok)
				return log(`soak: Datadog refused the ${label} query (${res.status})`);
			const json = /** @type {{ data?: unknown[] }} */ (await res.json());
			// Both endpoints answer with a data array; the length is what this is for.
			log(
				`soak: Datadog reports ${(json.data ?? []).length} ${label} from the node's host since the run started`
			);
		} catch (error) {
			log(`soak: could not ask Datadog for ${label} (${failure(error)})`);
		}
	};
	await ask("spans", "/api/v2/spans/events/search", {
		data: {
			attributes: {
				filter: { from: `${from}`, to: `${to}`, query: `host:${host}` },
				page: { limit: 25 },
			},
			type: "search_request",
		},
	});
	await ask("logs", "/api/v2/logs/events/search", {
		filter: { from: `${from}000`, to: `${to}000`, query: `host:${host}` },
		page: { limit: 25 },
	});
}

// ---------------------------------------------------------------------------------------------------

/**
 * Refuse to run against a container other than the one named: docker starts a container whose ports are
 * taken with no publication and reports success, and another container would answer every request.
 */
async function assertContainerOwnsPort() {
	if (HOST_MODE) {
		// No publication to check, so the question is whether this Harper answers on the port the run will drive.
		const answered = await fetch(`${BASE}/`, {
			signal: AbortSignal.timeout(8000),
		}).then(
			() => true,
			() => false
		);
		if (!answered)
			throw new Error(
				`soak: nothing answers ${BASE} on this host, so there is no leg to drive. Start Harper ` +
					"against this leg's root and confirm it serves before a run starts."
			);
		return;
	}
	let mapped;
	try {
		mapped = (
			await run("docker", ["port", CONTAINER, String(PORT_IN_CONTAINER)])
		).stdout;
	} catch (error) {
		throw new Error(
			`soak: cannot read ${CONTAINER}'s port map (${failure(error)}). ` +
				`It must be running and publishing 9926 before a run starts.`
		);
	}
	if (!new RegExp(`:${PORT}\\b`).test(mapped)) {
		throw new Error(
			`soak: ${CONTAINER} does not publish 9926 on host port ${PORT}; docker reports "${mapped.trim() || "nothing"}". ` +
				`Whatever is answering ${BASE} is a different container, so every row would be labelled wrongly. ` +
				`Stop the other leg and recreate this one: docker start alone will not add a publication it failed to take.`
		);
	}
}

async function main() {
	log(
		`soak: ${HOURS}h at ${RPS} req/s against ${CONTAINER} (${IMAGE}); chaos every ${GAP_MIN}-${GAP_MAX} min`
	);
	await assertContainerOwnsPort();
	if (HOST_MODE) {
		hostEnv = await captureHostEnv();
		log(
			`soak: host mode. The node is this machine's Harper, driven through its own CLI; resource figures ` +
				`come from the Harper process tree rather than a container and are not comparable with a ` +
				`docker leg's.`
		);
		log(
			hostEnv
				? `soak: captured the running Harper's agent environment (${Object.keys(hostEnv).sort().join(", ")}); restarts replay it`
				: `soak: could not read the running Harper's environment, so a restart will inherit this process's instead and may drop what the operator exported`
		);
	} else {
		containerSpec = await captureContainerSpec();
		log(
			containerSpec
				? `soak: captured the container's own run configuration (${containerSpec.args.filter((a) => a === "--cap-add").length} added capabilities, ${containerSpec.args.filter((a) => a === "-v").length} mounts); recreates replay it`
				: `soak: ${CONTAINER} is not running, so no run configuration was captured; any chaos action that recreates it will refuse`
		);
	}
	const stop = { stopped: false };
	const stopLoad = startLoad(stop);
	const end = Date.now() + HOURS * 3_600_000;
	let nextChaos = Date.now() + nextGap();
	const statusTimer = setInterval(
		() =>
			statusRow()
				.then(watchdog)
				.catch((error) => log(`status failed: ${failure(error)}`)),
		60_000
	);
	await statusRow();
	const finish = async () => {
		stop.stopped = true;
		stopLoad();
		clearInterval(statusTimer);
		for (const undo of chaos.pending.splice(0)) await undo();
		log(
			`soak: finished after ${((Date.now() - startedAt) / 3_600_000).toFixed(2)}h, ${chaos.count} chaos actions, ${load.sent} requests (${load.failed} failed)`
		);
		const stalled = Object.entries(stalls.byPipeline)
			.map(([k, n]) => `${k} x${n}`)
			.join(", ");
		log(
			stalls.flagged === 0
				? "soak: every pipeline kept climbing in every quiet row"
				: `soak: ${stalls.flagged} pipeline stall(s) outside a chaos window: ${stalled}`
		);
		await confirmAtDatadog();
		for (const r of chaos.results)
			log(`  ${r.name}: ${r.summary.slice(0, 200)}`);
		process.exit(0);
	};
	process.on("SIGTERM", finish);
	process.on("SIGINT", finish);
	while (Date.now() < end) {
		if (Date.now() >= nextChaos && Date.now() >= chaos.busyUntil) {
			await fireChaos();
			nextChaos = Date.now() + nextGap();
		}
		await sleep(5_000);
	}
	finish();
}

main().catch((error) => {
	log(`soak: fatal ${failure(error)}`);
	process.exit(1);
});
