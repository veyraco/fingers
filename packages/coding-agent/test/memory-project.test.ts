/**
 * The repository id memory providers key on (F20): the same id for every clone and remote style, and nothing of a
 * credential in a remote URL ever in it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { projectRepository, repositoryIdFromRemote, repositoryShortName } from "../src/core/memory/project.ts";

describe("repositoryIdFromRemote", () => {
	it("gives one id for https, ssh and scp-style remotes", () => {
		for (const remote of [
			"https://github.com/Acme/Web.git",
			"https://github.com/acme/web",
			"https://github.com/acme/web/",
			"git@github.com:acme/web.git",
			"ssh://git@github.com/acme/web.git",
			"ssh://git@github.com:22/acme/web",
			"git://github.com/acme/web.git",
		]) {
			expect(repositoryIdFromRemote(remote), remote).toBe("github.com/acme/web");
		}
		expect(repositoryIdFromRemote("https://gitlab.example.com/group/sub/project.git")).toBe(
			"gitlab.example.com/group/sub/project",
		);
	});

	it("keeps no user, token, port, query or fragment", () => {
		const id = repositoryIdFromRemote(
			"https://x-access-token:ghs_SECRETtoken123@github.com:8443/acme/web.git?ref=1#x",
		);
		expect(id).toBe("github.com/acme/web");
		expect(repositoryIdFromRemote("https://oauth2:glpat-SECRET@gitlab.com/acme/web.git")).toBe("gitlab.com/acme/web");
	});

	it("has no id for local paths, file URLs and malformed remotes", () => {
		for (const remote of [
			"",
			"/srv/git/web.git",
			"../web",
			"./web.git",
			"file:///srv/git/web.git",
			"C:\\repos\\web",
			"C:/repos/web",
			"https://github.com",
			"https://github.com/",
			"git@github.com:acme/../web",
			"git@github.com:",
			"has space@github.com:acme/web",
			`https://github.com/acme/${"a".repeat(300)}`,
		]) {
			expect(repositoryIdFromRemote(remote), remote).toBeUndefined();
		}
	});

	it("names the repository by its last part", () => {
		expect(repositoryShortName("github.com/acme/web")).toBe("web");
	});
});

describe("projectRepository", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reads the origin remote of a git directory, and nothing outside one", async () => {
		const repo = mkdtempSync(join(tmpdir(), "fingers-memory-repo-"));
		const plain = mkdtempSync(join(tmpdir(), "fingers-memory-plain-"));
		dirs.push(repo, plain);
		await execCommand("git", ["init", "-q"], repo);
		await execCommand("git", ["remote", "add", "origin", "https://user:pass@github.com/acme/web.git"], repo);
		expect(await projectRepository(repo)).toBe("github.com/acme/web");
		expect(await projectRepository(plain)).toBeUndefined();
	});

	it("uses the reader it is given", async () => {
		const read = async (_cwd: string, key: string) =>
			key === "remote.origin.url" ? "git@github.com:a/b.git" : undefined;
		expect(await projectRepository("/anywhere", read)).toBe("github.com/a/b");
		expect(await projectRepository("/anywhere", async () => undefined)).toBeUndefined();
	});
});
