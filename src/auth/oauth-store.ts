import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  clientSecretHash: string | null;
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  codeChallenge: string;
  expiresAt: string;
}

export interface TokenRecord {
  tokenHash: string;
  tokenType: "access" | "refresh";
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: string;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris_json: string;
  token_endpoint_auth_method: OAuthClientRecord["tokenEndpointAuthMethod"];
  client_secret_hash: string | null;
  created_at: string;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  scopes_json: string;
  resource: string;
  code_challenge: string;
  expires_at: string;
}

interface TokenRow {
  token_hash: string;
  token_type: TokenRecord["tokenType"];
  client_id: string;
  scopes_json: string;
  resource: string;
  expires_at: string;
}

function mapClient(row: ClientRow): OAuthClientRecord {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: JSON.parse(row.redirect_uris_json) as string[],
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    clientSecretHash: row.client_secret_hash,
    createdAt: row.created_at,
  };
}

function mapCode(row: CodeRow): AuthorizationCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scopes: JSON.parse(row.scopes_json) as string[],
    resource: row.resource,
    codeChallenge: row.code_challenge,
    expiresAt: row.expires_at,
  };
}

function mapToken(row: TokenRow): TokenRecord {
  return {
    tokenHash: row.token_hash,
    tokenType: row.token_type,
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    resource: row.resource,
    expiresAt: row.expires_at,
  };
}

export class OAuthStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris_json TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        client_secret_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        redirect_uri TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        token_type TEXT NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
        scopes_json TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_tokens_expiry_idx
        ON oauth_tokens(token_type, expires_at);
    `);
  }

  insertClient(client: OAuthClientRecord): void {
    this.#database
      .prepare(
        `INSERT INTO oauth_clients
          (client_id, client_name, redirect_uris_json, token_endpoint_auth_method,
           client_secret_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.clientId,
        client.clientName,
        JSON.stringify(client.redirectUris),
        client.tokenEndpointAuthMethod,
        client.clientSecretHash,
        client.createdAt,
      );
  }

  getClient(clientId: string): OAuthClientRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(
      clientId,
    ) as ClientRow | undefined;
    return row === undefined ? undefined : mapClient(row);
  }

  countClients(): number {
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM oauth_clients").get() as {
      count: number;
    };
    return row.count;
  }

  insertAuthorizationCode(code: AuthorizationCodeRecord): void {
    this.#database
      .prepare(
        `INSERT INTO oauth_authorization_codes
          (code_hash, client_id, redirect_uri, scopes_json, resource, code_challenge, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code.codeHash,
        code.clientId,
        code.redirectUri,
        JSON.stringify(code.scopes),
        code.resource,
        code.codeChallenge,
        code.expiresAt,
      );
  }

  getValidAuthorizationCode(codeHash: string, now: string): AuthorizationCodeRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM oauth_authorization_codes
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(codeHash, now) as CodeRow | undefined;
    return row === undefined ? undefined : mapCode(row);
  }

  consumeAuthorizationCode(codeHash: string, now: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE oauth_authorization_codes SET used_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(now, codeHash, now);
    return result.changes === 1;
  }

  insertToken(token: TokenRecord): void {
    this.#database
      .prepare(
        `INSERT INTO oauth_tokens
          (token_hash, token_type, client_id, scopes_json, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.tokenHash,
        token.tokenType,
        token.clientId,
        JSON.stringify(token.scopes),
        token.resource,
        token.expiresAt,
        new Date().toISOString(),
      );
  }

  getValidToken(
    tokenHash: string,
    tokenType: TokenRecord["tokenType"],
    now: string,
  ): TokenRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM oauth_tokens
         WHERE token_hash = ? AND token_type = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, tokenType, now) as TokenRow | undefined;
    return row === undefined ? undefined : mapToken(row);
  }

  revokeToken(tokenHash: string): boolean {
    const result = this.#database
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), tokenHash);
    return result.changes === 1;
  }

  pruneExpired(now: string): void {
    this.#database
      .prepare("DELETE FROM oauth_authorization_codes WHERE expires_at <= ? OR used_at IS NOT NULL")
      .run(now);
    this.#database
      .prepare("DELETE FROM oauth_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL")
      .run(now);
  }

  close(): void {
    this.#database.close();
  }
}
