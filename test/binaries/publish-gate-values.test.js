// The publish gate's table, checked against what the real built binaries carry.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, withRealBinaries } from "../support/component.js";

// The gate's own reader, not a copy: a parser that drifted from the one the release runs would let this pass
// while the release still refuses.
const { binariesFor, recordedBuildTags } = await import(
	pathToFileURL(path.join(REPO_ROOT, "agent-build", "binaries.js")).href
);
const { currentTarget } = await import(
	pathToFileURL(path.join(REPO_ROOT, "agent-build", "toolchain.js")).href
);

const binaryFor = (files, shipsAs) =>
	fs.readFileSync(
		files.find((file) => path.basename(file).startsWith(shipsAs))
	);

test("every requiredSymbol the gate demands is in the binary mandatoryArgs produces", async () => {
	await withRealBinaries((files) => {
		// binariesFor, not BINARIES: macOS builds no security-agent, and asking for one fails on an undefined path.
		for (const binary of binariesFor(currentTarget())) {
			assert.ok(
				binaryFor(files, binary.shipsAs).includes(
					Buffer.from(binary.requiredSymbol, "latin1")
				),
				`${binary.shipsAs} was built exactly as mandatoryArgs specifies and does not carry "${binary.requiredSymbol}", so the publish gate refuses the build it exists to approve`
			);
		}
	});
});

test("no forbiddenBuildTag the gate refuses is in the tag set the build records", async () => {
	await withRealBinaries((files) => {
		for (const binary of binariesFor(currentTarget()).filter(
			(entry) => entry.forbiddenBuildTag
		)) {
			const tags = recordedBuildTags(binaryFor(files, binary.shipsAs));
			assert.notEqual(
				tags,
				null,
				`${binary.shipsAs} carries no Go build-tag record at all, so the gate refuses every build of it`
			);
			assert.equal(
				tags.includes(binary.forbiddenBuildTag),
				false,
				`${binary.shipsAs} was built with --build-exclude and still records the "${binary.forbiddenBuildTag}" tag, so either the exclusion does not work or the gate refuses the build it exists to approve`
			);
		}
	});
});
