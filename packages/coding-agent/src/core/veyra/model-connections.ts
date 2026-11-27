/**
 * The organization's model connections in Fingers (canvas FingersTuiLogin "3 model connections from Connect",
 * FingersTuiFirstRun option 1, `/model`).
 *
 * A signed-in Fingers lists the connections Connect opens to it (`GET <api>/connect/v1/organizations/{org}/
 * model-connections?app=fingers&capability=chat`, Connect `models:read`) and offers each one as a provider of its own
 * (`veyra-<connection id>`) with the models of the connection's provider. Model calls go through Hands' model proxy
 * (hands.yaml "Model calls from the Fingers CLI"): the provider's base URL is
 * `<api>/hands/v1/model-proxy/{connection_id}/{wire}` and every call carries the person's Connect access token for
 * Hands as `Authorization: Bearer`. Hands leases the key from Connect and adds it server-side, so the key never
 * reaches this computer: Fingers holds no credential for these providers at all, only the short-lived Hands token
 * VeyraAuth keeps with the sign-in, and writes nothing to auth.json or models.json.
 *
 * A connection is offered only when Hands can relay it for Fingers: `apps` lists both `fingers` and `hands`, its
 * provider is one Hands' proxy speaks, its key was not rejected, and its `groups` (when set) name the person's group.
 * A subscription connection (`auth: subscription`, a sign-in instead of an API key) is offered only for Anthropic
 * (Claude Pro/Max), which Fingers then calls as a Claude subscription (connection-provider.ts). Hands relays every
 * other provider to its API-key endpoint, where a ChatGPT, SuperGrok or Kimi Code sign-in does not work, so those
 * subscriptions are listed as not offered until Hands relays them to their subscription backends.
 * Connect's `models:use` and Fingers' `cli:use` are decided by Hands on every call; a refusal comes back as a clear
 * error on that call (connection-provider.ts).
 */
import { connectText } from "./login-text.ts";
import { VeyraApiError } from "./oidc-client.ts";
import type { VeyraAccount } from "./session-vault.ts";

/** The API a connection speaks through Hands' proxy: the path segment after the connection id. */
export type ProxyWire = "anthropic" | "openai" | "google";

interface ProxyRoute {
	wire: ProxyWire;
	/** Fingers' built-in provider whose models and request code the connection uses. */
	fingersProvider: string;
	/** Shown when the connection's own name does not say it. */
	label: string;
	/**
	 * Whether a subscription sign-in of this provider works through Hands: Hands sends a Claude subscription's token
	 * to Anthropic's API (hands providers.ts upstreamAuthHeaders), but relays the others to API-key endpoints.
	 */
	subscription: boolean;
}

/**
 * Connect providers Hands' model proxy relays (hands server/src/model-proxy/providers.ts PROVIDER_ROUTES). Bedrock,
 * Vertex, Voyage and OpenAI-compatible endpoints are not offered yet: Hands does not proxy the first three, and Connect
 * lists no models for an OpenAI-compatible endpoint.
 */
export const PROXY_ROUTES: Readonly<Record<string, ProxyRoute>> = {
	anthropic: { wire: "anthropic", fingersProvider: "anthropic", label: "Anthropic", subscription: true },
	openai: { wire: "openai", fingersProvider: "openai", label: "OpenAI", subscription: false },
	google: { wire: "google", fingersProvider: "google", label: "Google Gemini", subscription: false },
	openrouter: { wire: "openai", fingersProvider: "openrouter", label: "OpenRouter", subscription: false },
	xai: { wire: "openai", fingersProvider: "xai", label: "xAI", subscription: false },
	kimi: { wire: "openai", fingersProvider: "moonshotai", label: "Moonshot Kimi", subscription: false },
};

/** A connection as Connect lists it (connect.yaml `ModelConnection`); key values are never returned. */
export interface ModelConnection {
	id: string;
	provider: string;
	/**
	 * How the connection holds the provider's credentials (Connect `auth`): `api_key`, or `subscription` for a
	 * subscription sign-in (Claude Pro/Max, ChatGPT, …). A list without it is read as `api_key`.
	 */
	auth: string;
	name: string;
	apps: string[];
	groups: string[];
	capabilities: string[];
	/** The model ids Connect's last test of the connection found (Connect `models`), empty when not tested. */
	models: string[];
	status?: string;
	keyHint?: string;
}

type NotOfferedReason =
	| "not_for_fingers"
	| "not_for_hands"
	| "provider"
	| "subscription"
	| "key_rejected"
	| "group"
	| "chat";

export interface OfferedConnection {
	connection: ModelConnection;
	route: ProxyRoute;
	/** The Fingers provider id of this connection: `veyra-<connection id>`. */
	providerId: string;
	/** The provider's name in `/model`, made safe to print. */
	displayName: string;
}

export interface ModelConnectionsList {
	/** The organization the list is for (`org_...`). */
	org: string;
	offered: OfferedConnection[];
	notOffered: Array<{ connection: ModelConnection; reason: NotOfferedReason }>;
}

/** The part of VeyraAuth the list needs (tests pass a fake). */
export interface ModelConnectionsSource {
	account(): VeyraAccount | undefined;
	listModelConnections(options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Connect refused the list, or answered something Fingers can't read. `message` is meant for the person. */
export class ModelConnectionsError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = "ModelConnectionsError";
		this.status = status;
	}
}

const PROVIDER_ID_PREFIX = "veyra-";

/** `veyra-mc_openai_prod`: a provider id `provider/model` references can name (no `/` or `:`). */
function connectionProviderId(connectionId: string): string {
	return `${PROVIDER_ID_PREFIX}${connectionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** True for the provider ids of Veyra model connections. */
export function isConnectionProviderId(providerId: string): boolean {
	return providerId.startsWith(PROVIDER_ID_PREFIX);
}

/** The base URL Fingers' provider client appends its paths to, for one connection on one wire. */
export function proxyBaseUrl(handsApiBaseUrl: string, connectionId: string, wire: ProxyWire): string {
	return `${handsApiBaseUrl.replace(/\/+$/, "")}/model-proxy/${encodeURIComponent(connectionId)}/${wire}`;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Connect's list answer as connections; entries without an id or provider are skipped. */
export function parseModelConnections(body: unknown): ModelConnection[] {
	const data = typeof body === "object" && body !== null ? (body as Record<string, unknown>).data : undefined;
	if (!Array.isArray(data)) throw new ModelConnectionsError("Connect's list of model connections is not readable.");
	const connections: ModelConnection[] = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const value = entry as Record<string, unknown>;
		const id = text(value.id);
		const provider = text(value.provider);
		if (!id || !provider) continue;
		connections.push({
			id,
			provider,
			auth: text(value.auth) ?? "api_key",
			name: text(value.name) ?? id,
			apps: strings(value.apps),
			groups: strings(value.groups),
			capabilities: strings(value.capabilities),
			models: strings(value.models),
			status: text(value.status),
			keyHint: text(value.key_hint),
		});
	}
	return connections;
}

/** Which connections Fingers offers to `account` and why the others are not. */
export function classifyModelConnections(
	connections: readonly ModelConnection[],
	account: Pick<VeyraAccount, "group">,
): Pick<ModelConnectionsList, "offered" | "notOffered"> {
	const offered: OfferedConnection[] = [];
	const notOffered: ModelConnectionsList["notOffered"] = [];
	const taken = new Set<string>();
	for (const connection of connections) {
		const route = PROXY_ROUTES[connection.provider];
		let reason: NotOfferedReason | undefined;
		if (!connection.apps.includes("fingers")) reason = "not_for_fingers";
		else if (!connection.apps.includes("hands")) reason = "not_for_hands";
		else if (!route) reason = "provider";
		else if (connection.auth !== "api_key" && !(connection.auth === "subscription" && route.subscription)) {
			reason = "subscription";
		} else if (connection.capabilities.length > 0 && !connection.capabilities.includes("chat")) reason = "chat";
		else if (connection.status === "key_rejected") reason = "key_rejected";
		else if (connection.groups.length > 0 && (!account.group || !connection.groups.includes(account.group))) {
			reason = "group";
		}
		const providerId = connectionProviderId(connection.id);
		if (reason || !route || taken.has(providerId)) {
			if (reason) notOffered.push({ connection, reason });
			continue;
		}
		taken.add(providerId);
		const name = connectText(connection.name).trim() || route.label;
		offered.push({ connection, route, providerId, displayName: `${name} (Veyra)` });
	}
	return { offered, notOffered };
}

/**
 * The connections Connect opens to Fingers in the signed-in organization, classified. Throws ModelConnectionsError
 * with a message for the person when Connect refuses (no `models:read`, Fingers off) and VeyraSignedOutError when
 * nobody is signed in.
 */
export async function fetchModelConnections(
	source: ModelConnectionsSource,
	options: { signal?: AbortSignal } = {},
): Promise<ModelConnectionsList> {
	const account = source.account();
	let body: unknown;
	try {
		body = await source.listModelConnections(options);
	} catch (error) {
		if (error instanceof VeyraApiError) throw listError(error, account);
		throw error;
	}
	const org = account?.org ?? "";
	return { org, ...classifyModelConnections(parseModelConnections(body), account ?? {}) };
}

function listError(error: VeyraApiError, account: VeyraAccount | undefined): ModelConnectionsError {
	const org = connectText(account?.orgName ?? account?.org) ?? "your organization";
	const group = connectText(account?.groupName);
	if (error.status === 403) {
		return new ModelConnectionsError(
			`Your group${group ? ` (${group})` : ""} in ${org} may not see model connections (Connect models:read). Ask an admin of the organization.`,
			403,
			{ cause: error },
		);
	}
	if (error.status === 401) {
		return new ModelConnectionsError("Connect did not take the sign-in. Run fingers login again.", 401, {
			cause: error,
		});
	}
	return new ModelConnectionsError(`Connect could not list model connections (${error.message}).`, error.status, {
		cause: error,
	});
}

const REASON_TEXT: Readonly<Record<NotOfferedReason, string>> = {
	not_for_fingers: "not open to Fingers",
	not_for_hands: "not open to Hands, which relays the calls",
	provider: "provider not relayed yet",
	subscription: "its subscription sign-in is not relayed yet",
	chat: "no chat models",
	key_rejected: "its key was rejected",
	group: "not for your group",
};

function notOfferedText(reason: NotOfferedReason): string {
	return REASON_TEXT[reason];
}

/**
 * "3 model connections from Connect: Anthropic, OpenAI, OpenRouter" (canvas FingersTuiLogin), or why there is none.
 * Names come from Connect and are made safe to print.
 */
export function modelConnectionsSummary(list: Pick<ModelConnectionsList, "offered" | "notOffered">): {
	ok: boolean;
	text: string;
} {
	const count = list.offered.length;
	if (count > 0) {
		const names = list.offered.map((entry) => connectText(entry.connection.name).trim() || entry.route.label);
		return { ok: true, text: `${count} model connection${count === 1 ? "" : "s"} from Connect: ${names.join(", ")}` };
	}
	if (list.notOffered.length === 0) {
		return {
			ok: false,
			text: "No model connection in Connect is open to Fingers yet: an admin adds fingers and hands to a connection’s apps.",
		};
	}
	const why = list.notOffered
		.map(
			(entry) =>
				`${connectText(entry.connection.name).trim() || entry.connection.id} (${notOfferedText(entry.reason)})`,
		)
		.join(", ");
	return { ok: false, text: `No model connection from Connect is usable here: ${why}.` };
}
