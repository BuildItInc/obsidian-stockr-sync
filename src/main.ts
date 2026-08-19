import {
  App,
  Editor,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { authorize, ensureFreshToken, StoredAuth } from "./auth";
import { StockrMcpClient, Stock } from "./mcp-client";

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface StockrSyncSettings {
  auth: StoredAuth | null;
  importHeading: string;
}

const DEFAULT_SETTINGS: StockrSyncSettings = {
  auth: null,
  importHeading: "## Stockrの気づき",
};

export default class StockrSyncPlugin extends Plugin {
  settings: StockrSyncSettings = DEFAULT_SETTINGS;
  client: StockrMcpClient | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new StockrMcpClient((force) => this.getAccessToken(force));

    this.addCommand({
      id: "stock-selection",
      name: "選択範囲（または現在行）をStockrにストック",
      editorCallback: (editor) => this.stockFromEditor(editor),
    });

    this.addCommand({
      id: "import-recent-stocks",
      name: "最近7日のストックをこのノートに取り込む",
      editorCallback: (editor) => this.importRecent(editor, 7),
    });

    this.addCommand({
      id: "import-today-stocks",
      name: "今日のストックをこのノートに取り込む",
      editorCallback: (editor) => this.importRecent(editor, 0),
    });

    this.addSettingTab(new StockrSettingTab(this.app, this));
  }

  private async getAccessToken(force = false): Promise<string> {
    if (!this.settings.auth) throw new Error("Stockrに接続されていません（設定から接続してください）");
    const [auth, updated] = await ensureFreshToken(this.settings.auth, force);
    if (updated) {
      this.settings.auth = auth;
      await this.saveSettings();
    }
    return auth.accessToken;
  }

  private async stockFromEditor(editor: Editor): Promise<void> {
    const selection = editor.getSelection();
    const text = (selection || editor.getLine(editor.getCursor().line)).trim();
    if (!text) {
      new Notice("ストックするテキストがありません");
      return;
    }
    if (text.length > 4000) {
      new Notice("4,000文字以内に収めてください");
      return;
    }
    try {
      await this.client!.createStock(text);
      new Notice("Stockrにストックしました ✔");
    } catch (e) {
      new Notice(`ストックに失敗: ${(e as Error).message}`);
    }
  }

  /** The server interprets dates as UTC day boundaries, so fetch one extra day on each side and filter by local date. */
  private async importRecent(editor: Editor, days: number): Promise<void> {
    try {
      const now = new Date();
      const DAY = 24 * 60 * 60 * 1000;
      const localFrom = ymd(new Date(now.getTime() - days * DAY));
      const queryFrom = ymd(new Date(now.getTime() - (days + 1) * DAY));
      const queryTo = ymd(new Date(now.getTime() + DAY));
      const fetched = await this.client!.searchByPeriod(queryFrom, queryTo);
      const stocks = fetched.filter((s) => ymd(new Date(s.createdAt)) >= localFrom);
      if (stocks.length === 0) {
        new Notice("この期間のストックはありません");
        return;
      }
      editor.replaceSelection(this.renderStocks(stocks));
      new Notice(`${stocks.length}件のストックを取り込みました`);
    } catch (e) {
      new Notice(`取り込みに失敗: ${(e as Error).message}`);
    }
  }

  private renderStocks(stocks: Stock[]): string {
    const lines = [this.settings.importHeading, ""];
    for (const s of stocks) {
      const stamp = ` *(${shortDate(s.createdAt)})*`;
      const [first = "", ...rest] = s.text.split("\n").filter((l, i) => i === 0 || l.trim());
      if (rest.length === 0) {
        lines.push(`- ${first}${stamp}`);
      } else {
        lines.push(`- ${first}`);
        rest.forEach((cont, i) => {
          lines.push(`  ${cont}${i === rest.length - 1 ? stamp : ""}`);
        });
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  async connect(): Promise<void> {
    try {
      new Notice("ブラウザでStockrにログインしてください…");
      const auth = await authorize((url) => window.open(url));
      this.settings.auth = auth;
      await this.saveSettings();
      this.client?.reset();
      new Notice("Stockrと接続しました ✔");
    } catch (e) {
      new Notice(`接続に失敗: ${(e as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    this.settings.auth = null;
    await this.saveSettings();
    this.client?.reset();
    new Notice("Stockrとの接続を解除しました");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class StockrSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: StockrSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const connected = Boolean(this.plugin.settings.auth);

    new Setting(containerEl)
      .setName("Stockrアカウント")
      .setDesc(
        connected
          ? "接続済みです。Stockrをご契約中のアカウントでご利用いただけます。"
          : "未接続です。ブラウザでStockrにログインして接続します（Stockrのご契約が必要です）。",
      )
      .addButton((btn) =>
        btn
          .setButtonText(connected ? "接続を解除" : "Stockrに接続")
          .setCta()
          .onClick(async () => {
            if (connected) await this.plugin.disconnect();
            else await this.plugin.connect();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("取り込み時の見出し")
      .setDesc("「ストックを取り込む」コマンドで挿入される見出し行。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.importHeading)
          .onChange(async (v) => {
            this.plugin.settings.importHeading = v || DEFAULT_SETTINGS.importHeading;
            await this.plugin.saveSettings();
          }),
      );
  }
}
