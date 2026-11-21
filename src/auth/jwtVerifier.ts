import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  GLEAP_JWKS_URI,
  GLEAP_AUTH_ISSUER,
  MCP_SERVER_URLS,
} from "../config/index.js";

const jwks = createRemoteJWKSet(new URL(GLEAP_JWKS_URI), {
  cacheMaxAge: 600_000, // 10 min cache
  cooldownDuration: 30_000, // refetch at most once per 30s
});

export interface GleapTokenClaims extends JWTPayload {
  project_id: string;
  api_key: string;
  /** Multi-project grants only: every project, main project first; a project without a key says why. */
  projects?: Array<{ id: string; name?: string; api_key?: string; error?: "plan" | "unavailable" }>;
  scope: string;
  client_id?: string;
  user_id?: string;
  email?: string;
}

export async function verifyGleapJwt(
  token: string
): Promise<GleapTokenClaims> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: GLEAP_AUTH_ISSUER,
    audience: MCP_SERVER_URLS,
    algorithms: ["RS256"],
    clockTolerance: 30,
  });

  if (!payload.project_id || typeof payload.project_id !== "string") {
    throw new Error("Token missing required claim: project_id");
  }
  if (!payload.api_key || typeof payload.api_key !== "string") {
    throw new Error("Token missing required claim: api_key");
  }
  const projects = (payload as any).projects;
  if (
    projects !== undefined &&
    (!Array.isArray(projects) ||
      projects.length === 0 ||
      typeof projects[0]?.api_key !== "string" ||
      projects.some(
        (project) =>
          typeof project?.id !== "string" ||
          (project.api_key !== undefined && typeof project.api_key !== "string"),
      ))
  ) {
    throw new Error("Token has an invalid claim: projects");
  }

  return payload as GleapTokenClaims;
}
