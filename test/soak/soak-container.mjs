/*
 * What a recreate replays, apart from soak.mjs so it has tests. Replaying the wrong mounts brings Harper up on
 * a fresh empty volume with no component in it, so the root mount is checked.
 */

/** Names the docker client reads from its own environment, so they go by value rather than redirect the client. */
const CLIENT_READS = /^(HOME|DOCKER_\w*)$/;

/**
 * The `docker run` that recreates a container from its `docker inspect` object. A variable goes by name with its
 * value in `env`, because a failed command's error opens with its argv and a name cannot say which value is secret.
 *
 * @param {any} inspect @param {string} name @param {string} image
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function runSpec(inspect, name, image) {
	const host = inspect.HostConfig ?? {};
	const args = ["run", "-d", "--name", name];
	/** @type {Record<string, string>} */
	const env = {};
	if (inspect.Config?.User) args.push("--user", inspect.Config.User);
	for (const entry of inspect.Config?.Env ?? []) {
		const [key] = entry.split("=", 1);
		// PATH is the image's own and docker sets it.
		if (key === "PATH") continue;
		if (CLIENT_READS.test(key)) {
			args.push("-e", entry);
			continue;
		}
		args.push("-e", key);
		env[key] = entry.slice(key.length + 1);
	}
	args.push(...mountArgs(host));
	for (const [port, bindings] of Object.entries(host.PortBindings ?? {}))
		for (const b of bindings ?? [])
			args.push("-p", `${b.HostPort}:${port.split("/")[0]}`);
	for (const cap of host.CapAdd ?? []) args.push("--cap-add", cap);
	if (host.Privileged) args.push("--privileged");
	args.push(inspect.Config?.Image ?? image, ...(inspect.Config?.Cmd ?? []));
	return { args, env };
}

/**
 * The same spec carrying `apiKey`, changed in `env` alone so the action changes the key and nothing else.
 *
 * @param {{ args: string[], env: Record<string, string> }} spec @param {string} apiKey
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export const withApiKey = (spec, apiKey) => ({
	args: spec.args,
	env: { ...spec.env, DD_API_KEY: apiKey },
});

/**
 * The recreate's `docker run`. Docker drops a variable named by `-e` that the client's environment lacks.
 *
 * @param {(file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<unknown>} exec
 * @param {{ args: string[], env: Record<string, string> }} spec @param {string} apiKey
 * @param {NodeJS.ProcessEnv} [base] what the client inherits besides the spec's variables
 */
export function runRecreate(exec, spec, apiKey, base = process.env) {
	const { args, env } = withApiKey(spec, apiKey);
	return exec("docker", args, { env: { ...base, ...env } });
}

/**
 * Every mount in a container's HostConfig as `-v` arguments: docker records `-v` in `Binds` and `--mount` in
 * `Mounts`, and reading only `Binds` drops the volume for the second kind.
 *
 * @param {{Binds?: string[] | null, Mounts?: Array<{Type?: string, Source?: string, Name?: string, Target?: string, ReadOnly?: boolean}> | null}} hostConfig
 * @returns {string[]} flat ["-v", spec, "-v", spec, ...]
 */
export function mountArgs(hostConfig) {
	const specs = [...(hostConfig?.Binds ?? [])];
	for (const m of hostConfig?.Mounts ?? []) {
		const source = m.Source || m.Name;
		if (!source || !m.Target) continue;
		const spec = `${source}:${m.Target}${m.ReadOnly ? ":ro" : ""}`;
		if (
			!specs.some((s) => s === spec || s.startsWith(`${source}:${m.Target}:`))
		)
			specs.push(spec);
	}
	return specs.flatMap((spec) => ["-v", spec]);
}

/**
 * Whether `args` mounts something at `path`. The destination is the second colon-separated field, so a source
 * that merely contains the path does not count: `/home/harperdb/harper:/elsewhere` mounts nothing at it.
 *
 * @param {readonly string[]} args @param {string} path
 */
export function mountsPath(args, path) {
	return args.some(
		(arg, i) =>
			args[i - 1] === "-v" &&
			typeof arg === "string" &&
			arg.split(":")[1] === path
	);
}
