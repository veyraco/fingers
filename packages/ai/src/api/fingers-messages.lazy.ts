import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const fingersMessagesApi = (): ProviderStreams => lazyApi(() => import("./fingers-messages.ts"));
