// A soak-only component: it says which worker answered and, asked by slot, ends that worker so Harper replaces it.
import { threadId, workerData } from "node:worker_threads";

const Base = Resource ?? class {};

export class SoakChaos extends Base {
	/** @param {{ id?: unknown } | undefined} target */
	static async get(target) {
		const slot = workerData?.workerIndex ?? null;
		const asked = /^exit-(\d+)$/.exec(String(target?.id ?? ""));
		const exiting = asked !== null && Number(asked[1]) === slot;
		// Late enough for this answer to leave first.
		if (exiting) setTimeout(endThisWorker, 200);
		return {
			threadId,
			workerIndex: slot,
			workerCount: workerData?.workerCount ?? null,
			restartNumber: workerData?.restartNumber ?? null,
			exiting,
		};
	}
}

function endThisWorker() {
	// Harper turns process.exit into a no-op in workers and keeps the real one as _realExit.
	const realExit = /** @type {any} */ (process)._realExit;
	if (typeof realExit === "function") realExit(1);
	throw new Error("soak chaos: ending this worker");
}
