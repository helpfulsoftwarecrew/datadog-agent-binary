// Whether the release workflow builds is a runner's answer, not this file's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO_ROOT } from "../support/repo.js";

const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const WORKFLOW = readFileSync(join(WORKFLOW_DIR, "build-release.yml"), "utf8");
const KIT_REPO = "https://github.com/helpfulsoftwarecrew/harper-binary-kit.git";
const matches = (pattern) => [...WORKFLOW.matchAll(pattern)].length;

/** Every `run:` block body in `text`, keyed by nothing but its own indentation. */
function scriptBodies(text) {
	const bodies = [];
	let indent = null;
	for (const line of text.split("\n")) {
		if (indent !== null) {
			const width = line.search(/\S/);
			if (width === -1 || width > indent) {
				bodies[bodies.length - 1].push(line);
				continue;
			}
			indent = null;
		}
		const opened = /^(\s*)run:\s*[|>]/.exec(line);
		if (opened) {
			indent = opened[1].length;
			bodies.push([]);
		}
	}
	return bodies.map((lines) => lines.join("\n"));
}

// `7.0.0 ; touch pwned ; #` as a dispatch input is shell source once it is spliced through ${{ }}, and the
// step output carries the same string back out, so both have to arrive as an env value.
test("no attacker-controlled value is spliced into a workflow script body", () => {
	const bodies = readdirSync(WORKFLOW_DIR).flatMap((file) =>
		scriptBodies(readFileSync(join(WORKFLOW_DIR, file), "utf8"))
	);
	assert.ok(
		bodies.length > 3,
		"found almost no run: blocks; the workflow shape changed and this check is blind"
	);
	// ref_name too: git permits ; $() ` && and | in a tag name, so a tag is attacker-controlled text.
	const spliced = bodies.filter((body) =>
		/\$\{\{[^}]*(github\.event\.inputs|steps\.\w+\.outputs|github\.ref_name)/.test(
			body
		)
	);
	assert.deepEqual(spliced, []);

	assert.match(
		WORKFLOW,
		/DATADOG_VERSION: \$\{\{ github\.event\.inputs\.datadog_version \}\}/
	);
	assert.match(WORKFLOW, /REF_NAME: \$\{\{ github\.ref_name \}\}/);
});

// bash is on windows-latest too, so one step covers every leg; two spellings of one job drift apart.
test("version extraction and the build are each written once, not once per runner OS", () => {
	assert.equal(matches(/^\s+- name: Extract version from tag$/gm), 1);
	assert.equal(matches(/^\s+- name: Build \$\{\{ matrix\.platform \}\}$/gm), 1);
	assert.equal(matches(/^\s+id: extract_version$/gm), 1);
	assert.equal(matches(/shell: pwsh$/gm), 0);
});

// The tag's version is the package version and reaches only the publish job.
test("publish consumes prepare's version; the build never sees it", () => {
	const build = WORKFLOW.slice(
		WORKFLOW.indexOf("- name: Build ${{ matrix.platform }}"),
		WORKFLOW.indexOf("- name: Smoke test")
	);
	assert.ok(build.length > 0, "the build step was not found");
	assert.doesNotMatch(build, /needs\.prepare|github\.ref/);
	assert.match(build, /--datadog-version "\$DATADOG_VERSION"/);
	assert.match(
		WORKFLOW,
		/version: \$\{\{ needs\.prepare\.outputs\.version \}\}/
	);
});

// A repository that requires SHA-pinned actions refuses a workflow that names one by tag, and every leg dies at
// job setup. A tag is also mutable; a SHA is what was reviewed.
test("every action is pinned to a commit SHA", () => {
	const unpinned = [];
	for (const file of readdirSync(WORKFLOW_DIR)) {
		const text = readFileSync(join(WORKFLOW_DIR, file), "utf8");
		for (const [, ref] of text.matchAll(/uses:\s*(\S+)/g)) {
			if (ref.includes("/.github/workflows/")) continue;
			if (!/@[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$/.test(ref))
				unpinned.push(`${file}: ${ref}`);
		}
	}
	assert.deepEqual(unpinned, []);
});

// Publishing is the kit's, and the one thing the caller still passes is the target list. It has to be the
// same list binary-kit.config.js declares, or the matrix builds one set and the release publishes another.
test("the publish job calls the kit and passes the targets the config declares", async () => {
	const { default: config } = await import("../../binary-kit.config.js");
	const call =
		/uses: helpfulsoftwarecrew\/harper-binary-kit\/\.github\/workflows\/release\.yml@(\S+)/.exec(
			WORKFLOW
		);
	assert.ok(
		call,
		"the release no longer calls the kit, so the publish shape is back in this repo"
	);
	// A ref that does not exist makes GitHub reject the whole file at trigger time, with no job to read why.
	const refs = execFileSync("git", ["ls-remote", "--tags", KIT_REPO], {
		encoding: "utf8",
	});
	assert.ok(
		refs.includes(`refs/tags/${call[1]}`),
		`the workflow calls the kit at ${call[1]}, which is not a tag on ${KIT_REPO}: ${refs}`
	);
	const passed = /targets: '(\[[^']*\])'/.exec(WORKFLOW)?.[1];
	assert.ok(passed, `the publish job passes no target list: ${WORKFLOW}`);
	assert.deepEqual(JSON.parse(passed).sort(), [...config.targets].sort());
});

// The artifacts the build uploads are what the kit's release workflow downloads. Named differently, the
// staging finds no build tree and refuses every package, which is a whole release cycle to discover.
test("the artifact names are the ones the kit reads back", () => {
	assert.match(WORKFLOW, /name: bin-\$\{\{ matrix\.platform \}\}/);
	assert.match(WORKFLOW, /name: share-\$\{\{ matrix\.platform \}\}/);
});

/** The prepare job's version step, run the way the runner runs it, with an output file to read back. */
function extractVersion(ref) {
	const body = scriptBodies(WORKFLOW).find((script) =>
		script.includes('"$GITHUB_REF" == refs/tags/v*')
	);
	assert.ok(body, "the version extraction step was not found");
	const dir = mkdtempSync(join(tmpdir(), "extract-version-"));
	const output = join(dir, "output");
	writeFileSync(output, "");
	try {
		const stdout = execFileSync("bash", ["-c", body], {
			encoding: "utf8",
			env: { ...process.env, GITHUB_REF: ref, GITHUB_OUTPUT: output },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, output: readFileSync(output, "utf8") };
	} catch (caught) {
		const error = /** @type {{ status: number, stdout: string }} */ (caught);
		return { status: error.status, stdout: String(error.stdout), output: "" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// No prerelease is published, and stopping in prepare spares four agent builds and a GitHub release.
test("NEGATIVE: a prerelease tag stops the release in prepare, with the reason", (t) => {
	if (process.platform === "win32")
		return t.skip(
			"bash on a Windows runner can be WSL's, which has no distribution"
		);
	for (const ref of [
		"refs/tags/v8.0.1-beta.1",
		"refs/tags/v9.0.0-rc.1",
		"refs/tags/v8.0.1-0",
	]) {
		const { status, stdout, output } = extractVersion(ref);
		assert.equal(status, 1, `${ref} was not refused`);
		assert.match(stdout, /::error::Version \S+ is a prerelease/);
		assert.equal(output, "", `${ref} still handed the publish job a version`);
	}
	assert.equal(extractVersion("refs/tags/v8.0.1").output, "version=8.0.1\n");
	assert.doesNotMatch(
		WORKFLOW,
		/prerelease:/,
		"the GitHub release still has a prerelease switch"
	);
});
