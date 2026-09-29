// Harper declares every method on its Logger optional (harper/dist/components/Logger.d.ts), and the bundled
// guard calls ctx.log.info unguarded once it has spawned an agent and committed its lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { APP_NAME, BOTH_AGENTS, REAPER } from "../support/agents.js";
import {
	halt,
	lockedPid,
	start,
	waitForLocksCleared,
	withBuiltBinaries,
} from "../support/component.js";
import { findFreePort } from "../support/loopback.js";
import { withEnvs, withTempDir } from "../support/sandbox.js";

/**
 * `run` with the compartment's `logger` replaced, put back however it ends. resources.js reads the global at
 * module evaluation, so this has to be in place before the component is loaded.
 */
async function withCompartmentLogger(logger, run) {
	const had = "logger" in globalThis;
	const previous = globalThis.logger;
	globalThis.logger = logger;
	try {
		return await run();
	} finally {
		if (had) globalThis.logger = previous;
		else delete globalThis.logger;
	}
}

test("a Harper logger with no .info still gets both agents started and a reaper launched", async () => {
	// Exactly the shape Logger.d.ts permits.
	const lines = [];
	const partial = {
		warn: (message) => lines.push(`warn ${message}`),
		error: (message) => lines.push(`error ${message}`),
	};

	await withTempDir("dd-partial-log-", async (root) => {
		const pidDir = path.join(root, "datadog", APP_NAME, "pids");
		let status;
		try {
			status = await withEnvs(
				{
					ROOTPATH: root,
					// Nothing listens on these, so each verify gives up on its first refused probe.
					DD_APM_RECEIVER_PORT: String(await findFreePort()),
					DD_EXPVAR_PORT: String(await findFreePort()),
					DD_APM_DEBUG_PORT: String(await findFreePort()),
					DD_API_KEY: "test-key-not-a-real-one",
				},
				() =>
					withCompartmentLogger(partial, () =>
						// A Scope with no `processes` selects the guard, which is the path that calls ctx.log.info.
						withBuiltBinaries(() => start({})).then((r) => r.status)
					)
			);

			// The subject is the logger: the guard got through its spawn loop, whether or not the process stayed up.
			for (const name of BOTH_AGENTS) {
				const state = status.processes.find((entry) => entry.name === name);
				assert.equal(
					state.error,
					undefined,
					`the guard did not start ${name} under a logger with no .info: ${state.error}`
				);
				assert.ok(
					Number.isInteger(state.pid) && state.pid > 0,
					`no pid for ${name}, so the guard never reached its spawn: ${JSON.stringify(state)}`
				);
			}
			// guard() launches the reaper after the last spawn, so a throw in the loop leaves the agents with no reaper.
			assert.equal(
				status.reaper?.started,
				true,
				`no reaper launched: ${JSON.stringify(status.reaper)}`
			);
			// The guard's info lines land on warn, the one channel Harper's interface lets this component rely on.
			assert.ok(
				lines.some((line) => line.startsWith("warn process guard: started")),
				`the guard's start lines went nowhere; captured: ${JSON.stringify(lines)}`
			);
		} finally {
			for (const state of status?.processes ?? []) halt(state.pid);
			halt(lockedPid(pidDir, REAPER));
			await waitForLocksCleared(pidDir, BOTH_AGENTS);
		}
	});
});
