import { GoogleAuth } from "google-auth-library";
import { createGoogleAdcTokenSource } from "./api/vertex-token.ts";

/**
 * Vertex token source with a static google-auth-library import, for bundles that cannot follow the
 * variable-specifier import (the Bun binary). Register it with `setVertexTokenSource`.
 */
export const googleAdcTokenSource = createGoogleAdcTokenSource(async () => GoogleAuth);
