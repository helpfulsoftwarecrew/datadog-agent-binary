// withBuiltBinaries writes stubs at the same paths `npm run build-agent` puts the real agents, so what it
// does with what was there decides whether running this suite destroys a developer's build.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
	acquireResolveBinaryLock,
	builtBinaryPaths,
	hideFiles,
	plantBuiltBinaries,
	stub,
	STAYS_UP,
	UNEXECUTABLE,
} from "../support/component.js";
import { withTempDir } from "../support/sandbox.js";

const HIDDEN = ".hidden-by-fixture";
const SAVED = ".saved-by-test";

/** Identity that survives a rename and not a rewrite, so a restored file is told from a recreated one. */
const identity = (file) => {
	const { ino, size, mode } = fs.statSync(file);
	return { ino, size, mode };
};

const writeExecutable = (file, body) => {
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
};

test("hideFiles gives back the same file, not a copy of it", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");
		writeExecutable(file, stub("exit 0"));
		const before = identity(file);

		const restore = hideFiles([file]);
		assert.ok(
			!fs.existsSync(file),
			"the path was not cleared, so a caller writing a stub would overwrite the original"
		);
		writeExecutable(file, stub(STAYS_UP));
		restore();

		assert.deepEqual(
			identity(file),
			before,
			"the file came back rewritten rather than renamed, which loses the mode and rewrites 139MB"
		);
	}));

test("hideFiles leaves a path that held nothing holding nothing", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");

		const restore = hideFiles([file]);
		writeExecutable(file, stub(STAYS_UP));
		restore();

		assert.ok(
			!fs.existsSync(file),
			"a stub was left behind at a path that started empty"
		);
	}));

test("NEGATIVE: a build stranded by an interrupted run comes back on the next hide-and-restore", () =>
	withTempDir("hide-files-", async (dir) => {
		const file = path.join(dir, "agent");
		// What a killed run leaves: renamed aside, never restored, the real path empty; only the restore puts it back.
		writeExecutable(`${file}${HIDDEN}`, stub("exit 0"));
		const stranded = identity(`${file}${HIDDEN}`);

		const restore = hideFiles([file]);
		restore();

		assert.deepEqual(
			identity(file),
			stranded,
			"the stranded build was not recovered to its real path"
		);
		assert.ok(
			!fs.existsSync(`${file}${HIDDEN}`),
			"the hidden copy was left behind to strand the next run too"
		);
	}));

test("NEGATIVE: a run killed holding its stub does not cost the build stashed beside it", () =>
	withTempDir("hide-files-", async (dir) => {
		// Killed after the stub was written: the real path holds the stub and the build sits at the hidden copy.
		const file = path.join(dir, "agent");
		writeExecutable(
			`${file}${HIDDEN}`,
			"#!/bin/sh\n# the real build\nexit 0\n"
		);
		const real = identity(`${file}${HIDDEN}`);
		writeExecutable(file, stub(STAYS_UP));

		const restore = hideFiles([file]);
		writeExecutable(file, stub(STAYS_UP));
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"the stub was hidden over the real build, which is now gone with nothing naming it"
		);
	}));

test("NEGATIVE: a run killed holding a broken stand-in costs no more than one holding a stub", () =>
	withTempDir("hide-files-", async (dir) => {
		// supervisor-start.test.js overwrites a planted stub to fail a spawn, so this body is not one stub() wrote.
		const file = path.join(dir, "agent");
		writeExecutable(
			`${file}${HIDDEN}`,
			"#!/bin/sh\n# the real build\nexit 0\n"
		);
		const real = identity(`${file}${HIDDEN}`);
		writeExecutable(file, UNEXECUTABLE);

		const restore = hideFiles([file]);
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"a stand-in the fixture wrote was hidden over the real build, which is now gone"
		);
	}));

test("NEGATIVE: hideFiles does not promote a leftover copy over a file that is already there", () =>
	withTempDir("hide-files-", async (dir) => {
		// Something at the real path and a leftover beside it: preferring the leftover would overwrite a real build.
		const file = path.join(dir, "agent");
		writeExecutable(file, "#!/bin/sh\n# the real one\nexit 0\n");
		const real = identity(file);
		writeExecutable(`${file}${HIDDEN}`, "#!/bin/sh\n# a leftover\nexit 7\n");

		const restore = hideFiles([file]);
		restore();

		assert.deepEqual(
			identity(file),
			real,
			"a leftover copy displaced the file that was actually there"
		);
	}));

/**
 * Everything the fixture reads at `files` renamed out of the two names it knows, and the put-back.
 */
function saveAside(files) {
	const owned = files.flatMap((file) => [file, `${file}${HIDDEN}`]);
	for (const file of owned) {
		if (fs.existsSync(file)) fs.renameSync(file, `${file}${SAVED}`);
	}
	return () =>
		owned.forEach((file) => {
			fs.rmSync(file, { force: true });
			if (fs.existsSync(`${file}${SAVED}`)) {
				fs.renameSync(`${file}${SAVED}`, file);
			}
		});
}

test("the built-binaries fixture puts back what it found at build/<platform>/bin", async () => {
	// saveAside moves the real agents out of reach, and the stand-ins are what a fixture without its hide destroys.
	const { binDir, files } = builtBinaryPaths();
	fs.mkdirSync(binDir, { recursive: true });
	// Held across the staging too: resolveBinary reads these paths, and harper-component.test.js holds this lock.
	const release = await acquireResolveBinaryLock();
	let restoreReal;
	try {
		restoreReal = saveAside(files);
		for (const file of files) writeExecutable(file, stub("exit 0"));
		const before = files.map(identity);

		const seen = await plantBuiltBinaries(
			async (stubs) => stubs.map((file) => fs.readFileSync(file, "utf8")),
			STAYS_UP
		);
		// Without this the fixture could hand back what was already there, and the survival below would prove nothing.
		for (const body of seen) {
			assert.equal(
				body,
				stub(STAYS_UP),
				"the fixture did not write its own stub"
			);
		}

		files.forEach((file, index) => {
			assert.ok(
				fs.existsSync(file),
				`${path.basename(file)} was deleted by the fixture instead of put back`
			);
			assert.deepEqual(
				identity(file),
				before[index],
				`${path.basename(file)} came back as a different file, so a real build would have been lost`
			);
		});
	} finally {
		restoreReal?.();
		release();
	}
});
