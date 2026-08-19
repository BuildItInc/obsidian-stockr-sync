/**
 * OAuth 2.0 client for the Stockr authorization server.
 * Dynamic Client Registration + Authorization Code with PKCE (loopback redirect).
 */
import * as http from "http";
import * as crypto from "crypto";
import { requestUrl } from "obsidian";

export const AUTH_BASE = "https://auth.stockr.biz";
export const MCP_RESOURCE = "https://mcp.stockr.biz";
export const SCOPES = "mcp:read mcp:write offline_access";

export interface StoredAuth {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(redirectUri: string): Promise<string> {
  const res = await requestUrl({
    url: `${AUTH_BASE}/oauth/register`,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      client_name: "Obsidian Stockr Sync",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
    throw: false,
  });
  if (res.status >= 400) {
    throw new Error(`Client registration failed: ${res.status} ${res.text}`);
  }
  return (res.json as { client_id: string }).client_id;
}

/** Run the browser authorization flow and return tokens. */
export async function authorize(openExternal: (url: string) => void): Promise<StoredAuth> {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind loopback server");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  try {
    const clientId = await registerClient(redirectUri);

    const code = await new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Authorization timed out (5 min)")), 5 * 60 * 1000);
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const err = url.searchParams.get("error");
        const gotState = url.searchParams.get("state");
        const gotCode = url.searchParams.get("code");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (err || gotState !== state || !gotCode) {
          res.end("<h3>認証に失敗しました。Obsidianに戻ってやり直してください。</h3>");
          window.clearTimeout(timeout);
          reject(new Error(err ?? "state mismatch"));
          return;
        }
        res.end("<h3>Stockrと接続しました。このタブを閉じてObsidianに戻ってください。</h3>");
        window.clearTimeout(timeout);
        resolve(gotCode);
      });

      const authUrl = new URL(`${AUTH_BASE}/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("resource", MCP_RESOURCE);
      openExternal(authUrl.toString());
    });

    const tokens = await exchangeToken(clientId, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    return { clientId, ...tokens };
  } finally {
    server.close();
  }
}

async function exchangeToken(
  clientId: string,
  params: Record<string, string>,
): Promise<Omit<StoredAuth, "clientId">> {
  const body = new URLSearchParams({ client_id: clientId, resource: MCP_RESOURCE, ...params });
  const res = await requestUrl({
    url: `${AUTH_BASE}/oauth/token`,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: body.toString(),
    throw: false,
  });
  if (res.status >= 400) {
    throw new Error(`Token request failed: ${res.status} ${res.text}`);
  }
  const json = res.json as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/** Refresh the access token when near expiry (or forced). Second element is true when updated. */
export async function ensureFreshToken(auth: StoredAuth, force = false): Promise<[StoredAuth, boolean]> {
  if (!force && Date.now() < auth.expiresAt - 60_000) return [auth, false];
  if (!auth.refreshToken) throw new Error("Session expired. Please reconnect to Stockr.");
  const tokens = await exchangeToken(auth.clientId, {
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
  });
  return [
    {
      clientId: auth.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || auth.refreshToken,
      expiresAt: tokens.expiresAt,
    },
    true,
  ];
}
