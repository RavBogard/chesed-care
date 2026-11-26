import "server-only";
import { getAuth } from "@/server/auth";
import type { ConnectorIdentity } from "@/server/auth/factory";

/** The identity a connector access token was issued to, or null (unknown, expired, revoked, wrong resource or scope). */
export async function resolveConnectorToken(token: string): Promise<ConnectorIdentity | null> {
  return getAuth().api.resolveConnectorToken({ body: { token } });
}
