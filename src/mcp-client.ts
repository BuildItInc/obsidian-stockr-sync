/**
 * Minimal MCP client for the Stockr MCP server (streamable HTTP).
 */
import { requestUrl } from "obsidian";

export const MCP_URL = "https://mcp.stockr.biz";

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
}

export interface Stock {
  id: string;
  text: string;
  createdAt: string;
  themeId: string | null;
  aiFeedbackComment?: string | null;
}

export interface Theme {
  id: string;
  title: string;
}

interface StocksPayload {
  data?: Stock[];
}

interface ThemesPayload {
  data?: Theme[];
}

export class StockrMcpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private forceRefreshNext = false;

  constructor(private getAccessToken: (force?: boolean) => Promise<string>) {}

  private async rpc(method: string, params: unknown, retryOn401 = true): Promise<unknown> {
    const token = await this.getAccessToken(this.forceRefreshNext);
    this.forceRefreshNext = false;
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await requestUrl({
      url: MCP_URL,
      method: "POST",
      contentType: "application/json",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      throw: false,
    });

    if (res.status === 401 && retryOn401) {
      this.sessionId = null;
      this.forceRefreshNext = true;
      return this.rpc(method, params, false);
    }
    if (res.status >= 400) throw new Error(`MCP request failed: ${res.status} ${res.text}`);

    const sid = this.headerValue(res.headers, "mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202 || !res.text) return null;

    const dataLine = res.text.split("\n").find((l) => l.startsWith("data:"));
    const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : res.text) as JsonRpcResponse;
    if (payload.error) throw new Error(`MCP error: ${payload.error.message}`);
    return payload.result;
  }

  private headerValue(headers: Record<string, string>, name: string): string | null {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return headers[key];
    }
    return null;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "obsidian-stockr-sync", version: "0.1.1" },
    });
    await this.rpc("notifications/initialized", {}).catch(() => {});
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as ToolCallResult | null;
    if (result?.isError) {
      throw new Error(result.content?.[0]?.text ?? "tool call failed");
    }
    return result?.structuredContent ?? result;
  }

  async createStock(text: string): Promise<Stock | undefined> {
    const payload = (await this.callTool("stocks_create", { text })) as StocksPayload | null;
    return payload?.data?.[0];
  }

  async listThemes(): Promise<Theme[]> {
    const payload = (await this.callTool("themes_list", {})) as ThemesPayload | null;
    return payload?.data ?? [];
  }

  async searchByPeriod(from: string, to: string): Promise<Stock[]> {
    const payload = (await this.callTool("stocks_search_by_period", { from, to })) as StocksPayload | null;
    return payload?.data ?? [];
  }

  reset(): void {
    this.sessionId = null;
  }
}
