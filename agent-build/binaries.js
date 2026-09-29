// @ts-check
/** @typedef {import("./toolchain.js").OS} OS */
/** @typedef {import("./toolchain.js").Target} Target */
/** @typedef {"build" | "release"} BinarySource */

/**
 * One binary this package ships. AGENTS.md says why each is built or lifted, and why the probe pair is opt-in.
 *
 * @typedef {object} AgentBinary
 * @property {string} shipsAs Name the binary ships under, before the platform's executable suffix.
 * @property {BinarySource} from `build` compiles the pinned source; `release` lifts it from Datadog's signed .deb.
 * @property {readonly OS[]} [buildOn] Systems that build this one whatever `from` says: the .deb covers Linux alone.
 * @property {boolean} [optional] Ships in the opt-in probe package. Separate from `from`, which is where bytes come from.
 * @property {string} task Invoke task that builds it. Meaningless for a `release` binary.
 * @property {string} builtAt Path under the source tree the task writes to, before the executable suffix.
 * @property {readonly string[]} mandatoryArgs Flags encoding a shipping constraint, always passed, never overridable.
 * @property {string} argsOverride Environment variable supplying extra flags, so CI can iterate without a code change.
 * @property {string} requiredSymbol Symbol the publish gate requires in the packed binary.
 * @property {string} [forbiddenBuildTag] Go build tag mandatoryArgs excludes; the publish gate refuses its presence.
 * @property {readonly OS[]} [onlyOn] Systems this binary exists on, absent meaning all; an inert one is not shipped.
 */

/**
 * Where one binary comes from on one system, which `buildOn` can override per system. @param {AgentBinary}
 * binary @param {Pick<Target, "os">} target @returns {BinarySource}
 */
export const sourceOf = (binary, target) =>
	binary.buildOn?.includes(target.os) ? "build" : binary.from;

/**
 * The binaries this package compiles for one system. @param {Pick<Target, "os">} target @returns {readonly
 * AgentBinary[]}
 */
export const builtFor = (target) =>
	binariesFor(target).filter((b) => sourceOf(b, target) === "build");

/**
 * The binaries this package lifts out of Datadog's signed release for one system. @param {Pick<Target, "os">}
 * target @returns {readonly AgentBinary[]}
 */
export const extractedFor = (target) =>
	binariesFor(target).filter((b) => sourceOf(b, target) === "release");

/**
 * The binaries the base package carries: what every install gets. @param {Pick<Target, "os">} target @returns
 * {readonly AgentBinary[]}
 */
export const baseBinaries = (target) =>
	binariesFor(target).filter((b) => !b.optional);

/**
 * The binaries the opt-in probe package carries, which an operator installs by name. @param {Pick<Target,
 * "os">} target @returns {readonly AgentBinary[]}
 */
export const probeBinaries = (target) =>
	binariesFor(target).filter((b) => b.optional);

/**
 * The binaries that exist for one system, which is not always all of them. @param {Pick<Target, "os">} target
 * @returns {readonly AgentBinary[]}
 */
export function binariesFor(target) {
	return BINARIES.filter((b) => !b.onlyOn || b.onlyOn.includes(target.os));
}

/** @type {readonly AgentBinary[]} */
export const BINARIES = [
	{
		shipsAs: "datadog-agent",
		from: "build",
		task: "agent.build",
		builtAt: "bin/agent/agent",
		// Python and rtloader cost every integration and the `system.processes.*` family, which runtime/series.js
		// produces from /proc instead. --no-enable-bazel because the default fills a 14 GB runner.
		mandatoryArgs: [
			// Only python: excluding systemd as well would cost the journald log source and the systemd integration.
			"--build-exclude=python",
			"--exclude-rtloader",
			"--no-enable-bazel",
		],
		argsOverride: "DD_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/aggregator",
		// Not a symbol: pkg/collector/python compiles either way (version_nopy.go is //go:build
		// !python), so its package path is in a correct build and only the tag set discriminates.
		forbiddenBuildTag: "python",
	},
	{
		shipsAs: "trace-agent",
		from: "build",
		task: "trace-agent.build",
		builtAt: "bin/trace-agent/trace-agent",
		// Empty: TRACE_AGENT_TAGS carries neither, and trace_agent.py::build() has no rtloader parameter, so
		// forwarding the core agent's excludes is rejected rather than ignored.
		mandatoryArgs: [],
		argsOverride: "DD_TRACE_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/pkg/trace/api.",
	},
	{
		shipsAs: "system-probe",
		from: "release",
		task: "system-probe.build",
		builtAt: "bin/system-probe/system-probe",
		// Static Go with eBPF, needing neither python nor rtloader. Without it the core agent's workloadmeta
		// collector asks a socket nothing serves once a minute.
		mandatoryArgs: [],
		argsOverride: "DD_SYSTEM_PROBE_BUILD_ARGS",
		optional: true,
		requiredSymbol: "datadog-agent/cmd/system-probe",
		// Every system, by three mechanisms: eBPF objects on Linux, tracer_darwin.go's packet capture on
		// macOS, and the ddnpm/ddprocmon drivers on Windows, which arrive in Datadog's MSI.
		buildOn: ["macos", "windows"],
	},
	{
		shipsAs: "process-agent",
		from: "release",
		task: "process-agent.build",
		builtAt: "bin/process-agent/process-agent",
		mandatoryArgs: [],
		argsOverride: "DD_PROCESS_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/cmd/process-agent",
		optional: true,
		// The shipper for what system-probe collects: net.go's IsEnabled() is false for every other flavor, so
		// without it the eBPF programs collect into a queue nothing drains.
		buildOn: ["macos", "windows"],
	},
	{
		shipsAs: "security-agent",
		from: "release",
		task: "security-agent.build",
		builtAt: "bin/security-agent/security-agent",
		// One argv entry, not two: security_agent.py takes build_tags as a positional, which invoke spells
		// `--build-tags=value`, and split in two it reads the second as another task name.
		mandatoryArgs: ["--build-tags=sysprobe_bundle"],
		argsOverride: "DD_SECURITY_AGENT_BUILD_ARGS",
		requiredSymbol: "datadog-agent/cmd/security-agent",
		// Runtime security is a Linux and Windows product; there is no macOS build of it to ship.
		onlyOn: ["linux", "windows"],
		// Lifted on Linux, built on Windows. Datadog ships the Windows one inside an MSI, and reading an MSI
		// is a second extraction format for a single binary; the build already works there.
		optional: true,
		buildOn: ["windows"],
	},
];

// Go writes the tag set it linked with into the binary's own build info as one comma-separated line, so
// the exclusion is read off the artifact instead of trusting the flag the build was asked to use.
const TAGS_LINE = Buffer.from("build\t-tags=", "latin1");

/**
 * The Go build tags recorded in a linked binary, or null when it carries no build-info record at all. @param
 * {Buffer} bytes @returns {string[] | null}
 */
export function recordedBuildTags(bytes) {
	const at = bytes.indexOf(TAGS_LINE);
	if (at === -1) return null;
	const from = at + TAGS_LINE.length;
	const end = bytes.indexOf(0x0a, from);
	return bytes
		.subarray(from, end === -1 ? bytes.length : end)
		.toString("latin1")
		.split(",");
}

/**
 * The name a binary is shipped and copied under for one target, e.g. `datadog-agent.exe`. @param {AgentBinary}
 * binary @param {Target} target @returns {string}
 */
export function binaryFilename(binary, target) {
	return `${binary.shipsAs}${target.exe}`;
}
