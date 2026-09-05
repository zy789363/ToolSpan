import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { compare } from "bcryptjs";

import {
  OAuthStore,
  type OAuthClientRecord,
  type TokenRecord,
} from "./oauth-store.js";

export const OAUTH_SCOPES = [
  "workspace:read",
  "workspace:write",
  "jobs:run",
  "artifacts:publish",
] as const;

export const OAUTH_LIFECYCLE_SCOPES = ["offline_access"] as const;

const OAUTH_SUPPORTED_SCOPES = [
  ...OAUTH_SCOPES,
  ...OAUTH_LIFECYCLE_SCOPES,
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];
export type OAuthLifecycleScope = (typeof OAUTH_LIFECYCLE_SCOPES)[number];
export type OAuthAuthorizationScope = OAuthScope | OAuthLifecycleScope;

export interface OAuthServiceOptions {
  databasePath: string;
  issuer: string;
  resource: string;
  ownerPasswordHash: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

export interface AuthorizationRequest {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
}

export interface AuthContext {
  clientId: string;
  scopes: ReadonlySet<OAuthScope>;
  resource: string;
  expiresAt: string;
}

export class OAuthRequestError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface OAuthService {
  readonly issuer: string;
  readonly resource: string;
  readonly protectedResourceMetadataUrl: string;
  protectedResourceMetadata(): Record<string, unknown>;
  authorizationServerMetadata(): Record<string, unknown>;
  registerClient(input: unknown): Record<string, unknown>;
  validateAuthorizationRequest(input: AuthorizationRequest): {
    client: OAuthClientRecord;
    scopes: OAuthAuthorizationScope[];
  };
  authorize(input: AuthorizationRequest & { password: string }, remoteAddress: string): Promise<string>;
  exchangeToken(input: Readonly<Record<string, string | undefined>>, authorization?: string): Record<string, unknown>;
  authenticate(authorization?: string): AuthContext;
  close(): void;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretMatches(actual: string, expectedHash: string): boolean {
  const actualBuffer = Buffer.from(sha256(actual), "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseScopes(value: string | undefined): OAuthAuthorizationScope[] {
  const requested = value === undefined || value.trim() === ""
    ? [...OAUTH_SCOPES]
    : [...new Set(value.trim().split(/\s+/))];
  if (
    requested.length === 0 ||
    requested.some((scope) => !OAUTH_SUPPORTED_SCOPES.includes(scope as OAuthAuthorizationScope))
  ) {
    throw new OAuthRequestError("invalid_scope", "One or more scopes are not supported");
  }
  return requested as OAuthAuthorizationScope[];
}

function isOAuthScope(value: string): value is OAuthScope {
  return OAUTH_SCOPES.includes(value as OAuthScope);
}

function requireString(value: unknown, field: string, maxLength = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new OAuthRequestError("invalid_request", `${field} is required`);
  }
  return value;
}

function validateIssuer(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("OAuth issuer must be an origin without a path");
  }
  if (url.protocol !== "https:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error("OAuth issuer must use HTTPS unless it is localhost");
  }
  return url.origin;
}

function authenticateClient(
  store: OAuthStore,
  input: Readonly<Record<string, string | undefined>>,
  authorization?: string,
): OAuthClientRecord {
  let clientId = input.client_id;
  let clientSecret = input.client_secret;
  const usedBasic = authorization?.startsWith("Basic ") === true;
  if (usedBasic) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator < 0) throw new Error("missing separator");
      clientId = decodeURIComponent(decoded.slice(0, separator));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {
      throw new OAuthRequestError("invalid_client", "Client authentication failed", 401);
    }
  }
  const client = store.getClient(requireString(clientId, "client_id", 256));
  if (client === undefined) {
    throw new OAuthRequestError("invalid_client", "Client authentication failed", 401);
  }
  if (client.tokenEndpointAuthMethod === "none") {
    if (usedBasic || clientSecret !== undefined) {
      throw new OAuthRequestError("invalid_client", "Public client must not send a secret", 401);
    }
    return client;
  }
  if (
    (client.tokenEndpointAuthMethod === "client_secret_basic" && !usedBasic) ||
    (client.tokenEndpointAuthMethod === "client_secret_post" && usedBasic)
  ) {
    throw new OAuthRequestError("invalid_client", "Client used the wrong authentication method", 401);
  }
  if (
    clientSecret === undefined ||
    client.clientSecretHash === null ||
    !secretMatches(clientSecret, client.clientSecretHash)
  ) {
    throw new OAuthRequestError("invalid_client", "Client authentication failed", 401);
  }
  return client;
}

export function createOAuthService(options: OAuthServiceOptions): OAuthService {
  const issuer = validateIssuer(options.issuer);
  const resource = new URL(options.resource).toString();
  const store = new OAuthStore(options.databasePath);
  const failedLogins = new Map<string, { count: number; resetAt: number }>();
  const accessTtl = options.accessTokenTtlSeconds ?? 3600;
  const refreshTtl = options.refreshTokenTtlSeconds ?? 30 * 24 * 3600;

  const issueTokens = (
    clientId: string,
    scopes: OAuthAuthorizationScope[],
  ): Record<string, unknown> => {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const now = Date.now();
    const toolScopes = scopes.filter(isOAuthScope);
    store.pruneExpired(new Date(now).toISOString());
    const accessRecord: TokenRecord = {
      tokenHash: sha256(accessToken),
      tokenType: "access",
      clientId,
      scopes: toolScopes,
      resource,
      expiresAt: new Date(now + accessTtl * 1000).toISOString(),
    };
    const refreshRecord: TokenRecord = {
      tokenHash: sha256(refreshToken),
      tokenType: "refresh",
      clientId,
      scopes,
      resource,
      expiresAt: new Date(now + refreshTtl * 1000).toISOString(),
    };
    store.insertToken(accessRecord);
    store.insertToken(refreshRecord);
    return {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: accessTtl,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  };

  const service: OAuthService = {
    issuer,
    resource,
    protectedResourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource`,

    protectedResourceMetadata(): Record<string, unknown> {
      return {
        resource,
        authorization_servers: [issuer],
        scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
        bearer_methods_supported: ["header"],
      };
    },

    authorizationServerMetadata(): Record<string, unknown> {
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
        scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
      };
    },

    registerClient(input): Record<string, unknown> {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new OAuthRequestError("invalid_client_metadata", "JSON object required");
      }
      const body = input as Record<string, unknown>;
      if (store.countClients() >= 1000) {
        throw new OAuthRequestError("temporarily_unavailable", "Client registration capacity reached", 429);
      }
      const clientName = requireString(body.client_name, "client_name", 200);
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 10) {
        throw new OAuthRequestError("invalid_redirect_uri", "redirect_uris must be a non-empty array");
      }
      const redirectUris = body.redirect_uris.map((value) => requireString(value, "redirect_uri"));
      if (new Set(redirectUris).size !== redirectUris.length || redirectUris.some((uri) => !isSafeRedirectUri(uri))) {
        throw new OAuthRequestError("invalid_redirect_uri", "Only HTTPS or localhost redirects are allowed");
      }
      if (
        body.response_types !== undefined &&
        (!Array.isArray(body.response_types) ||
          body.response_types.length !== 1 ||
          body.response_types[0] !== "code")
      ) {
        throw new OAuthRequestError("invalid_client_metadata", "Only response_types [code] is supported");
      }
      if (
        body.grant_types !== undefined &&
        (!Array.isArray(body.grant_types) ||
          !body.grant_types.includes("authorization_code") ||
          body.grant_types.some((grant) => !["authorization_code", "refresh_token"].includes(String(grant))))
      ) {
        throw new OAuthRequestError("invalid_client_metadata", "Unsupported grant_types metadata");
      }
      const authMethod = body.token_endpoint_auth_method ?? "none";
      if (!["none", "client_secret_post", "client_secret_basic"].includes(String(authMethod))) {
        throw new OAuthRequestError("invalid_client_metadata", "Unsupported token endpoint auth method");
      }
      const clientId = randomBytes(24).toString("base64url");
      const clientSecret = authMethod === "none" ? undefined : randomBytes(32).toString("base64url");
      const createdAt = new Date().toISOString();
      store.insertClient({
        clientId,
        clientName,
        redirectUris,
        tokenEndpointAuthMethod: authMethod as OAuthClientRecord["tokenEndpointAuthMethod"],
        clientSecretHash: clientSecret === undefined ? null : sha256(clientSecret),
        createdAt,
      });
      return {
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: authMethod,
        client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
        ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
      };
    },

    validateAuthorizationRequest(input) {
      if (input.response_type !== "code") {
        throw new OAuthRequestError("unsupported_response_type", "Only authorization code is supported");
      }
      const client = store.getClient(requireString(input.client_id, "client_id", 256));
      if (client === undefined) throw new OAuthRequestError("invalid_request", "Unknown client");
      const redirectUri = requireString(input.redirect_uri, "redirect_uri");
      if (!client.redirectUris.includes(redirectUri)) {
        throw new OAuthRequestError("invalid_request", "redirect_uri is not registered");
      }
      if (input.resource !== resource) {
        throw new OAuthRequestError("invalid_target", "resource does not match this server");
      }
      if (input.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(input.code_challenge)) {
        throw new OAuthRequestError("invalid_request", "PKCE S256 is required");
      }
      return { client, scopes: parseScopes(input.scope) };
    },

    async authorize(input, remoteAddress): Promise<string> {
      const validated = service.validateAuthorizationRequest(input);
      const now = Date.now();
      const attempt = failedLogins.get(remoteAddress);
      if (attempt !== undefined && attempt.resetAt > now && attempt.count >= 5) {
        throw new OAuthRequestError("access_denied", "Too many failed login attempts", 429);
      }
      if (!(await compare(input.password, options.ownerPasswordHash))) {
        const current = attempt === undefined || attempt.resetAt <= now
          ? { count: 0, resetAt: now + 15 * 60 * 1000 }
          : attempt;
        current.count += 1;
        failedLogins.set(remoteAddress, current);
        throw new OAuthRequestError("access_denied", "Owner password is incorrect", 401);
      }
      failedLogins.delete(remoteAddress);
      const code = randomBytes(32).toString("base64url");
      store.pruneExpired(new Date(now).toISOString());
      store.insertAuthorizationCode({
        codeHash: sha256(code),
        clientId: validated.client.clientId,
        redirectUri: input.redirect_uri,
        scopes: validated.scopes,
        resource,
        codeChallenge: input.code_challenge,
        expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
      });
      const callback = new URL(input.redirect_uri);
      callback.searchParams.set("code", code);
      if (input.state !== undefined) callback.searchParams.set("state", input.state);
      return callback.toString();
    },

    exchangeToken(input, authorization): Record<string, unknown> {
      const client = authenticateClient(store, input, authorization);
      const grantType = input.grant_type;
      if (grantType === "authorization_code") {
        const targetResource = requireString(input.resource, "resource");
        if (targetResource !== resource) throw new OAuthRequestError("invalid_target", "resource mismatch");
        const codeHash = sha256(requireString(input.code, "code", 512));
        const now = new Date().toISOString();
        const code = store.getValidAuthorizationCode(codeHash, now);
        if (code === undefined) throw new OAuthRequestError("invalid_grant", "Authorization code is invalid");
        const redirectUri = requireString(input.redirect_uri, "redirect_uri");
        const verifier = requireString(input.code_verifier, "code_verifier", 256);
        if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) {
          throw new OAuthRequestError("invalid_grant", "PKCE code_verifier is invalid");
        }
        const actualChallenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          code.clientId !== client.clientId ||
          code.redirectUri !== redirectUri ||
          code.resource !== targetResource ||
          !secretMatches(actualChallenge, sha256(code.codeChallenge))
        ) {
          throw new OAuthRequestError("invalid_grant", "Authorization code binding failed");
        }
        if (!store.consumeAuthorizationCode(codeHash, now)) {
          throw new OAuthRequestError("invalid_grant", "Authorization code was already used");
        }
        return issueTokens(client.clientId, code.scopes as OAuthAuthorizationScope[]);
      }
      if (grantType === "refresh_token") {
        const targetResource = requireString(input.resource, "resource");
        const rawRefreshToken = requireString(input.refresh_token, "refresh_token", 512);
        const tokenHash = sha256(rawRefreshToken);
        const refresh = store.getValidToken(tokenHash, "refresh", new Date().toISOString());
        if (
          refresh === undefined ||
          refresh.clientId !== client.clientId ||
          refresh.resource !== targetResource ||
          targetResource !== resource
        ) {
          throw new OAuthRequestError("invalid_grant", "Refresh token is invalid");
        }
        let scopes = refresh.scopes as OAuthAuthorizationScope[];
        if (input.scope !== undefined) {
          const requestedScopes = parseScopes(input.scope);
          const grantedScopes = new Set(refresh.scopes);
          if (requestedScopes.some((scope) => !grantedScopes.has(scope))) {
            throw new OAuthRequestError(
              "invalid_scope",
              "Refresh scope exceeds the originally granted scopes",
            );
          }
          scopes = requestedScopes;
        }
        if (!store.revokeToken(tokenHash)) {
          throw new OAuthRequestError("invalid_grant", "Refresh token is invalid");
        }
        return issueTokens(client.clientId, scopes);
      }
      throw new OAuthRequestError("unsupported_grant_type", "Grant type is not supported");
    },

    authenticate(authorization): AuthContext {
      if (authorization === undefined || !authorization.startsWith("Bearer ")) {
        throw new OAuthRequestError("invalid_token", "Bearer token required", 401);
      }
      const raw = authorization.slice(7);
      if (raw.length === 0 || raw.includes(" ")) {
        throw new OAuthRequestError("invalid_token", "Bearer token is malformed", 401);
      }
      const token = store.getValidToken(sha256(raw), "access", new Date().toISOString());
      if (token === undefined || token.resource !== resource) {
        throw new OAuthRequestError("invalid_token", "Bearer token is invalid", 401);
      }
      return {
        clientId: token.clientId,
        scopes: new Set(token.scopes.filter(isOAuthScope)),
        resource: token.resource,
        expiresAt: token.expiresAt,
      };
    },

    close(): void {
      store.close();
    },
  };

  return service;
}
