/**
 * Which repository a working directory belongs to, as one id that is the same for every clone and every person:
 * `github.com/acme/web` from the `origin` remote, whether it is an https, ssh or scp-style URL. Memory providers keep
 * one memory per repository (Brain: the `project` subject with this id).
 *
 * Credentials in a remote URL (`https://user:token@host/...`) never leave this module: the id has no user, password,
 * port, query or fragment. A directory without a git remote, or with a local path as its remote, has no id.
 */
import { execCommand } from "../exec.ts";

const MAX_ID_LENGTH = 200;
const ID_PATTERN = /^[a-z0-9.-]+(?:\/[a-z0-9._~-]+)+$/;

/** `github.com/acme/web` for a remote URL; undefined for a local path or anything that is not a host and a path. */
export function repositoryIdFromRemote(remote: string): string | undefined {
	const value = remote.trim();
	if (!value || /\s/.test(value)) return undefined;
	let host: string;
	let path: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return undefined;
		}
		if (url.protocol === "file:") return undefined;
		host = url.hostname;
		path = url.pathname;
	} else {
		// scp-like `[user@]host:path`; a Windows drive (`C:\…`, `C:/…`) or a plain path is local.
		const scp = /^(?:[^@/:\\]+@)?([^/:\\]{2,}):(?!\/\/)(.+)$/.exec(value);
		if (!scp) return undefined;
		host = scp[1]!;
		path = scp[2]!;
	}
	host = host.toLowerCase().replace(/^\[|\]$/g, "");
	const segments = path
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".")
		.map((segment) => segment.toLowerCase());
	if (segments.some((segment) => segment === "..")) return undefined;
	const last = segments.length - 1;
	if (last >= 0) segments[last] = segments[last]!.replace(/\.git$/, "");
	if (segments.length === 0 || segments[last] === "") return undefined;
	const id = `${host}/${segments.join("/")}`;
	if (id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) return undefined;
	return id;
}

/** The last part of a repository id, for labels: `web` for `github.com/acme/web`. */
export function repositoryShortName(id: string): string {
	return id.slice(id.lastIndexOf("/") + 1);
}

export type GitConfigReader = (cwd: string, key: string) => Promise<string | undefined>;

/** `git config --get <key>` in `cwd` (no shell, no hooks); undefined when git is missing or the key is not set. */
export const readGitConfig: GitConfigReader = async (cwd, key) => {
	try {
		const result = await execCommand("git", ["config", "--get", key], cwd, { timeout: 2_000, maxBuffer: 64 * 1024 });
		return result.code === 0 ? result.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
};

const cache = new Map<string, Promise<string | undefined>>();

async function lookup(cwd: string, read: GitConfigReader): Promise<string | undefined> {
	const remote = await read(cwd, "remote.origin.url");
	return remote ? repositoryIdFromRemote(remote) : undefined;
}

/** The repository id of `cwd` (its `origin` remote), cached per directory for the life of the process. */
export function projectRepository(cwd: string, read: GitConfigReader = readGitConfig): Promise<string | undefined> {
	if (read !== readGitConfig) return lookup(cwd, read);
	let pending = cache.get(cwd);
	if (!pending) {
		pending = lookup(cwd, read);
		cache.set(cwd, pending);
	}
	return pending;
}
