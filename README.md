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

### 2. ngrok でトンネルを開く

別ターミナルで実行します。

```bash
ngrok http 3000
```

表示された `https://xxxx.ngrok-free.app` の URL をメモしておきます。

### 3. Claude Code フックの設定

プロジェクトまたはグローバルの `settings.json` に以下を追加します。
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

## セキュリティ

- すべての API エンドポイントは `x-secret-token` ヘッダーによるトークン認証が必要です
- `APPROVAL_TOKEN` 環境変数を設定しない場合、起動ごとにランダムなトークンが生成されます
- ngrok の URL が漏洩するとアクセスされる可能性があります。URL は毎回変わるため、セッションを終了したら ngrok も停止してください

## スマートフォン UI の機能

- 承認待ち依頼の一覧表示（手動取得）
- 依頼ごとの個別承認・拒否
- すべて承認（一括操作）
- 処理履歴の表示（直近 20 件）

## 動作確認済み環境

- Windows 11 + Node.js 22
- Claude Code（CLI）
- iOS Safari / Android Chrome

## ライセンス

MIT License — Copyright (c) 2026 sta29697

使用ライブラリのライセンス:
- [express](https://github.com/expressjs/express) — MIT
- [cors](https://github.com/expressjs/cors) — MIT
