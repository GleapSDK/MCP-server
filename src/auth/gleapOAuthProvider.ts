import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GLEAP_AUTH_ISSUER } from "../config/index.js";
import { verifyGleapJwt } from "./jwtVerifier.js";

export function createGleapOAuthProvider(): ProxyOAuthServerProvider {
  const base = GLEAP_AUTH_ISSUER;

  return new ProxyOAuthServerProvider({
    endpoints: {
      authorizationUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      revocationUrl: `${base}/oauth/revoke`,
      registrationUrl: `${base}/oauth/register`,
    },

    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      let claims: Awaited<ReturnType<typeof verifyGleapJwt>>;
      try {
        claims = await verifyGleapJwt(token);
      } catch (err) {
        throw new InvalidTokenError(
          err instanceof Error ? err.message : "Invalid or expired token"
        );
      }
      return {
        token,
        clientId: claims.client_id ?? "",
        scopes: claims.scope ? claims.scope.split(" ") : [],
        expiresAt: claims.exp,
        extra: {
          projectId: claims.project_id,
          apiKey: claims.api_key,
          projects: claims.projects?.map((project) => ({
            projectId: project.id,
            name: String(project.name ?? ""),
            apiKey: project.api_key,
            error: project.api_key ? undefined : (project.error ?? "unavailable"),
          })),
          userId: claims.sub,
        },
      };
    },

    getClient: async (
      clientId: string
    ): Promise<OAuthClientInformationFull | undefined> => {
      const resp = await fetch(`${base}/oauth/register/${clientId}`);
      if (!resp.ok) return undefined;
      return resp.json();
    },
  });
}
