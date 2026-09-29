// A recreate replays the live container's run configuration. Without the root mount docker satisfies the
// image's VOLUME with a fresh anonymous one, and Harper comes up with an empty components/ directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	mountArgs,
	mountsPath,
	runRecreate,
	runSpec,
	withApiKey,
} from "../../test/soak/soak-container.mjs";

const ROOT = "/home/harperdb/harper";

const OLD_KEY = "stand-in-api-key-the-container-had";
const NEW_KEY = "stand-in-api-key-a-chaos-action-sets";
const PASSWORD = "stand-in-admin-password";

// The soak's container as `docker inspect` reports it, a key and a password among its variables.
const INSPECT = {
	Config: {
		User: "harperdb",
		Env: [
			"PATH=/usr/local/bin:/usr/bin",
			`DD_API_KEY=${OLD_KEY}`,
			`HDB_ADMIN_PASSWORD=${PASSWORD}`,
			"DD_TAGS=role=soak",
			"HOME=/home/harperdb",
		],
		Image: "harperfast/harper:5.2.9",
		Cmd: null,
	},
	HostConfig: {
		Binds: [`harper-demo-vol:${ROOT}`],
		Mounts: [],
		PortBindings: { "9926/tcp": [{ HostIp: "", HostPort: "9926" }] },
		CapAdd: ["SYS_ADMIN"],
		Privileged: false,
	},
};

test("a recreate names each variable in argv and carries its value in the environment", () => {
	const spec = runSpec(INSPECT, "harper-demo", "fallback:image");
	assert.deepEqual(spec.args, [
		"run",
		"-d",
		"--name",
		"harper-demo",
		"--user",
		"harperdb",
		"-e",
		"DD_API_KEY",
		"-e",
		"HDB_ADMIN_PASSWORD",
		"-e",
		"DD_TAGS",
		"-e",
		"HOME=/home/harperdb",
		"-v",
		`harper-demo-vol:${ROOT}`,
		"-p",
		"9926:9926",
		"--cap-add",
		"SYS_ADMIN",
		"harperfast/harper:5.2.9",
	]);
	assert.deepEqual(
		spec.env,
		{
			DD_API_KEY: OLD_KEY,
			HDB_ADMIN_PASSWORD: PASSWORD,
			DD_TAGS: "role=soak",
		},
		"HOME stays in argv, since in the environment it would move the docker client's own config"
	);
});

test("NEGATIVE: the argv a key-swapping recreate runs holds no secret value", () => {
	const spec = runSpec(INSPECT, "harper-demo", "fallback:image");
	const { args, env } = withApiKey(spec, NEW_KEY);
	for (const secret of [OLD_KEY, NEW_KEY, PASSWORD])
		assert.deepEqual(
			args.filter((arg) => arg.includes(secret)),
			[],
			"a failed execFile opens its error with argv, so a value here is a value in the log"
		);
	assert.deepEqual(args, spec.args, "the key moves in the environment alone");
	assert.equal(env.DD_API_KEY, NEW_KEY);
	assert.equal(env.HDB_ADMIN_PASSWORD, PASSWORD);
});

test("a recreate runs docker with the spec's argv and its variables, the new key winning, in the client's environment", async () => {
	const spec = runSpec(INSPECT, "harper-demo", "fallback:image");
	const calls = [];
	await runRecreate(
		async (file, args, options) => {
			calls.push({ file, args, options });
		},
		spec,
		NEW_KEY,
		{
			PATH: "/usr/bin",
			DOCKER_HOST: "unix:///stand-in.sock",
			DD_API_KEY: OLD_KEY,
		}
	);
	assert.equal(calls.length, 1);
	const [{ file, args, options }] = calls;
	assert.equal(file, "docker");
	assert.deepEqual(args, spec.args);
	assert.deepEqual(
		options?.env,
		{
			PATH: "/usr/bin",
			DOCKER_HOST: "unix:///stand-in.sock",
			DD_API_KEY: NEW_KEY,
			HDB_ADMIN_PASSWORD: PASSWORD,
			DD_TAGS: "role=soak",
		},
		"docker drops a variable -e names that the client's environment lacks"
	);
	for (const secret of [OLD_KEY, NEW_KEY, PASSWORD])
		assert.deepEqual(
			args.filter((arg) => arg.includes(secret)),
			[]
		);
});

// A string that carries the key, by template or by concatenation, in either order.
const SPLICE = [
	/["'`][^"'`\n]*DD_API_KEY=/,
	/\$\{[^}]*\b(?:apiKey|realApiKey\(\))/,
	/\+\s*(?:apiKey|realApiKey\(\))/,
	/\b(?:apiKey|realApiKey\(\))\s*\+/,
];
const splices = (source) => SPLICE.some((pattern) => pattern.test(source));

test("NEGATIVE: soak.mjs splices no key into a string, by template or by concatenation", () => {
	for (const form of [
		"`DD_API_KEY=${apiKey}`",
		'"-e", "DD_API_KEY=" + apiKey',
		"'DD_API_KEY=' + realApiKey()",
		'"DD_API_KEY=".concat(apiKey)',
		"`--env=${realApiKey()}`",
		"apiKey + suffix",
	])
		assert.equal(splices(form), true, `the check misses ${form}`);
	assert.equal(splices('"DD-API-KEY": apiKey,'), false);
	const source = readFileSync(
		new URL("../soak/soak.mjs", import.meta.url),
		"utf8"
	);
	assert.equal(
		splices(source),
		false,
		"a key spliced into a string is a key in argv"
	);
	assert.equal(
		/runRecreate\(run, containerSpec, apiKey\)/.test(source),
		true,
		"the recreate must go through runRecreate, whose argv and environment the test above checks"
	);
});

// A container created with -v: all three land in Binds, and Mounts is empty.
const VIA_V = {
	Binds: [
		`harper-demo-vol:${ROOT}`,
		"/sys/kernel/debug:/sys/kernel/debug",
		"/sys/kernel/tracing:/sys/kernel/tracing",
	],
	Mounts: [],
};

test("a container created with -v replays every mount it has", () => {
	assert.deepEqual(mountArgs(VIA_V), [
		"-v",
		`harper-demo-vol:${ROOT}`,
		"-v",
		"/sys/kernel/debug:/sys/kernel/debug",
		"-v",
		"/sys/kernel/tracing:/sys/kernel/tracing",
	]);
	assert.equal(mountsPath(mountArgs(VIA_V), ROOT), true);
});

// --mount records in Mounts and leaves Binds null, so reading only Binds gives a spec with no -v at all.
test("a container created with --mount replays its volume too, not an empty list", () => {
	const viaMount = {
		Binds: null,
		Mounts: [
			{ Type: "volume", Name: "harper-demo-vol", Target: ROOT },
			{
				Type: "bind",
				Source: "/sys/kernel/debug",
				Target: "/sys/kernel/debug",
			},
		],
	};
	const args = mountArgs(viaMount);
	assert.deepEqual(args, [
		"-v",
		`harper-demo-vol:${ROOT}`,
		"-v",
		"/sys/kernel/debug:/sys/kernel/debug",
	]);
	assert.equal(
		mountsPath(args, ROOT),
		true,
		"this is the spec that used to carry no -v at all"
	);
});

test("a read-only mount keeps its flag, and a mount named twice is replayed once", () => {
	assert.deepEqual(
		mountArgs({
			Binds: [],
			Mounts: [{ Type: "bind", Source: "/a", Target: "/b", ReadOnly: true }],
		}),
		["-v", "/a:/b:ro"]
	);
	assert.deepEqual(
		mountArgs({
			Binds: [`harper-demo-vol:${ROOT}`],
			Mounts: [{ Type: "volume", Name: "harper-demo-vol", Target: ROOT }],
		}),
		["-v", `harper-demo-vol:${ROOT}`],
		"Binds and Mounts describing the same mount must not produce it twice"
	);
});

test("NEGATIVE: a spec with no mount at the root is refused rather than recreated", () => {
	assert.equal(
		mountsPath(mountArgs({ Binds: null, Mounts: null }), ROOT),
		false
	);
	assert.equal(mountsPath(mountArgs({ Binds: [], Mounts: [] }), ROOT), false);
	assert.equal(
		mountsPath(
			["run", "-d", "--name", "harper-demo", "harperfast/harper:5.2.9"],
			ROOT
		),
		false,
		"the exact shape that boots Harper on a fresh anonymous volume"
	);
});

// The destination is the second field. A source path that happens to contain the root is not a mount at it.
test("NEGATIVE: the root is matched as a destination, not anywhere in the string", () => {
	assert.equal(mountsPath(["-v", `${ROOT}:/elsewhere`], ROOT), false);
	assert.equal(mountsPath(["-v", `/backup${ROOT}:/other`], ROOT), false);
	assert.equal(mountsPath(["-v", `vol:${ROOT}-old`], ROOT), false);
	assert.equal(mountsPath(["-v", `vol:${ROOT}`], ROOT), true);
	assert.equal(
		mountsPath(["-v", `vol:${ROOT}:ro`], ROOT),
		true,
		"a read-only root is still the root"
	);
});

// `-v` is a flag, so the value only counts in that position. A bare argument that looks like a mount is not one.
test("NEGATIVE: only a value that follows -v counts", () => {
	assert.equal(mountsPath([`vol:${ROOT}`], ROOT), false);
	assert.equal(mountsPath(["-e", `vol:${ROOT}`], ROOT), false);
});
