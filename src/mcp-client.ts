/**
 * Minimal MCP client for the Stockr MCP server (streamable HTTP).
 */
import { requestUrl } from "obsidian";

export const MCP_URL = "https://mcp.stockr.biz";

interface JsonRpcResponse {
  result?: any;
  error?: { code: number; message: string };
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

export class StockrMcpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private getAccessToken: (force?: boolean) => Promise<string>) {}

  private forceRefreshNext = false;

  private async rpc(method: string, params: any, retryOn401 = true): Promise<any> {
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
    const payload: JsonRpcResponse = JSON.parse(dataLine ? dataLine.slice(5).trim() : res.text);
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
      clientInfo: { name: "obsidian-stockr-sync", version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", {}).catch(() => {});
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    await this.ensureSession();
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result?.isError) {
      const msg = result?.content?.[0]?.text ?? "tool call failed";
      throw new Error(msg);
    }
    return result?.structuredContent ?? result;
  }

  async createStock(text: string, themeId?: string): Promise<Stock> {
    const r = await this.callTool("stocks_create", themeId ? { text, themeId } : { text });
    return r?.data?.[0];
  }

  async listThemes(): Promise<Theme[]> {
    const r = await this.callTool("themes_list", {});
    return r?.data ?? [];
  }

  async searchByPeriod(from: string, to: string): Promise<Stock[]> {
    const r = await this.callTool("stocks_search_by_period", { from, to });
    return r?.data ?? [];
  }

  reset(): void {
    this.sessionId = null;
  }
}
