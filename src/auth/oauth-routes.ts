import express, { type Express, type Request, type Response } from "express";

import {
  OAuthRequestError,
  type AuthorizationRequest,
  type OAuthAuthorizationScope,
  type OAuthService,
} from "./oauth-service.js";

export interface OAuthRouteOptions {
  instanceName?: string;
}

const SCOPE_PRESENTATION: Record<
  OAuthAuthorizationScope,
  { description: string; highRiskWarning?: string }
> = {
  "workspace:read": {
    description: "Read workspace, file, job, and artifact information.",
  },
  "workspace:write": {
    description: "Create, modify, move, and delete workspace files.",
    highRiskWarning: "This permission can change or remove workspace data.",
  },
  "jobs:run": {
    description: "Run allowlisted project tasks.",
    highRiskWarning: "This permission can execute configured project commands.",
  },
  "artifacts:publish": {
    description: "Publish artifacts through shareable links.",
    highRiskWarning: "This permission can make artifact content accessible by link.",
  },
  offline_access: {
    description: "Maintain access by using refresh tokens.",
    highRiskWarning: "This client can stay connected after the current access token expires.",
  },
};

function field(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function authorizationRequest(input: Record<string, unknown>): AuthorizationRequest {
  return {
    response_type: field(input.response_type) ?? "",
    client_id: field(input.client_id) ?? "",
    redirect_uri: field(input.redirect_uri) ?? "",
    scope: field(input.scope),
    state: field(input.state),
    code_challenge: field(input.code_challenge) ?? "",
    code_challenge_method: field(input.code_challenge_method) ?? "",
    resource: field(input.resource) ?? "",
  };
}

function formFields(input: Record<string, unknown>): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, field(value)]));
}

function sendError(response: Response, error: unknown): void {
  response.set("Cache-Control", "no-store");
  if (error instanceof OAuthRequestError) {
    response.status(error.status).json({ error: error.error, error_description: error.message });
    return;
  }
  response.status(500).json({ error: "server_error", error_description: "OAuth request failed" });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function authorizationForm(
  input: AuthorizationRequest,
  clientName: string,
  redirectOrigin: string,
  scopes: readonly OAuthAuthorizationScope[],
  instanceName?: string,
): string {
  const entries = Object.entries(input).filter((entry): entry is [string, string] => {
    return entry[1] !== undefined;
  });
  const hidden = entries
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n");
  const requestedScopes = scopes
    .map((scope) => {
      const presentation = SCOPE_PRESENTATION[scope];
      const warning = presentation.highRiskWarning === undefined
        ? ""
        : ` <strong>High risk:</strong> ${presentation.highRiskWarning}`;
      return `<li><code>${escapeHtml(scope)}</code> — ${presentation.description}${warning}</li>`;
    })
    .join("\n");
  const instance = instanceName === undefined
    ? ""
    : `<p>ToolSpan instance: <strong>${escapeHtml(instanceName)}</strong></p>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize ToolSpan access</title></head>
<body>
  <main>
    <h1>Authorize ToolSpan access</h1>
    ${instance}
    <p>Client: <strong>${escapeHtml(clientName)}</strong></p>
    <p>Redirect origin: <code>${escapeHtml(redirectOrigin)}</code></p>
    <h2>Requested scopes</h2>
    <ul>${requestedScopes}</ul>
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label>Owner password <input type="password" name="password" required autocomplete="current-password"></label>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
}

export function registerOAuthRoutes(
  app: Express,
  oauth: OAuthService,
  options: OAuthRouteOptions = {},
): void {
  const registrationAttempts = new Map<string, { count: number; resetAt: number }>();
  app.get("/.well-known/oauth-protected-resource", (_request, response) => {
    response.json(oauth.protectedResourceMetadata());
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
    response.json(oauth.protectedResourceMetadata());
  });
  app.get("/.well-known/oauth-authorization-server", (_request, response) => {
    response.json(oauth.authorizationServerMetadata());
  });

  app.post("/oauth/register", express.json({ limit: "16kb" }), (request, response) => {
    try {
      const address = request.ip ?? request.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const previous = registrationAttempts.get(address);
      const attempt = previous === undefined || previous.resetAt <= now
        ? { count: 0, resetAt: now + 60 * 60 * 1000 }
        : previous;
      attempt.count += 1;
      registrationAttempts.set(address, attempt);
      if (attempt.count > 30) {
        throw new OAuthRequestError("temporarily_unavailable", "Too many registration attempts", 429);
      }
      response.status(201).json(oauth.registerClient(request.body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/oauth/authorize", (request, response) => {
    try {
      const input = authorizationRequest(request.query as Record<string, unknown>);
      const validated = oauth.validateAuthorizationRequest(input);
      const redirectOrigin = new URL(input.redirect_uri).origin;
      response
        .set("Cache-Control", "no-store")
        .set(
          "Content-Security-Policy",
          `default-src 'none'; form-action 'self' ${redirectOrigin}; base-uri 'none'; frame-ancestors 'none'`,
        )
        .set("X-Frame-Options", "DENY")
        .set("Referrer-Policy", "no-referrer")
        .type("html").send(
        authorizationForm(
          input,
          validated.client.clientName,
          redirectOrigin,
          validated.scopes,
          options.instanceName,
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(
    "/oauth/authorize",
    express.urlencoded({ extended: false, limit: "16kb" }),
    (request: Request, response: Response) => {
      const input = authorizationRequest(request.body as Record<string, unknown>);
      const password = field((request.body as Record<string, unknown>).password) ?? "";
      void oauth
        .authorize({ ...input, password }, request.ip ?? request.socket.remoteAddress ?? "unknown")
        .then((location) => response.redirect(302, location))
        .catch((error: unknown) => sendError(response, error));
    },
  );

  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "16kb" }),
    (request, response) => {
      try {
        const result = oauth.exchangeToken(
          formFields(request.body as Record<string, unknown>),
          request.header("Authorization"),
        );
        response.set("Cache-Control", "no-store").set("Pragma", "no-cache").json(result);
      } catch (error) {
        sendError(response, error);
      }
    },
  );
}

export function requireOAuth(oauth: OAuthService) {
  return (request: Request, response: Response, next: () => void): void => {
    try {
      response.locals.auth = oauth.authenticate(request.header("Authorization"));
      next();
    } catch {
      response
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}"`,
        )
        .json({ error: "unauthorized" });
    }
  };
}
