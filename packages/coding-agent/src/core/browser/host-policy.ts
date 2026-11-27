/**
 * Which hosts the browser tool may reach (Fingers RPC v1 `configure.network`).
 *
 * `open` has no host filter of its own; `allow_list` allows only the listed hosts. A host is `name`,
 * `*.domain` (its subdomains, not the domain itself) or `[ipv6]`, with an optional `:port`; without a
 * port it allows 80 and 443. Link-local addresses (169.254.0.0/16, fe80::/10, where cloud metadata
 * services listen) and unspecified addresses are blocked in every mode, also when an allowed name
 * resolves to one (the proxy checks the resolved addresses with `blockedAddressReason`).
 */
import { isIP } from "node:net";

export interface NetworkConfig {
	mode: "open" | "allow_list";
	hosts?: readonly string[];
}

type HostDecision = { allowed: true } | { allowed: false; reason: string };

interface HostRule {
	/** Lowercase host without brackets; for a wildcard, the domain after `*.`. */
	host: string;
	wildcard: boolean;
	/** Undefined: 80 and 443. */
	port?: number;
}

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Lowercase, no trailing dot, no IPv6 brackets. */
export function normalizeHost(host: string): string {
	let value = host.trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
	while (value.endsWith(".")) value = value.slice(0, -1);
	return value;
}

function parseRule(entry: string): HostRule {
	const text = entry.trim().toLowerCase();
	const bracketed = text.match(/^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/);
	const plain = bracketed ? null : text.match(/^([^:]+)(?::(\d{1,5}))?$/);
	const match = bracketed ?? plain;
	if (!match) throw new Error(`network.hosts: not a host: ${entry}`);
	let host = match[1];
	const port = match[2] === undefined ? undefined : Number(match[2]);
	if (port !== undefined && (port < 1 || port > 65535)) throw new Error(`network.hosts: bad port: ${entry}`);
	const wildcard = host.startsWith("*.");
	if (wildcard) host = host.slice(2);
	host = normalizeHost(host);
	if (!host || host.includes("*") || /[/\s@?#\\]/.test(host)) throw new Error(`network.hosts: not a host: ${entry}`);
	return { host, wildcard, port };
}

function ipv4Parts(address: string): number[] | undefined {
	if (isIP(address) !== 4) return undefined;
	return address.split(".").map(Number);
}

/** Expand an IPv6 address to its eight 16-bit groups; an embedded IPv4 tail becomes two groups. */
function ipv6Groups(address: string): number[] | undefined {
	if (isIP(address) !== 6) return undefined;
	let text = address.toLowerCase();
	const zone = text.indexOf("%");
	if (zone >= 0) text = text.slice(0, zone);
	const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const parts = v4[1].split(".").map(Number);
		const high = ((parts[0] << 8) | parts[1]).toString(16);
		const low = ((parts[2] << 8) | parts[3]).toString(16);
		text = `${text.slice(0, -v4[1].length)}${high}:${low}`;
	}
	const [head, tail] = text.split("::");
	const headGroups = head ? head.split(":") : [];
	const tailGroups = tail ? tail.split(":") : [];
	const fill = tail === undefined ? [] : Array<string>(8 - headGroups.length - tailGroups.length).fill("0");
	return [...headGroups, ...fill, ...tailGroups].map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address an IPv6 address carries (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible, NAT64). */
function embeddedIpv4(groups: number[]): number[] | undefined {
	const zeros = groups.slice(0, 5).every((g) => g === 0);
	const mapped = zeros && groups[5] === 0xffff;
	const compatible = zeros && groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1);
	const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
	if (!mapped && !compatible && !nat64) return undefined;
	return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function blockedIpv4(parts: number[]): string | undefined {
	if (parts[0] === 169 && parts[1] === 254) return "link-local address";
	if (parts[0] === 0) return "unspecified address";
	return undefined;
}

/**
 * Why an IP address may never be reached (link-local, where cloud metadata listens; unspecified), or
 * undefined. Names are not checked here: the proxy checks the addresses a name resolves to.
 */
export function blockedAddressReason(address: string): string | undefined {
	const host = normalizeHost(address);
	const v4 = ipv4Parts(host);
	if (v4) return blockedIpv4(v4);
	const groups = ipv6Groups(host);
	if (!groups) return undefined;
	const embedded = embeddedIpv4(groups);
	if (embedded) return blockedIpv4(embedded);
	if ((groups[0] & 0xffc0) === 0xfe80) return "link-local address";
	if (groups.every((g) => g === 0)) return "unspecified address";
	// AWS's IPv6 instance metadata endpoint (fd00:ec2::254) is not link-local.
	if (
		groups[0] === 0xfd00 &&
		groups[1] === 0x0ec2 &&
		groups.slice(2, 7).every((g) => g === 0) &&
		groups[7] === 0x254
	) {
		return "cloud metadata address";
	}
	return undefined;
}

/** Host names of cloud metadata services, blocked like their addresses. */
const METADATA_NAMES: ReadonlySet<string> = new Set(["metadata.google.internal", "metadata", "instance-data"]);

export class HostPolicy {
	readonly mode: NetworkConfig["mode"];
	private readonly rules: HostRule[];

	constructor(config: NetworkConfig | undefined) {
		this.mode = config?.mode ?? "open";
		if (this.mode !== "open" && this.mode !== "allow_list")
			throw new Error(`network.mode: unknown mode ${this.mode}`);
		this.rules = this.mode === "allow_list" ? (config?.hosts ?? []).map(parseRule) : [];
	}

	/** Whether a request to `host:port` may start (before name resolution). */
	check(host: string, port: number): HostDecision {
		const name = normalizeHost(host);
		if (!name) return { allowed: false, reason: "no host" };
		const blocked = blockedAddressReason(name);
		if (blocked) return { allowed: false, reason: blocked };
		if (METADATA_NAMES.has(name) || name.endsWith(".metadata.google.internal")) {
			return { allowed: false, reason: "cloud metadata host" };
		}
		if (this.mode === "open") return { allowed: true };
		const listed = this.rules.some((rule) => {
			const hostMatches = rule.wildcard ? name.endsWith(`.${rule.host}`) : name === rule.host;
			const portMatches = rule.port === undefined ? DEFAULT_PORTS.has(port) : rule.port === port;
			return hostMatches && portMatches;
		});
		return listed ? { allowed: true } : { allowed: false, reason: "not in the run's network allow list" };
	}
}
