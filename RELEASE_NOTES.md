# Release Notes

This file keeps version-specific history out of the README. Japanese and English notes are both maintained below.

---

# リリースノート（日本語）

## v1.18.0+

- codex プランモード質問の自由記入（`None of the above … add details in notes (tab)`）をスマホのテキスト入力から送信できるようにしました（単一質問のみ対応）。

## v1.17.0+

- codex CLI のプランモード選択肢質問に対応しました。
- 単一質問（`Question 1/1`）と複数質問フロー（`Question 1/N`、`enter to submit all`）をスマホのタブ UI で回答できます。
- codex のコマンド承認で、実行されるコマンド本文をスマホ側に表示するようにしました。

## v1.16.0+

- OpenAI codex CLI をラッパー経由で起動できるようにしました。
- codex のコマンド承認（`Would you like to run the following command?`）をスマホから承認 / 拒否できます。
- codex の承認注入は、option ラベル末尾の `(y)` / `(p)` / `(esc)` から抽出したショートカットキーで行います。

## v1.14.0+

- Claude Code のプラン承認（ExitPlanMode、`Would you like to proceed?`）をスマホへ転送できるようにしました。
- 終端マーカーが `Esc to cancel` ではなく `shift+tab to approve` のプロンプトにも対応しました。

## v1.13.0+

- 複合質問 / フリーテキスト履歴について、履歴カードのタップ展開で選択肢や入力本文を確認できるようにしました。
- 入力本文はブラウザメモリだけに保持され、`localStorage` には保存されません。リロード、タブ終了、または 1 時間 TTL で消えます。

## v1.12.0+

- `Type something` のテキスト送信に対応しました。
- スマホから Esc 相当でダイアログを閉じるキャンセルボタンを追加しました。
- `Chat about this` を遠隔操作の対象から除外し、サーバー側でも拒否するようにしました。
- 静的配信を `/` の `approval-ui.html` に限定し、`approval-config.json` などの直接配信を防ぎました。

## v1.11.0+

- 複数質問を 1 ダイアログにまとめたタブ式 AskUserQuestion に対応しました。

## v1.10.0+

- Claude Code の AskUserQuestion に対応しました。

---

# Release Notes (English)

## v1.18.0+

- Free-text notes for codex plan-mode questions (`None of the above … add details in notes (tab)`) can be entered from the phone and sent back to codex (single questions only).

## v1.17.0+

- Added support for codex CLI plan-mode choice questions.
- Single questions (`Question 1/1`) and multi-question flows (`Question 1/N`, `enter to submit all`) can be answered from the tabbed phone UI.
- codex command approvals now show the command body on the phone before approval.

## v1.16.0+

- Added support for launching OpenAI codex CLI through the wrapper.
- codex command approvals (`Would you like to run the following command?`) can be approved / rejected from the phone.
- codex approval injection uses shortcut keys extracted from trailing option labels such as `(y)`, `(p)`, or `(esc)`.

## v1.14.0+

- Added forwarding for Claude Code plan approval prompts (ExitPlanMode, `Would you like to proceed?`).
- Added detection for prompts whose footer uses `shift+tab to approve` instead of `Esc to cancel`.

## v1.13.0+

- Multi-question and free-text history cards can be expanded to inspect selections and typed text.
- Typed bodies are held only in browser memory, never in `localStorage`, and are cleared on reload, tab close, or after a 1-hour TTL.

## v1.12.0+

- Added `Type something` free-text submission.
- Added a phone-side Cancel button that sends an Esc-equivalent action to the dialog.
- Blocked `Chat about this` from remote operation in both the UI and server validation.
- Restricted static serving to `/` for `approval-ui.html`, preventing direct access to files such as `approval-config.json`.

## v1.11.0+

- Added tabbed AskUserQuestion support for multiple questions grouped into one dialog.

## v1.10.0+

- Added support for Claude Code AskUserQuestion dialogs.
