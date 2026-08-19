# Stockr Sync (Obsidian Plugin)

Obsidianのノートから、ふりかえりノートアプリ[Stockr](https://mcp.stockr.biz)へ気づきをストックし、Stockrのストックをノートに取り込むプラグインです。

## 機能

- **選択範囲（または現在行）をStockrにストック** — コマンドパレットから1発
- **今日／最近7日のストックをノートに取り込む** — デイリーノートや週次レビューの材料に（日付はローカルタイムゾーン基準）

## 使い方

1. 設定 → Stockr Sync → 「Stockrに接続」からブラウザでStockrアカウントにログイン
2. コマンドパレット（Cmd/Ctrl+P）で「Stockr」と入力してコマンドを実行

ご利用にはStockrのご契約が必要です（追加料金はありません）。認証はOAuth 2.0で、プラグインがパスワードを扱うことはありません。権限は「ふりかえりの読み取り」と「新規ストックの投稿」のみです。

## 開発

```bash
npm install
npm run build   # 型チェック + バンドル → main.js
```

vaultの `.obsidian/plugins/stockr-sync/` に `manifest.json` と `main.js` を置いて有効化します。

- `src/auth.ts` — 認可サーバーへのOAuth（DCR＋認可コード/PKCE＋ループバックリダイレクト）
- `src/mcp-client.ts` — Stockr MCPサーバーへの最小MCPクライアント（streamable HTTP）
- `src/main.ts` — コマンド・設定タブ

## License

MIT © Build It, Inc.
