import express, { type ErrorRequestHandler, type Express } from "express";

import { registerArtifactRoutes } from "./artifacts/artifact-routes.js";
import { registerOAuthRoutes, requireOAuth } from "./auth/oauth-routes.js";
import type { OAuthService } from "./auth/oauth-service.js";
import { registerMcpEndpoint, type McpServices } from "./mcp.js";
import { SERVICE_INFO } from "./service-info.js";

export interface HttpAppOptions {
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  instanceName?: string;
  oauth?: OAuthService;
  mcp?: McpServices;
}

function hostnameFromHeader(value: string): string | undefined {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function createHttpApp(options: HttpAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  const allowedHosts = new Set(
    (options.allowedHosts ?? ["127.0.0.1", "localhost", "[::1]"]).map((host) => host.toLowerCase()),
  );
  const allowedOrigins = new Set(
    options.allowedOrigins ?? ["http://127.0.0.1", "http://localhost"],
  );

  app.use((request, response, next) => {
    const host = request.header("Host");
    const hostname = host === undefined ? undefined : hostnameFromHeader(host);
    if (hostname === undefined || !allowedHosts.has(hostname)) {
      response.status(403).json({ error: "Forbidden host" });
      return;
    }
    next();
  });

  if (options.oauth !== undefined) {
    registerOAuthRoutes(app, options.oauth, { instanceName: options.instanceName });
  }
  if (options.mcp !== undefined) registerArtifactRoutes(app, options.mcp.artifacts);

  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      service: SERVICE_INFO.service,
      version: SERVICE_INFO.version,
    });
  });

  app.use("/mcp", (request, response, next) => {
    const origin = request.header("Origin");
    if (origin !== undefined) {
      try {
        if (!allowedOrigins.has(new URL(origin).origin)) {
          response.status(403).json({ error: "Forbidden origin" });
          return;
        }
      } catch {
        response.status(403).json({ error: "Forbidden origin" });
        return;
      }
    }
    next();
  });

  app.use("/mcp", express.json({ limit: "36mb", type: "application/json" }));
  if (options.oauth !== undefined) app.use("/mcp", requireOAuth(options.oauth));
  registerMcpEndpoint(app, options.mcp);

  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 500;
    response.status(status === 413 ? 413 : 400).json({
      error: status === 413 ? "Request body too large" : "Invalid request body",
    });
  };
  app.use(handleError);

  return app;
}
