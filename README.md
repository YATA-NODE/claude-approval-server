# claude-approval-server

Claude Code の PreToolUse フックと連携し、PC 上の承認ダイアログをスマートフォンから承認・拒否できるようにするツールです。

## 構成

```
approval-server.js   承認キューを管理する HTTP サーバー（PC 上で常駐）
claude-hook.js       Claude Code の PreToolUse フック（PC 上で動作）
approval-ui.html     スマートフォン用 Web UI（サーバーから配信）
```

## 仕組み

1. Claude Code がツールを実行しようとすると `claude-hook.js` が呼ばれる
2. `claude-hook.js` は `.claude/settings.local.json` の `permissions.allow` に含まれないツールだけ `approval-server.js` へ転送する（PC にダイアログが表示されるケースと一致）
3. スマートフォンのブラウザで ngrok URL を開き、承認または拒否する
4. Claude Code はポーリングで結果を受け取り、実行を継続または中止する

承認依頼には `[プロジェクト名][ツール名]` の形式でプロジェクトが表示されます。複数のターミナルで Claude Code を使っている場合でも、どのプロジェクトからの依頼かスマホ上で識別できます。

## セットアップ

### 必要なもの

- Node.js 18 以上
- [ngrok](https://ngrok.com/) アカウント（無料枠で動作）

### 1. サーバーのインストールと起動

```bash
git clone https://github.com/YATA-NODE/claude-approval-server.git
cd claude-approval-server
npm install

# トークンを固定する場合（推奨）
export APPROVAL_TOKEN=任意の文字列

node approval-server.js
```

起動時にコンソールへ `SECRET_TOKEN` が表示されます。

**複数のプロジェクトで Claude Code を同時に使う場合も、サーバーは 1 つだけ起動すれば OK です。**

### 2. ngrok でトンネルを開く

別ターミナルで実行します。

```bash
ngrok http 3000
```

表示された `https://xxxx.ngrok-free.app` の URL をメモしておきます。

### 3. Claude Code フックの設定

グローバルの `~/.claude/settings.json` に以下を追加します（全プロジェクト共通で動作します）。
パスは実際の配置場所に合わせてください。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-approval-server/claude-hook.js"
          }
        ]
      }
    ]
  }
}
```

`claude-hook.js` は環境変数 `APPROVAL_TOKEN` を読み取ります。
シェルのプロファイルか Claude Code の `env` 設定でセットしてください。

### 4. スマートフォンで開く

スマートフォンのブラウザで ngrok URL（例: `https://xxxx.ngrok-free.app`）を開きます。
サーバーが `approval-ui.html` を配信するので、インストール不要です。

画面の指示に従い URL と `APPROVAL_TOKEN` を入力して接続します。
設定は `localStorage` に保存されるため、次回以降は自動入力されます。

## よくある質問

### 複数のターミナルで Claude Code を使っている場合、サーバーはどこで起動すればよいですか？

**どのディレクトリでも構いません。サーバーは 1 つだけ起動すれば全プロジェクトを受け付けます。**

```
ターミナル1: node approval-server.js   ← 場所はどこでも OK、1 回だけ起動
ターミナル2: Claude Code（プロジェクト A）
ターミナル3: Claude Code（プロジェクト B）
ターミナル4: ngrok http 3000
```

フックの設定をグローバル（`~/.claude/settings.json`）に入れておけば、すべてのプロジェクトで自動的にこのサーバーへ転送されます。

### 複数プロジェクトを同時に使っている場合、スマホからどのプロジェクトの承認か分かりますか？

**分かります。** 承認依頼には `[プロジェクト名][ツール名]` の形式でプロジェクトが表示されます。

```
例: [my-app][Bash] git push origin main
    [another-project][Edit] src/index.ts
```

プロジェクト名は Claude Code を起動したディレクトリのフォルダ名が自動的に使われます。

## セキュリティ

- すべての API エンドポイントは `x-secret-token` ヘッダーによるトークン認証が必要です
- `APPROVAL_TOKEN` 環境変数を設定しない場合、起動ごとにランダムなトークンが生成されます
- ngrok の URL が漏洩するとアクセスされる可能性があります。URL は毎回変わるため、セッションを終了したら ngrok も停止してください

## スマートフォン UI の機能

- 承認待ち依頼の一覧表示（手動取得）
- 依頼ごとの個別承認・拒否
- すべて承認（一括操作）
- 処理履歴の表示（直近 20 件）
- 日本語 / 英語 切替
- ダーク / ライト テーマ切替

## 動作確認済み環境

- Windows 11 + Node.js 22
- Claude Code（CLI）
- iOS Safari / Android Chrome

## ライセンス

MIT License — Copyright (c) 2026 sta29697

使用ライブラリのライセンス:
- [express](https://github.com/expressjs/express) — MIT
- [cors](https://github.com/expressjs/cors) — MIT

---

# claude-approval-server (English)

A tool that integrates with Claude Code's PreToolUse hook, allowing you to approve or reject PC approval dialogs from your smartphone.

## Structure

```
approval-server.js   HTTP server that manages the approval queue (runs on PC)
claude-hook.js       Claude Code PreToolUse hook (runs on PC)
approval-ui.html     Smartphone Web UI (served by the server)
```

## How It Works

1. When Claude Code tries to execute a tool, `claude-hook.js` is called
2. `claude-hook.js` forwards only tools NOT listed in `.claude/settings.local.json`'s `permissions.allow` to `approval-server.js` (matching exactly when a terminal dialog appears on PC)
3. Open the ngrok URL in your smartphone browser to approve or reject
4. Claude Code receives the result via polling and continues or aborts execution

Approval requests are displayed as `[ProjectName][ToolName]`, so you can identify which project sent the request even when running Claude Code in multiple terminals simultaneously.

## Setup

### Requirements

- Node.js 18+
- [ngrok](https://ngrok.com/) account (free tier works)

### 1. Install and Start the Server

```bash
git clone https://github.com/YATA-NODE/claude-approval-server.git
cd claude-approval-server
npm install

# Recommended: fix the token via environment variable
export APPROVAL_TOKEN=your-secret-string

node approval-server.js
```

The `SECRET_TOKEN` is printed to the console on startup.

**If you run Claude Code in multiple terminals at the same time, you only need one server instance.**

### 2. Open an ngrok Tunnel

Run in a separate terminal:

```bash
ngrok http 3000
```

Note the `https://xxxx.ngrok-free.app` URL displayed.

### 3. Configure the Claude Code Hook

Add the following to your global `~/.claude/settings.json` (applies to all projects).
Adjust the path to match where you cloned the repo.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-approval-server/claude-hook.js"
          }
        ]
      }
    ]
  }
}
```

`claude-hook.js` reads the `APPROVAL_TOKEN` environment variable.
Set it in your shell profile or via Claude Code's `env` configuration.

### 4. Open on Smartphone

Open the ngrok URL (e.g. `https://xxxx.ngrok-free.app`) in your smartphone browser.
The server serves `approval-ui.html` directly — no installation needed.

Enter the URL and `APPROVAL_TOKEN` as prompted. Settings are saved to `localStorage` and auto-filled on subsequent visits.

## FAQ

### When using Claude Code in multiple terminals, where should I start the server?

**Anywhere — you only need one server instance for all projects.**

```
Terminal 1: node approval-server.js   ← start once, location doesn't matter
Terminal 2: Claude Code (Project A)
Terminal 3: Claude Code (Project B)
Terminal 4: ngrok http 3000
```

If you configure the hook globally in `~/.claude/settings.json`, all projects will automatically route through this server.

### When running multiple projects at the same time, can I tell which project sent an approval request from my phone?

**Yes.** Each approval request is prefixed with `[ProjectName][ToolName]`.

```
Example: [my-app][Bash] git push origin main
         [another-project][Edit] src/index.ts
```

The project name is automatically derived from the folder name where Claude Code is running.

## Security

- All API endpoints require token authentication via the `x-secret-token` header
- If `APPROVAL_TOKEN` is not set, a random token is generated on each startup
- If the ngrok URL is leaked, others may access it. The URL changes every session, so stop ngrok when done

## Smartphone UI Features

- List pending approval requests (manual fetch)
- Approve or reject each request individually
- Approve all at once (bulk operation)
- View history of the last 20 resolved requests
- Japanese / English language toggle
- Dark / Light theme toggle

## Tested Environments

- Windows 11 + Node.js 22
- Claude Code (CLI)
- iOS Safari / Android Chrome

## License

MIT License — Copyright (c) 2026 sta29697

Dependency licenses:
- [express](https://github.com/expressjs/express) — MIT
- [cors](https://github.com/expressjs/cors) — MIT
