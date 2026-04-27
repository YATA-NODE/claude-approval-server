# claude-approval-server

Claude Code の承認ダイアログを、PC ターミナルと**スマートフォン（または PC ブラウザ）の両方**から承認・拒否できるようにするツールです。

PTY ラッパーが Claude Code の入出力を仲介し、ダイアログが出ると

- PC ターミナルに従来どおり表示（1/2/3 キーで応答可能）
- **同時に** スマートフォン／PC ブラウザの承認パネルにも表示

どちらで応答しても、もう一方の表示は自動的に閉じます。

## 公式機能（/dispatch・/remote-control）との違い

Claude Code を遠隔から扱う公式機能として **/dispatch**（Cowork 経由）と **/remote-control**（Claude Code v2.1.51+）が提供されていますが、本ツールは **承認ダイアログのみ** を遠隔化する点で立ち位置が異なります。

| ツール | 遠隔化する対象 | リモート側でできること | 通信経路 | 必要なプラン |
|---|---|---|---|---|
| **本ツール** | 承認ダイアログだけ | Yes / No（1 / 2 / 3 相当） | 自分の PC ⇄ ngrok ⇄ 自分のスマホ | 不要（OSS・自前ホスト） |
| **/dispatch**（Cowork） | 新規タスクの投入口 | 「これやって」と投げる、cron 的なスケジュール投入 | Anthropic クラウド経由 | Claude アカウント |
| **/remote-control** | PC 上で動作中のセッション全体 | プロンプト送信・出力閲覧などほぼフル操作 | Anthropic クラウド経由 | Pro / Max / Team / Enterprise（API キー不可） |

### プロジェクトをまたいで使えるか

複数プロジェクトを並行して走らせる運用では、各機能の挙動が大きく異なります。

- **本ツール**: サーバーと ngrok は 1 組だけ起動し、各プロジェクトで `claude-wrapper.js` を立ち上げれば **すべての依頼が同じ承認パネルに集約** されます（`[projectName][toolName]` 形式で識別）。スマホ 1 画面で複数プロジェクトの承認を一括で捌ける点が最大の強みです。
- **/dispatch**: スマホから投げたタスクごとに Anthropic 側が適切なセッションを spawn します。**プロジェクトごとに別セッション** が立つため、結果はセッションを切り替えて確認する形になります。
- **/remote-control**: 1 つの Claude Code プロセスは 1 つのリモートセッションを持ちます（`claude remote-control` のサーバーモードなら 1 プロセスで最大 32 セッションまで扱えますが、いずれも **同じ cwd を共有** します）。異なるプロジェクトをまたぐ場合は **プロジェクトごとに `claude remote-control` を起動** し、claude.ai/code のセッションリストで切り替える運用になります。

### 使い分けの目安

- **承認だけ外出先で捌きたい、操作は PC で完結している** → 本ツールが最軽量
- **外から新しい仕事を投げて結果だけ受け取りたい** → `/dispatch`
- **外からも腰を据えて Claude Code を操作したい** → `/remote-control`（プラン要件を満たす場合）

3 つは競合というよりレイヤーが違うため、たとえば「PC 上で `/remote-control` を使いつつ、承認だけ本ツールでスマホへ転送」のような併用も技術的には可能です（ただし承認イベントは片方に集約した方が運用上は分かりやすくなります）。

## 構成

```
approval-server.js              承認キューを管理する HTTP サーバー（127.0.0.1 のみに公開）
claude-wrapper.js               Claude Code CLI を PTY で包んでダイアログを検出するラッパー
approval-ui.html                PC ブラウザ・スマートフォン兼用 Web UI
approval-config.example.json    設定ファイルのサンプル
approval-config.json            ポートとトークンを保存する設定ファイル（gitignore 済み）
```

## 必要なもの

- Node.js 18 以上（インストール例: [nvm](https://github.com/nvm-sh/nvm)）
- [ngrok](https://ngrok.com/) アカウント（無料枠で動作。インストールと authtoken 登録の手順はセットアップのステップ 4 で説明）
- `node-pty` をネイティブビルドできる環境
  - **Windows**: Python 3 と Visual Studio Build Tools（Desktop development with C++）
  - **macOS**: `xcode-select --install`
  - **Linux**（WSL2 Ubuntu 含む）: `build-essential`（`make` / `g++` / `gcc` を含むメタパッケージ）と `python3`

Node.js 22 など主要バージョンでは事前ビルド済みバイナリが使われる場合もあり、その場合はビルドツールは不要です。

## セットアップ

### 1. クローン＆インストール

```bash
git clone https://github.com/YATA-NODE/claude-approval-server.git
cd claude-approval-server
npm install
```

### 2. 設定ファイルを作成

`approval-config.example.json` を `approval-config.json` にコピーし、`token` を推測困難な長いランダム文字列に書き換えます。

```json
{
  "port": 3000,
  "token": "ここに 32 バイト以上のランダム文字列"
}
```

- `approval-config.json` は `.gitignore` 済みです。公開リポジトリに push されません。
- ポートを変えたい場合は `port` を任意の値に変更してください。
- 設定ファイルを作らなくても、環境変数 `APPROVAL_PORT` / `APPROVAL_TOKEN`、あるいはデフォルト値（ポート 3000・起動ごとにランダム生成されるトークン）で動作します。
- 優先順位:
  - **PORT**: `APPROVAL_PORT`（env）→ `approval-config.json` の `port` → 3000
  - **TOKEN**: `approval-config.json` の `token` → `APPROVAL_TOKEN`（env）→ 起動ごとのランダム値
  - PORT は env 優先（ポート衝突時などに一時的に切り替えやすい）、TOKEN は config 優先（長期固定値として扱うため、無関係な env で上書きされない）

### 3. 承認サーバーを起動

専用ターミナルを開いて起動します（プロジェクト作業用とは別のターミナル）。

```bash
node approval-server.js
```

起動時にコンソールに `SECRET_TOKEN` が表示されます。この値はスマートフォン UI に入力します。

```
✅ Approval server running on http://127.0.0.1:3000 (loopback only)

🔑 SECRET_TOKEN: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

サーバーは `127.0.0.1` のみにバインドされ、LAN 上の他端末からは直接アクセスできません。外部アクセスは必ず ngrok トンネル経由になります。

### 4. ngrok をセットアップしてトンネルを開く

#### 4-1. 初回のみ: インストールと authtoken 登録

1. [ngrok 公式](https://ngrok.com/download) の手順に従って ngrok をインストール（macOS は `brew install ngrok`、WSL2 / Linux と Windows は公式ページに表示されるコマンドをそのまま実行）
2. [https://dashboard.ngrok.com/signup](https://dashboard.ngrok.com/signup) でアカウントを作成
3. [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) ページで authtoken をコピー
4. ローカルに登録（一度実行すれば永続化されます）

```bash
ngrok config add-authtoken <YOUR_AUTHTOKEN>
```

#### 4-2. 毎回: トンネルを開く

別のターミナルで実行します。

```bash
ngrok http 3000
```

表示された `https://xxxx.ngrok-free.app` をメモしておきます（スマホ UI に入力します）。

### 5. 承認パネルをブラウザで開く

| 端末 | URL |
|------|-----|
| PC ブラウザ | `http://localhost:3000` |
| スマートフォン | `https://xxxx.ngrok-free.app`（ngrok が表示した URL） |

URL と `SECRET_TOKEN` を入力して接続します。設定は `localStorage` に保存されるので次回以降は自動入力されます。

> WSL2 で承認サーバーを起動した場合も、Windows 側のブラウザから `http://localhost:3000` でそのままアクセスできます（WSL2 の localhost forwarding により）。

### 6. Claude Code をラッパー経由で起動

プロジェクト用ターミナルで **対象プロジェクトに `cd` してから** ラッパーを実行します。コマンドのパスはラッパーの配置場所を指すだけで、Claude Code 自身は「いま `cd` しているディレクトリ」で起動します。

```bash
cd /path/to/my-project
node /path/to/claude-approval-server/claude-wrapper.js
```

シェルにエイリアスを登録しておくと、任意のプロジェクトで `claude` と打つだけで起動できます。

```bash
# ~/.bashrc / ~/.zshrc など
alias claude='node /path/to/claude-approval-server/claude-wrapper.js'

# 使い方
cd /path/to/my-project
claude
```

起動時にラッパーが認識したプロジェクト名が表示されます。

```
[wrapper] project="my-project" (cwd=/path/to/my-project)
```

以降、Claude Code の承認ダイアログはすべて承認パネルにも転送されます。依頼には `[プロジェクト名][ツール名]` の形式でプロジェクトが表示され、複数プロジェクトを同時に動かしていてもスマホ側でどこから来た依頼か識別できます。

## 毎回の起動・停止手順

初回以降は以下の順で操作します。

### 起動順序

1. **ターミナル A** — 承認サーバー `node approval-server.js`
2. **ターミナル B** — `ngrok http 3000`
3. スマホ／PC ブラウザで承認パネルに接続
4. **ターミナル C 以降** — プロジェクトに `cd` してから `node /path/to/claude-wrapper.js`（または `claude` エイリアス）で起動。複数プロジェクトを同時に立ち上げて OK で、依頼はすべて同じ承認パネルに集まります（`[projectName]` prefix で識別）

### 停止順序

1. 各ラッパー（Claude Code）を終了（`/exit` または `Ctrl+C`）
2. ngrok を停止（`Ctrl+C`）← **先に止める**（外部アクセスを閉じる）
3. 承認サーバーを停止（`Ctrl+C`）

## 仕組み

```
┌──────────────┐         ┌──────────────────┐         ┌────────────┐
│ Claude Code  │ ─PTY─→ │  claude-wrapper  │ ─HTTP→ │  approval- │
│     TUI      │ ←─────  │      .js         │ ←──────  │  server.js │
└──────────────┘         └──────────────────┘         └─────┬──────┘
                                                            │ ngrok
                                                            ↓
                                                      ┌──────────────┐
                                                      │ Smartphone / │
                                                      │ PC browser   │
                                                      └──────────────┘
```

1. ラッパーが PTY 出力から `Do you want to ...?` を検出
2. approval-server に `POST /request` を送り、id を受け取る
3. スマホ／PC ブラウザが `GET /queue` で取得し UI に表示
4. どこかで応答（`POST /resolve/:id`）が入ると、サーバーの long-poll が即座に返答
5. ラッパーが `1\r` などを PTY に注入、Claude Code 本体が実行
6. 逆に PC ターミナルで直接応答された場合、ラッパーはダイアログ消失を検知して `resolvedBy=cli` で resolve。スマホ側の表示も閉じる

## セキュリティ

- **127.0.0.1 バインド**: 承認サーバーはループバックのみ受け付け、外部アクセスは ngrok 経由のみ
- **トークン認証**: 全 API で `x-secret-token` ヘッダー必須。`crypto.timingSafeEqual` でタイミング攻撃に耐性あり
- **レート制限**: 認証失敗が 60 秒あたり 10 回を超えた IP は 10 分間ブロック
- **入力サニタイズ**: `description` は 500 文字、`options` は 8 件 × 100 文字まで。余剰は切り詰め
- **注入ホワイトリスト**: ラッパーが PTY に書き込むのは、承認パネル側 answer が `1` / `2` / `3` または `options` の完全一致だった場合のみ。任意キー注入を防止
- **設定ファイル**: `approval-config.json` は `.gitignore` 済み。リポジトリにトークンを漏らしません
- **ngrok URL 漏洩対策**: ngrok URL は毎セッション変わります。使用後はトンネルを閉じてください

## スマートフォン UI の機能

- 承認待ちキューの一覧表示（手動取得）
- 個別・一括の承認／拒否
- 履歴表示（直近 20 件、承認元が `PC` / `スマホ` / `CLI` で識別可能）
- プロジェクト識別（`[プロジェクト名][ツール名] 引数 — プロンプト` 形式で表示）
- 日本語 / 英語 切替
- ダーク / ライト テーマ切替

## 複数プロジェクト同時利用

サーバーと ngrok は 1 組だけ起動し、各プロジェクト用ターミナルで `cd` してからラッパーを起動します。

```
ターミナル A: node approval-server.js           ← 1 回だけ
ターミナル B: ngrok http 3000                   ← 1 回だけ
ターミナル C: cd /path/to/project-a && claude
ターミナル D: cd /path/to/project-b && claude
```

依頼はすべて同じ承認パネルに集まり、`[project-a][Bash] ...` / `[project-b][Write] ...` のようにプロジェクト名で識別できます。プロジェクト名はラッパーの cwd（`process.cwd()` の basename）から自動取得されます。

## トラブルシューティング

### `npm install` が `node-pty` のビルドで失敗する

OS ごとのビルド環境を確認してください。

- **Windows**: Python 3 と Visual Studio Build Tools（Desktop development with C++）をインストール
- **macOS**: `xcode-select --install` を実行
- **Linux**（WSL2 Ubuntu 含む）: `sudo apt install build-essential python3`（`build-essential` は `make` / `g++` / `gcc` を含むメタパッケージ）

### スマホに承認依頼が届かない

1. `approval-config.json` の `port` と `ngrok` のポート番号が一致しているか
2. 承認サーバー起動時のコンソール表示に `SECRET_TOKEN` が出ているか、スマホ UI に入れたトークンと一致しているか
3. ngrok の URL が正しいか（セッションごとに変わります）

### PC ターミナルのダイアログが承認パネルに転送されない

`claude` ではなく `claude-wrapper.js` 経由で Claude Code を起動しているか確認してください。素の `claude` を起動したセッションは対象外です。

### ツール名が `[Unknown]` と表示されることがある

ConPTY（Windows）をはじめ、PTY はダイアログを複数フレームに分けて描画します。ツール名を含む行が遅れて届くと、先に検出した「プロンプトのみ」のフレームで依頼を登録し、同一ダイアログの再描画は dedup で無視するため、サーバー側の表示は `[Unknown]` のままになります。承認・拒否の動作には影響しません。重複登録の発生よりもこちらを許容する設計です。

### 旧バージョン（v1.3.0 以前）からの移行

v1.3.0 以前で提供していた `PreToolUse` フック方式（`claude-hook.js`）は v1.4.0 で PTY ラッパー方式に刷新され、v1.7.0 でファイル自体が削除されました。過去に導入していた場合は `~/.claude/settings.json` などから該当の `PreToolUse` エントリを削除してください。以降は本 README ステップ 6 の手順で `claude-wrapper.js` 経由で Claude Code を起動してください。

## 対応プラットフォーム

| 項目 | 確認済み | 未確認 |
|------|----------|--------|
| OS | Windows 11、Linux（WSL2 Ubuntu） | macOS、ネイティブ Linux |
| Node.js | v20.20.2、v22 | その他のバージョン |
| Claude Code | CLI | — |
| スマホブラウザ | iOS Safari、Android Chrome | その他 |

## ライセンス

MIT License — Copyright (c) 2026 sta29697

使用ライブラリのライセンス:
- [express](https://github.com/expressjs/express) — MIT
- [cors](https://github.com/expressjs/cors) — MIT
- [node-pty](https://github.com/microsoft/node-pty) — MIT

---

# claude-approval-server (English)

A tool that forwards Claude Code's approval dialogs to **both the PC terminal and a smartphone (or PC browser)**, letting you approve or reject from either side.

A PTY wrapper sits between Claude Code and the terminal: when an approval dialog appears,

- it is shown in the PC terminal as usual (press `1` / `2` / `3`), and
- **simultaneously** pushed to the approval panel on smartphone / PC browser.

Whichever side responds first dismisses the other side automatically.

## How this differs from the official `/dispatch` and `/remote-control`

Claude Code now ships two official ways to use it remotely — **/dispatch** (via Cowork) and **/remote-control** (Claude Code v2.1.51+). This tool occupies a different niche: it forwards **only the approval dialog**, nothing else.

| Tool | What it forwards | What you can do remotely | Transport | Plan |
|---|---|---|---|---|
| **This tool** | Approval dialogs only | Yes / No (1 / 2 / 3) | Your PC ⇄ ngrok ⇄ your phone | None (OSS, self-hosted) |
| **/dispatch** (Cowork) | Submission of new tasks | "Do this for me", cron-style scheduling | Through Anthropic cloud | Claude account |
| **/remote-control** | The full session running on your PC | Send prompts, view output, near-full control | Through Anthropic cloud | Pro / Max / Team / Enterprise (no API key) |

### Working across multiple projects

How each option handles parallel projects differs significantly.

- **This tool**: run the server and ngrok once, then launch `claude-wrapper.js` from inside each project. **All requests aggregate into the same approval panel**, tagged as `[projectName][toolName]`. Handling approvals from every concurrently running project on a single phone screen is the headline feature.
- **/dispatch**: every task you send from the phone causes Anthropic to spawn an appropriate session. **Each project ends up in its own session**, so you switch between sessions in the app to check results.
- **/remote-control**: one Claude Code process owns one remote session (server mode `claude remote-control` can host up to 32 sessions per process, but they all **share the same cwd**). For distinct projects you start `claude remote-control` **once per project** and switch between them in the claude.ai/code session list.

### Which one to pick

- **You just want to handle approvals from your phone while everything else stays on the PC** → this tool is the lightest option.
- **You want to fire off new tasks from your phone and get results back** → `/dispatch`.
- **You want full interactive control from outside** → `/remote-control` (if your plan qualifies).

The three are not competitors so much as different layers, so combinations like "drive the session via `/remote-control` on the road, with approvals mirrored to your phone via this tool" are technically possible — though in practice it's cleaner to route approval events through one channel only.

## Structure

```
approval-server.js              HTTP server that manages the approval queue (bound to 127.0.0.1 only)
claude-wrapper.js               Wraps the Claude Code CLI via PTY and detects approval dialogs
approval-ui.html                Web UI shared by PC browser and smartphone
approval-config.example.json    Sample config file
approval-config.json            Your local config (port + token); gitignored
```

## Requirements

- Node.js 18+ (install example: [nvm](https://github.com/nvm-sh/nvm))
- [ngrok](https://ngrok.com/) account (free tier is fine; install + authtoken steps are covered in setup step 4 below)
- A toolchain that can build `node-pty`
  - **Windows**: Python 3 and Visual Studio Build Tools (Desktop development with C++)
  - **macOS**: `xcode-select --install`
  - **Linux** (incl. WSL2 Ubuntu): `build-essential` (a metapackage that bundles `make` / `g++` / `gcc`) and `python3`

Prebuilt binaries exist for common Node versions (e.g. 22), so in practice you often do not need to build.

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YATA-NODE/claude-approval-server.git
cd claude-approval-server
npm install
```

### 2. Create a config file

Copy `approval-config.example.json` to `approval-config.json` and replace `token` with a long random string.

```json
{
  "port": 3000,
  "token": "REPLACE-WITH-A-32-BYTE-RANDOM-STRING"
}
```

- `approval-config.json` is gitignored; your token never leaves your machine.
- You can also use the environment variables `APPROVAL_PORT` / `APPROVAL_TOKEN`, or the defaults (port 3000 and a freshly random token each start).
- Resolution order:
  - **PORT**: `APPROVAL_PORT` (env) → `approval-config.json` `port` → `3000`
  - **TOKEN**: `approval-config.json` `token` → `APPROVAL_TOKEN` (env) → random value per start
  - PORT favors env so you can override on a per-session basis (port collisions, multi-instance). TOKEN favors the config file so a stray env var cannot shadow your long-term secret.

### 3. Start the approval server

Open a dedicated terminal (separate from your project terminals) and run:

```bash
node approval-server.js
```

The console prints `SECRET_TOKEN` at startup — you will enter this value in the smartphone UI.

```
✅ Approval server running on http://127.0.0.1:3000 (loopback only)

🔑 SECRET_TOKEN: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The server binds to `127.0.0.1` only; other devices on the LAN cannot reach it directly. External access must go through ngrok.

### 4. Set up ngrok and open the tunnel

#### 4-1. First time only: install and register the authtoken

1. Install ngrok via [the official download page](https://ngrok.com/download) (`brew install ngrok` on macOS; WSL2 / Linux and Windows have copy-paste commands on that page).
2. Sign up at [https://dashboard.ngrok.com/signup](https://dashboard.ngrok.com/signup).
3. Copy your authtoken from [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken).
4. Register it locally (run once; the token is persisted):

```bash
ngrok config add-authtoken <YOUR_AUTHTOKEN>
```

#### 4-2. Each time: open the tunnel

In another terminal:

```bash
ngrok http 3000
```

Note the `https://xxxx.ngrok-free.app` URL — you'll enter it in the smartphone UI.

### 5. Open the approval panel

| Device | URL |
|--------|-----|
| PC browser | `http://localhost:3000` |
| Smartphone | `https://xxxx.ngrok-free.app` |

Enter the URL and `SECRET_TOKEN` to connect. Values are stored in `localStorage` and auto-filled on subsequent visits.

> If you run the approval server inside WSL2, the Windows-side browser can still open `http://localhost:3000` directly thanks to WSL2's localhost forwarding.

### 6. Launch Claude Code through the wrapper

In your project terminal, **`cd` into the target project first**, then run the wrapper. The path on the command line merely points at the wrapper's install location — Claude Code itself starts in whichever directory you are currently `cd`-ed into.

```bash
cd /path/to/my-project
node /path/to/claude-approval-server/claude-wrapper.js
```

Aliasing makes it a one-word command in any project:

```bash
# ~/.bashrc / ~/.zshrc
alias claude='node /path/to/claude-approval-server/claude-wrapper.js'

# Usage
cd /path/to/my-project
claude
```

At startup the wrapper prints the project name it picked up:

```
[wrapper] project="my-project" (cwd=/path/to/my-project)
```

From then on, every Claude Code approval dialog is mirrored to the approval panel, prefixed with `[projectName][toolName]` so you can tell which project each request came from when multiple projects are running at once.

## Daily startup / shutdown

After the one-time setup:

### Startup

1. **Terminal A** — `node approval-server.js`
2. **Terminal B** — `ngrok http 3000`
3. Connect the smartphone / PC browser to the approval panel
4. **Terminal C onward** — `cd` into the project, then start Claude Code with `node /path/to/claude-wrapper.js` (or the `claude` alias). Run as many as you like in parallel — every request lands in the same approval panel, tagged with the project name.

### Shutdown

1. Exit each wrapper / Claude Code (`/exit` or `Ctrl+C`)
2. Stop ngrok (`Ctrl+C`) ← **stop this first** to close external access
3. Stop the approval server (`Ctrl+C`)

## How it works

```
┌──────────────┐         ┌──────────────────┐         ┌────────────┐
│ Claude Code  │ ─PTY─→ │  claude-wrapper  │ ─HTTP→ │  approval- │
│     TUI      │ ←─────  │      .js         │ ←──────  │  server.js │
└──────────────┘         └──────────────────┘         └─────┬──────┘
                                                            │ ngrok
                                                            ↓
                                                      ┌──────────────┐
                                                      │ Smartphone / │
                                                      │ PC browser   │
                                                      └──────────────┘
```

1. The wrapper watches PTY output for `Do you want to ...?`
2. It posts `POST /request` to the approval server and gets an id
3. The approval panel fetches `GET /queue` and shows the request
4. When either side resolves via `POST /resolve/:id`, the server's long-poll returns immediately
5. The wrapper injects `1\r` (or `2`/`3`) into the PTY and Claude Code proceeds
6. If the user answers directly in the PC terminal, the wrapper detects the dialog disappearing and resolves the entry with `resolvedBy=cli`, clearing it from the panel

## Security

- **Loopback bind**: the approval server listens on `127.0.0.1` only. External access requires ngrok.
- **Token auth**: every API requires the `x-secret-token` header. Compared with `crypto.timingSafeEqual` to resist timing attacks.
- **Rate limiting**: an IP with 10+ auth failures per 60s is blocked for 10 minutes.
- **Input sanitization**: `description` is capped at 500 chars, `options` at 8 items × 100 chars.
- **Injection whitelist**: the wrapper only writes to the PTY when the panel's answer is `1` / `2` / `3` or an exact match of an `options` entry — arbitrary keystrokes cannot be injected.
- **Config file**: `approval-config.json` is gitignored so the token never leaks into a public repo.
- **ngrok URL rotation**: the public URL changes each session. Close the tunnel when you're done.

## Smartphone UI features

- Manual-fetch queue view of pending requests
- Per-request approve / reject and bulk approve
- History view (last 20 resolved items, labeled `PC` / `smartphone` / `CLI`)
- Project identification (requests are rendered as `[projectName][toolName] args — prompt`)
- Japanese / English toggle
- Dark / light theme toggle

## Running multiple projects simultaneously

Run the server and ngrok once, then launch each wrapper from inside its own project directory:

```
Terminal A: node approval-server.js           ← once
Terminal B: ngrok http 3000                   ← once
Terminal C: cd /path/to/project-a && claude
Terminal D: cd /path/to/project-b && claude
```

All requests land in the same panel, tagged like `[project-a][Bash] ...` / `[project-b][Write] ...`. The project name is derived automatically from the wrapper's cwd (the `basename` of `process.cwd()`).

## Troubleshooting

### `npm install` fails building `node-pty`

Install the native build prerequisites for your OS:

- **Windows**: Python 3 + Visual Studio Build Tools (Desktop development with C++)
- **macOS**: `xcode-select --install`
- **Linux** (incl. WSL2 Ubuntu): `sudo apt install build-essential python3` (`build-essential` is a metapackage that bundles `make` / `g++` / `gcc`)

### The smartphone never sees an approval request

1. Check that `approval-config.json`'s `port` matches the port given to `ngrok`.
2. Check that the token entered on the phone matches the server's `SECRET_TOKEN` (printed at startup).
3. Make sure the ngrok URL you entered is the current one (it changes each session).

### The PC terminal dialog isn't forwarded to the panel

Make sure you launched Claude Code through `claude-wrapper.js`, not plain `claude`. Sessions started outside the wrapper are not observed.

### Tool name sometimes shows as `[Unknown]`

PTYs (ConPTY on Windows especially) render the approval dialog across multiple frames. If the frame containing the tool-name line arrives after the prompt line, the wrapper registers the request from the earlier "prompt only" frame and treats subsequent frames as redraws via dedup, so the server keeps the `[Unknown]` label. Approve / reject still works correctly. This trade-off is intentional — preferable to duplicate registrations.

### Migrating from earlier versions (v1.3.0 and older)

Versions v1.3.0 and earlier shipped a `PreToolUse` hook (`claude-hook.js`). That approach was replaced with the PTY wrapper in v1.4.0, and the file itself was removed in v1.7.0. If you previously registered the hook, delete the corresponding `PreToolUse` entry from `~/.claude/settings.json` (or any project-local `settings` file). From now on, start Claude Code through `claude-wrapper.js` as described in step 6 above.

## Supported platforms

| Item | Verified | Unverified |
|------|----------|------------|
| OS | Windows 11, Linux (WSL2 Ubuntu) | macOS, native Linux |
| Node.js | v20.20.2, v22 | other versions |
| Claude Code | CLI | — |
| Mobile browser | iOS Safari, Android Chrome | others |

## License

MIT License — Copyright (c) 2026 sta29697

Dependency licenses:
- [express](https://github.com/expressjs/express) — MIT
- [cors](https://github.com/expressjs/cors) — MIT
- [node-pty](https://github.com/microsoft/node-pty) — MIT
