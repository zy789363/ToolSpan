import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ListToolsRequestSchema, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { OAuthScope } from "./auth/oauth-service.js";

type ToolInputSchema = undefined | ZodRawShapeCompat | AnySchema;

export interface ToolSecurityScheme {
  type: "oauth2";
  scopes: OAuthScope[];
}

export interface ToolSpanToolRegistryEntry {
  name: string;
  title?: string;
  description?: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  securitySchemes: ToolSecurityScheme[];
  requiredScopes: OAuthScope[];
  handler: unknown;
}

export interface McpToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  securitySchemes: ToolSecurityScheme[];
  requiredScopes: OAuthScope[];
}

interface ToolRegistration<InputArgs extends ToolInputSchema> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  annotations?: ToolAnnotations;
  _meta: { securitySchemes: readonly ToolSecurityScheme[] };
}

function jsonInputSchema(inputSchema: ToolInputSchema): Record<string, unknown> {
  const normalized = normalizeObjectSchema(inputSchema);
  if (normalized === undefined) return { type: "object", properties: {} };
  return toJsonSchemaCompat(normalized, {
    strictUnions: true,
    pipeStrategy: "input",
  }) as Record<string, unknown>;
}

function compareByName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, "en");
}

export class ToolSpanToolRegistry {
  readonly #entries = new Map<string, ToolSpanToolRegistryEntry>();

  constructor(private readonly server: McpServer) {}

  registerTool<InputArgs extends ToolInputSchema = undefined>(
    name: string,
    config: ToolRegistration<InputArgs>,
    handler: ToolCallback<InputArgs>,
  ): void {
    if (this.#entries.has(name)) throw new Error(`Duplicate MCP tool registration: ${name}`);
    const securitySchemes = config._meta.securitySchemes.map((scheme) => ({
      type: scheme.type,
      scopes: [...scheme.scopes],
    }));
    const requiredScopes = [...new Set(securitySchemes.flatMap((scheme) => scheme.scopes))];
    if (requiredScopes.length === 0) {
      throw new Error(`MCP tool must declare at least one required scope: ${name}`);
    }
    this.#entries.set(name, {
      name,
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: config.annotations,
      securitySchemes,
      requiredScopes,
      handler,
    });
    this.server.registerTool(name, {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: config.annotations,
      _meta: { securitySchemes },
    }, handler);
  }

  entries(): readonly ToolSpanToolRegistryEntry[] {
    return [...this.#entries.values()];
  }

  listedTools(): Array<Record<string, unknown>> {
    return this.entries().map((entry) => ({
      name: entry.name,
      title: entry.title,
      description: entry.description,
      inputSchema: jsonInputSchema(entry.inputSchema),
      annotations: entry.annotations,
      securitySchemes: entry.securitySchemes,
      _meta: { securitySchemes: entry.securitySchemes },
    }));
  }

  contract(): McpToolContract[] {
    return this.entries().map((entry) => ({
      name: entry.name,
      description: entry.description ?? "",
      inputSchema: jsonInputSchema(entry.inputSchema),
      annotations: entry.annotations ?? {},
      securitySchemes: entry.securitySchemes,
      requiredScopes: entry.requiredScopes,
    })).sort(compareByName);
  }

  installListHandler(): void {
    this.server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.listedTools(),
    }));
  }
}

export function contractFromListedTools(
  tools: readonly Record<string, unknown>[],
  registry: ToolSpanToolRegistry,
): McpToolContract[] {
  const scopesByName = new Map(
    registry.entries().map((entry) => [entry.name, entry.requiredScopes] as const),
  );
  return tools.map((tool) => {
    const name = String(tool.name);
    const requiredScopes = scopesByName.get(name);
    if (requiredScopes === undefined) throw new Error(`Unexpected tools/list entry: ${name}`);
    const metadata = tool._meta as Record<string, unknown> | undefined;
    const securitySchemes = (tool.securitySchemes ?? metadata?.securitySchemes) as
      | ToolSecurityScheme[]
      | undefined;
    if (securitySchemes === undefined) {
      throw new Error(`tools/list omitted security metadata: ${name}`);
    }
    return {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: (tool.annotations ?? {}) as ToolAnnotations,
      securitySchemes,
      requiredScopes: [...requiredScopes],
    };
  }).sort(compareByName);
}
