import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicVertexApi = (): ProviderStreams => lazyApi(() => import("./anthropic-vertex.ts"));
