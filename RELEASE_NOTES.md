# Release Notes

This file keeps version-specific history out of the README. Japanese and English notes are both maintained below.

---

# リリースノート（日本語）

## v1.22.0+

- **`1)` 区切りのダイアログで選択肢ラベルの先頭に `)` が残る不具合を修正しました**。先頭ノイズ除去がドットと空白しか落とさなかったため、`1)` 区切りでは全ラベルが `) …` の形になり、完全一致で判定する 2 つの防御(「Chat about this」を指す回答の拒否 / 自由記入の添付を「Type something」に限定)が無言で外れていました(前者は安全側の判定が効かなくなる方向)。ラベルの生成点で区切り残渣を落とす最小修正です。
- **終了確認画面の判定文言を設定で追記できるようになりました**(`dialogDetection.exitConfirmPhrases`、配列・リテラル扱い)。**追記専用**で、既定の 2 文言は設定では無効化できません(誤設定で危険な画面の転送が再開する口を作らないため)。4 文字未満・200 文字超・17 件目以降は無視され起動時に警告が出ます(短い文言は前方一致ゆえ通常の質問まで止めるため)。CLI の文言変更・多言語化への追従用です。
- **起動時に対象 CLI のバージョンを検証済みバージョンと照合し、minor / major が進んでいる場合は stderr に 1 行警告します**(CLI バージョン canary)。ダイアログ判定は CLI の画面文言に依存し、文言が変わると検出が例外なく外れるため、その前提条件(CLI が検証版より進んだ)を起動時に知らせます。起動は止めません。patch 先行と取得失敗はラッパーログのみです。
- **prompt と選択肢の「枠所属」を観測する shadow モードを追加しました**(挙動不変)。終了確認画面が転送された真因 = prompt を「窓内の最後の `?`」でさかのぼるため別の枠の残存テキストを prompt に採用しうる、の構造的対策の準備として、非一貫なフレームをラッパーログに `frame-shadow` 行で記録だけします。実測を見てから将来のリリースで enforce を判断します。
- 実機フレームの回帰テストを追加しました(claude 2.1.237 の終了確認画面の録画 fixture)。この録画で、**2.1.237 の終了確認は選択肢 2 つ(`Exit and stop tasks` / `Stay`)に変わっており**(v1.21.1 実装時は 3 択)、既知 2 文言のどちらか 1 つで転送を止める v1.21.1 の設計が実際の文言変更に耐えたことを確認しています。
- そのほか: 転送しない理由の一覧に `ambiguous-box` の説明文言を追加(ログの表示のみ)。なお canary の追加により、起動時に対象 CLI の `--version` 取得(実測 0.5〜2.2 秒、環境負荷で変動、待ちの上限 10 秒)が加わります(サーバー疎通確認とは並行実行)。

## v1.21.1+

- **セッション終了の確認画面(`Exit and stop tasks` / `Move to background and exit` / `Stay`)がスマホへ転送されなくなりました**。この画面は承認ではありませんが、「選択肢 1〜N + 終端マーカー」という承認枠と同じ構造を持ち、ツール承認のシグナルがどれも立たないため、これまで `AskUserQuestion` として転送されていました。スマホから承認すると選択肢 1(= セッションの終了)が PC 側に注入されるため、読めても転送しない扱いに変えています。`Exit and stop tasks` / `Move to background and exit` はこの画面以外にまず現れないため、どちらか 1 つが読めた時点で止めます(選択肢が 1 行しか描かれていない途中のフレームでも取り逃さないため)。`Stay` は通常の質問にも出る語なので判定には使いません。判定は「転送してよいか」を決める 1 箇所で行うため、承認枠の上に `● Tool(...)` 行があるフレームでも同じように止まります。**この画面が出たときは PC 側で操作してください**。
- 転送を止めた理由はラッパーのログに `承認可能化しない(exit-confirm: …)` として記録されます(`APPROVAL_WRAPPER_LOG` 設定時)。

## v1.21.0+

- タブ式複合質問を巡回した後、確認画面から戻れず転送を諦めたときに、スマホへ「PC で操作してください」という notice カードを表示するようになりました。notice は承認ではなく、選択肢・自由記入・タブを持たない一方向の情報表示で、「確認しました」で消えるだけです（PTY への注入経路には接続しません）。PC 側でタブ UI が消えたとき / wrapper 側の 30 分 TTL / サーバー側の backstop（pending 60 分経過後、次回 GC 走査で削除。GC は 5 分間隔のため通常最大 65 分程度）のいずれかで自動的に消えます。
- 確認画面から先頭タブへ戻る Shift+Tab（借り返し）にも、背景色セルの属性検証が必須になりました（R2）。従来は借りがあれば属性検証より先に許可していましたが、「属性を確認できないフレームでは Shift+Tab を送らない」を例外なしの不変条件にするための変更です。代償として、確認画面で属性が読めない過渡フレームでは戻れなくなりますが、その場合は上記の notice で PC 操作を案内します（録画 corpus の再生で確認画面フレームはすべて属性が読め、通常運用での可用性低下は観測されていません）。
- wrapper の全 HTTP 呼び出し（`httpRequestReal`）に、呼び出し開始を起点とする絶対 deadline（既定 70 秒）を追加しました。従来の `timeout` は無応答が続いた時間だけを見る非活動タイマーだったため、断続的に応答が来る相手だと打ち切られないことがありました。利用者の操作には影響しません。
- 同じ関数に、1 回の応答につき 1MB の受信上限を追加しました。超過した応答は切断され、その呼び出しは失敗として扱われます(正当な応答はキュー全件でも数十 KB 程度のため、通常運用での影響は想定していません)。
- 内部関数 `barRowIsCliDrawn` を `barRowHasStyledCells` に改名しました（挙動は変わりません）。

## v1.20.0+

- MCP ツールの承認枠（ラベル行 `Tool use`）を同定し、`tool='MCP'` として枠内の対象行（`サーバ名 - ツール名(引数)`）をスマホへ転送できるようにしました。実測は 2 サーバ × 3 ツールでラベルの verbatim 一致を確認した範囲です（他ベンダ製サーバ・ロケール差・CLI バージョン依存は未確認）。
- ラベルでも `● Tool(...)` 行でも同定できない承認枠は転送しなくなりました（fail-close）。**従来 `tool='Unknown'` のまま転送されていた承認は、このバージョンからスマホに出なくなり、PC 側での操作が必要になります**。タブ巡回・Shift+Tab の挙動は変わりません。
- `npm test` に公開物向けの PII スキャナ（home パス内のユーザー名など環境由来識別子を検出）を追加し、GitHub Actions（check 名 `pii-and-tests`）で PR ごとに実行するようにしました。開発者向けの変更で、利用者側の挙動には影響しません。

## v1.19.0+

- タブ式の複合質問（AskUserQuestion）が出ているときに、PC 側で回答するとタブが勝手に回り続ける不具合を修正しました。タブの巡回は「1 回の出現につき 1 回」だけになります。
- 巡回中に PC でキーを押すと、巡回を即中断するようにしました。中断直後の短い間は確定キー（Enter / 数字）を破棄します（ラッパーが送った Tab は取り消せず、そのまま流すと移動先のタブで確定してしまうため）。`Ctrl-C` と単独の `Esc` は常に届きます。
- 全タブを読み取れなかったときは、スマホへ転送せず PC 側で回答する動作に変えました（半端な登録による回答位置のずれを防ぐため）。このとき「表示中の 1 タブだけ」が単一質問として転送されることもありません。
- スマホからの回答を注入する直前に、タブバーが巡回時と同じか / 先頭タブにいるかを確認するようにしました。確認できないときは注入せずスマホへ再提示します。
- ただし **PC 側で先に回答が進んでいた場合は、再提示せずスマホの依頼を取り下げます**。この場合スナップショットが古くなっていて何度送り直しても弾かれるため、そのまま PC 側で回答してください。
- 位置の確認中に PC でキーを押しても入力が飲み込まれなくなりました（確認は中断され、押したキーは押し直しになります）。
- PC 側で回答し終えた依頼がスマホに残り続けることがある不具合を修正しました。画面が別のダイアログに入れ替わった時点で、古い依頼を確実に取り下げます。
- `Type something` の入力中や Submit にフォーカスがある間に、依頼が時間経過で失効することがなくなりました。
- **タブ巡回は「タブバーが出現時から動いていない」ときだけ始まるようになりました**。従来は PC 側で回答した直後でも巡回を始めてしまい、Shift+Tab で先頭タブへフォーカスを引き戻していました(回答した直後に「何もしていないのにタブが戻る」状態)。PC 側で 1 問でも答えるとタブバーの表示が変わるため、以降そのダイアログにはキーを一切送らず、スマホへも転送されません。**タブ式をスマホで回答したい場合は、ダイアログが出てから 1〜2 秒ほど PC 側で操作せずに待ってください**。
- タブバーの見つけ方を、画面下端のフッタを起点にする方式へ変えました。会話ログに番号付きの箇条書きが流れているだけでタブ式の質問が転送されなくなる問題が解消します。逆に、タブバーらしい行が複数見えて本物を特定できないときは、転送せず PC 側で回答する動作になります。
- チェックリスト（`☒` / `☐` の並び）が表示されている間に、通常の承認がスマホへ転送されないことがある問題を修正しました。
- プランの承認画面（`shift+tab to approve`）では、ラッパーが Shift+Tab を一切送らないようにしました。このキーはプラン承認の確定操作にあたるためです。
- codex のコマンド承認で、コマンドが折り返して表示されているとスマホ側に 1 行目しか出ず、後半（例: `&& rm -rf ...`）が見えないことがある問題を修正しました（v1.16.0 以降）。折り返された続きを連結して表示します。
- **コマンド本文を最後まで読み取れなかったときは、スマホへ転送しなくなりました**（PC 側で回答してください）。従来は末尾に `…` を付けて転送していましたが、表示のための省略と区別が付かず、見えている範囲が無害なコマンドの後半を承認できてしまうためです。
- スマホに出す 1 行は、長すぎる場合でも**コマンド本文を優先**して組み立てるようになりました（先に削るのは定型の質問文）。コマンド本文を削らざるを得ないときは `[長すぎるため表示省略]` と明示します。
- **タブ巡回は「CLI が描いたタブバー」が見えているときだけ始まります**。会話ログにタブバーらしい行とタブ移動のヒントが流れているだけでは、ラッパーはキーを一切送りません（従来はこの状態でも巡回を始め、通常の入力欄へ Shift+Tab が送られることがありました）。判定は**タブバー行の背景色**で行います（太字は数えません。Claude の出力に太字を混ぜるだけで偽装できてしまうため）。副作用として、背景色を報告しない端末ではタブ式がスマホへ転送されなくなります（PC 側で回答してください）。**codex CLI の複数質問（`Question N/M`）はタブバーを持たずこの判定を通らないため、背景色を報告しない端末でも転送されます**（止めたい場合は `dialogDetection.tabSweep` に `false` を設定してください）。
- **同じ形の承認が短時間に連続しても、コマンドが違えば別の依頼として出し直すようになりました**。従来は「同じダイアログの描き直し」とみなしてスマホの表示を差し替えず、`ls` を表示したまま `rm -rf ...` を承認してしまう余地がありました。描画途中でコマンドが読めていないフレームは従来どおり描き直しとして扱います。
- **ツール名とコマンドは、承認枠の中身から読み取るようになりました**。従来は「プロンプトより前にある最後の `● Tool(...)`」を採用していたため、①前のターンの `● Bash(ls)` が出力行を挟んで残っているだけで `ls` を表示したまま別のコマンドを承認できる ②コマンド本文の中に書いた `● Read(README.md)` が危険なコマンドを `Read README.md` に見せかけられる、という余地がありました。`● Tool(...)` 行を使うのは**承認枠の罫線に密着している**ときだけで、それ以外は**承認枠に描かれたコマンド本文**（`Bash command` / `Run command` ラベルの下）を表示します。
- **承認枠の外に書かれた文字列は表示に使わなくなりました**。従来は枠の上に流れている会話ログまで探索していたため、`Bash command` と無害なコマンドを 2 行書いておくだけで、実際の承認内容が `rm -rf ...` でもスマホには無害なコマンドが表示される余地がありました。
- **コマンド本文が途中で切れて表示される問題を修正しました**。従来は `?` の手前・80 文字・`)` の 1 つ目・折り返しの行末で、いずれも**印を付けずに**切っていました。たとえば `curl -s "https://example.com/a?b=1" && rm -rf ~` はスマホに `curl -s "https://example.com/a` としか出ず、後半が見えないまま承認できました。攻撃を要さず、クエリ文字列付き URL やグロブを含む普通のコマンドで起きます。
- **コマンド本文がまだ描かれていないフレームは転送しなくなりました**。従来はラベルの次にある行（＝質問文そのもの）を実行内容として拾ってしまい、スマホに偽の「コマンド」が並ぶことがありました。次に画面が描き直された時点で通常どおり転送されます。
- **`Run command` と表示される承認枠で、コマンド本文がスマホに出ないことがある問題を修正しました**（`Bash command` の枠だけを見ていたため、`Run command` の枠では実行内容が空欄のまま承認できていました）。
- **スマホからの回答を注入する直前に、いま表示領域に出ているダイアログが依頼と同じ相手かを確かめるようになりました**（従来はタブ式にだけあった確認を、通常の 1 問形式にも入れました）。質問文・選択肢の並び・ツール名とコマンドに加えて、**スマホに出した 1 行そのもの**を作り直して突き合わせます。違っていた場合や画面を読み取れない場合は注入せず、依頼をスマホへ出し直します。スマホからのキャンセル（Esc）も、タブ式を含めて同じ確認を通ります（タブ式はタブバーの指紋照合のみ＝キーは送りません）。
- **質問文も選択肢の数も同じで、選択肢の並びだけが違うダイアログを別物として扱うようになりました**。スマホへ送るのは選択肢の番号なので、並びが違うと「2 = 中止する」のつもりの回答が画面上の「2 = 適用する」を確定させる余地がありました。
- スマホに出す 1 行が枠に収まらないとき、**必ず省略の印を付ける**ようにしました。また質問文には実際の長さ分しか枠を確保しないため、コマンド本文が従来より長く残ります。
- `approval-config.json` の `dialogDetection.tabSweep` に `false` を設定すると、タブ巡回そのものを無効化できます（タブ式はスマホへ転送されなくなります）。**この設定は codex CLI の複数質問（`Question N/M`）の巡回にも同じように効くため、`false` にすると codex の複数質問もスマホへ転送されません。**

- **承認枠の「中」に偽の罫線とラベルを書いて表示をすり替えられる問題を修正しました**。枠は「プロンプト直前の罫線からプロンプトまで」として読むため、コマンド本文の中に「罫線だけの行 + `Bash command` + 無害なコマンド」を書くと、枠の上端がその偽の罫線までずれ、実際のコマンドが 1 文字もスマホに出ないまま承認できました（端末の折り返しでも同じ形を作れます）。**ラベルらしい行が 2 つ以上見えるフレームは、どれが本物の枠か決められないので転送しません**（PC 側で回答してください）。
- **500 文字を超えるコマンド本文は転送しなくなりました**（従来は無印で 500 字に切っていました）。切った本文は「表示が省略されただけ」と区別が付かないうえ、先頭 500 字が同じ別のコマンドが**同じ依頼として扱われ**、スマホに `… && ls` を出したまま `… && rm -rf ~` を承認できる状態でした。codex 側の扱いに揃えています。
- **`● Tool(...)` 行の「承認枠に密着している」の判定を、枠の罫線が**次の行**にあることに厳格化しました**。従来は空行を何行挟んでも密着とみなしており、モデルが出力の最後に `● Bash(ls -la)` と書くだけで、別のコマンドの承認枠にその表示が継承されました。
- 承認枠の下端に区切り線を持つ形（実機の録画には存在しません）は読まなくなりました。ラベルが見つからない枠は「対象が空の承認」として転送しません。
- 単語 1 語のラベル（`Update` / `Delete` / `Search` など）は、**コマンド本文を読めたときだけ**ツール名を断定します（読めないまま `[Bash]` のように確信ありげに表示しません）。
- タブ巡回中にキーを送ってよいかの判定を、「転送してよいダイアログか」ではなく「画面がダイアログとして読めるか」で行うようにしました。従来は転送を止める条件を増やすほど、描画途中の承認画面が「ダイアログではない画面」に見え、そこへ Shift+Tab（通常の承認画面では「このセッションの編集をすべて許可」）が飛ぶ余地がありました。
- **長い質問文で末尾だけ違う別の承認が、同じ依頼として確定される取り違えを修正しました**。注入直前の照合は質問文が長いと、後半の相違が近似一致（部分列 85%）と表示の 500 字打ち切りの両方に埋もれ、`… SAFE` への回答で画面上の `… DANGEROUS` を確定できました（同 tool / 同 args / 同選択肢が条件、codex レビューで発見・実行で再現）。**注入認可の質問文照合を完全一致に限定**しました（末尾が別語に分岐する「置換」も、末尾に追記する「追加」も弾きます）。当初は文字落ちフレーム登録の救済に近似一致を残しましたが、500 字打ち切り域では「文字落ち」と「別承認の追記」が原理的に弁別できず死んだ緩和になるため撤去しました。500 字超で末尾だけ違う文字落ちフレームは注入せず再登録します（スマホ表示は同一で、承認が消えることはありません）。

**このバージョンで塞ぎ切れていないこと**（把握したうえで次のリリースへ回した項目です）

- **端末の折り返しで作られる「偽の行頭」は塞げていません。** ラッパーは画面を物理行として読むため、コマンド本文の中に書いた `● Tool(...)` が折り返しの継ぎ目で行頭に来ることがあります。現在は「承認枠の罫線に密着しているか」で弾いていますが、行頭そのものの判定は完全ではありません。
- **タブバーが「CLI の描画か」の判定は背景色に依存**しており、背景色を出せる経路があれば偽装は成立します。偽装不能を保証するものではありません。
- **`Bash` / `Write` / `Edit` / `Read` / `Grep` 以外のツール**（`WebFetch` や MCP 系）の承認枠では、ツール名と対象が読み取れずスマホに「何をするか不明の承認」として出ることがあります。**この状態の承認どうしは、実行内容が違っても区別できません**（どちらも「対象不明」なので同じ依頼とみなされます）。実測では、MCP の `Navigate to a URL` と `Run shell(cmd: "rm -rf ~")` が同一と判定されました。**続けて別の MCP 承認が出た場合、1 つ目への回答で 2 つ目が確定する余地があります。** MCP 系の承認は PC 側で内容を確認してから答えてください。
- **承認枠の同定はテキストだけに依存しています。** 罫線もラベルもモデルが本文に書ける普通の文字なので、枠の境界そのものを偽装する余地は残ります。このバージョンでは「ラベルらしい行が 2 つ以上見えるフレームは転送しない」という fail-close で塞いでいますが、**セル属性（CLI が描いた行かどうか）で枠を同定する方式は次のリリース**です。
- **ラベルの無い承認枠（`Bash command` などの見出しを持たない `WebFetch` / MCP 系）では、`● Tool(...)` 行が唯一の手掛かりです。** その行はモデルが自分のメッセージを `Read(README.md)` のように書き始めるだけで作れるため、**この種類の承認だけは表示をすり替えられる余地が残ります**。塞ぐと `WebFetch` / MCP 系の承認がスマホへ出せなくなるため、このバージョンでは残しています。**ただし、この枠の表示は画面のどこかに `Bash command` などの見出し語が 1 行でも残っていると転送されません**（枠の切り出しに失敗している可能性を否定できないため、安全側に倒しています）。なお、この見出し語の検知は画面（表示領域 + スクロールバック 40 行）の範囲に限られます。**本文を長くして見出し語を画面の外へ押し出すと、この fail-close は外れます**（ガード自体が外れることは本文 ~73 行で実行確認しました。ただしそこから実際に表示をすり替えるには、偽の `● Tool(...)` 行が厳密な密着条件を満たす必要があり、実機の承認枠でそこまで到達できるかは未確認です）。実機で確認した範囲（Claude Code v2.1.226）では、`WebFetch` の承認枠は終端マーカーを持たないため**そもそも検出されずスマホに出ていません**。MCP の承認枠は検出されますが、ツール名と対象を読み取れず「何をするか不明の承認」として出ます。いずれも 1 例ずつの観測です。
- **折り返した質問文の前半が、コマンド本文としてスマホに表示されます。** 端末幅で質問が 2 行以上に折り返されると、その 1 行目が承認枠の本文とみなされ、コマンドの後ろに連結されます。表示が余計に増える方向なので危険な承認を隠すことはありませんが、この文字列は「同じ承認か」の判定にも使われるため、**端末の幅が変わると同じ承認が別の依頼として出し直される**ことがあります。修正には質問文の範囲の同定をやり直す必要があるため、次のリリースに回します。
- **タブ巡回中に画面が差し替わった場合、「自分が押した Tab を戻す一手」は CLI 描画の属性を確認せずに送られます。** 送るのは自分が進めた分を戻す Shift+Tab だけで、終端マーカーが 1 つも見えない画面に限られますが、偽のタブバー行を書ける相手には条件を作れます。属性の確認を足すと「戻れないままフォーカスが Submit に残る」事故（実測済み）が再発するため、対で直す必要があり次のリリースに回します。
- **承認枠の説明行までコマンド本文として表示するため、描画の進行中はフレームごとに表示文字列が変わります。** その結果、同じ承認がスマホ上で別依頼として出し直されることがあります（実録画では未発生）。説明行を外すと折り返したコマンドの後半を落とす危険があるため、表示を減らす方向には倒していません。
- **コマンド本文の引用符（`"` / `'`）が奇数個で閉じていない承認枠は転送しません。** 途中までしか読めていない可能性を否定できないためです（ラベルの無い枠でのみ発生し、fail-close 方向です）。
- **codex の複数質問フロー（`Question 1/N`）では、スマホからのキャンセル（Esc）が現状は送られず、PC 側での操作になります。** 複合ダイアログの同一性照合に使うタブバー指紋を持たない登録経路のため、キャンセルの照合が常に成立せず PC へ引き継がれます（コード上の確認、実機未確認）。承認・拒否の回答はスマホから可能です。

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

## v1.22.0+

- **Fixed option labels keeping a leading `)` in dialogs numbered `1)`.** The leading-noise stripper only removed dots and whitespace, so `1)`-style dialogs left every label as `) …`, which silently disabled two exact-match defenses (rejecting answers that select "Chat about this", and restricting free-text attachments to "Type something") — the former in the fail-open direction. Minimal fix at the label-producing site: the separator residue is now stripped.
- **The exit-confirmation wording can now be extended via configuration** (`dialogDetection.exitConfirmPhrases`, an array treated as literals). The knob is **append-only**: the two built-in phrases cannot be disabled by configuration (no misconfiguration can silently re-enable forwarding of that screen). Phrases shorter than 4 characters, longer than 200, or beyond the 16th entry are ignored with a startup warning (short phrases are prefix-matched and would suppress ordinary questions). Intended for tracking CLI wording changes and localization.
- **At startup the wrapper now compares the target CLI's version against the version its dialog detection was verified on, and prints a one-line stderr warning when the CLI is ahead by a minor/major version** (CLI version canary). Dialog detection depends on on-screen wording and breaks without an exception when wording changes, so the wrapper surfaces the precondition (CLI newer than verified) at startup. Startup is never blocked; patch-level drift and probe failures go to the wrapper log only.
- **Added a shadow mode observing whether the prompt and the options belong to the same frame** (no behavior change). The root cause of the exit-confirmation incident is that the prompt is found by scanning back to the last `?` in the window, which can adopt leftover text from a different frame. As preparation for a structural fix, incoherent frames are only recorded to the wrapper log as `frame-shadow` lines; enforcement will be decided in a future release based on the measurements.
- Added a real-machine regression fixture (a recording of the claude 2.1.237 session-exit confirmation screen). The recording shows that **2.1.237 renders only two options (`Exit and stop tasks` / `Stay`)** — the wording set already changed from the three-option screen v1.21.1 was built against — confirming that suppressing on either single known phrase survived a real wording change.
- Misc: added the missing `ambiguous-box` description to the non-forwarding reason table (log display only). Note that the canary adds a `--version` probe of the target CLI to startup (0.5–2.2 s in practice, varying with system load, capped at 10 s; it runs in parallel with the server reachability check).

## v1.21.1+

- **The session-exit confirmation screen (`Exit and stop tasks` / `Move to background and exit` / `Stay`) is no longer forwarded to the phone.** That screen is not an approval, but it has the same structure as an approval box (options `1..N` plus an end marker) and raises none of the tool-approval signals, so it used to be forwarded as an `AskUserQuestion`. Approving it from the phone would inject option 1 — ending the session — on the PC, so the wrapper now reads it but refuses to forward it. `Exit and stop tasks` and `Move to background and exit` practically never appear outside this screen, so either one alone suppresses forwarding — this also covers partially drawn frames where only the first option is on screen. `Stay` is a word ordinary questions use, so it is not part of the check at all. The check runs at the single "may this be forwarded" decision point, so the screen is suppressed even when a `● Tool(...)` line sits above the box. **Answer this screen on the PC.**
- The reason is recorded in the wrapper log as `承認可能化しない(exit-confirm: …)` when `APPROVAL_WRAPPER_LOG` is set.

## v1.21.0+

- When the wrapper cannot rewind back to the first tab after sweeping a tabbed multi-question dialog and gives up forwarding, the phone now shows a "please use the PC" notice card. A notice is not an approval: it has no options, free text, or tabs, and tapping "Acknowledged" simply dismisses it (it never connects to the PTY injection path). It clears itself automatically when the tab UI disappears on the PC, after a 30-minute TTL on the wrapper side, or via a server-side backstop (removed on the next GC sweep once 60 minutes have passed since it went pending; GC runs every 5 minutes, so this typically takes up to about 65 minutes).
- The Shift+Tab that returns to the first tab after a sweep ("paying back the debt") now also requires the background-color attribute check (R2). It used to be allowed ahead of the attribute check whenever a debt was outstanding; now "never send Shift+Tab on a frame whose attributes cannot be confirmed" is an exceptionless invariant. The trade-off is that the wrapper can no longer rewind on a transient confirmation-screen frame whose attributes cannot be read — in that case it falls back to the notice above. Replays of the recorded corpus show every confirmation-screen frame with readable attributes, so this availability cost has not been observed in normal operation.
- Every HTTP call the wrapper makes (`httpRequestReal`) now has an absolute deadline (default 70s) measured from when the call started. The previous `timeout` option was an inactivity timer that only watched for silence, so a peer that kept responding intermittently could avoid being cut off. This does not affect normal usage.
- The same function now also caps each response at 1MB of received data. A response exceeding the cap is cut off and that call is treated as failed (legitimate responses are a few tens of KB even for a full queue, so no impact is expected in normal operation).
- Renamed the internal function `barRowIsCliDrawn` to `barRowHasStyledCells` (no behavior change).

## v1.20.0+

- The wrapper now identifies MCP tool approval boxes (label row `Tool use`) and forwards them to the phone as `tool='MCP'`, reading the target line inside the box (`serverName - toolName(args)`). Measured across 2 servers × 3 tools with verbatim label matches (other vendors, locales, and CLI versions are unverified).
- **Approval boxes that cannot be identified from either the label or an `● Tool(...)` line are no longer forwarded** (fail-close). **Approvals that used to be forwarded with `tool='Unknown'` no longer reach the phone in this version and must be answered on the PC.** Tab sweeping and Shift+Tab behavior are unchanged.
- Added a PII scanner to `npm test` that flags environment-derived identifiers (such as usernames embedded in home-directory paths) in tracked files, and wired it into GitHub Actions (check name `pii-and-tests`) to run on every PR. This is a developer-facing change with no effect on end-user behavior.

## v1.19.0+

- Fixed tab focus cycling on its own while you answer a multi-question (AskUserQuestion) dialog on the PC. The wrapper now sweeps the tabs at most once per appearance of the dialog.
- Local key presses during a sweep abort it immediately. Confirming keys (Enter / digits) are dropped for a short settle window, because a Tab the wrapper already sent cannot be recalled and letting the key through would confirm an answer on whichever tab it landed on. `Ctrl-C` and a standalone `Esc` always get through.
- If not every tab could be captured, the dialog is no longer forwarded to the phone and is left to the PC, so a partial registration can never shift where answers land. The currently visible tab is not forwarded as a single question either.
- Before injecting an answer from the phone, the wrapper verifies that the tab bar is unchanged since the sweep and that focus is on the first tab. If it cannot verify this, it injects nothing and re-presents the request on the phone.
- **If the PC already answered part of the dialog, the phone request is withdrawn instead of being re-presented.** The snapshot is stale at that point, so re-sending from the phone would be rejected every time; finish the dialog on the PC.
- Key presses during the position check are no longer swallowed. The check is aborted instead, and the key needs to be pressed again.
- Fixed requests lingering on the phone after they were already answered on the PC. The old request is now withdrawn as soon as the screen switches to a different dialog.
- A pending request no longer expires purely from elapsed time while you are typing in `Type something` or while focus sits on Submit.
- **The sweep now starts only while the tab bar has not changed since the dialog appeared.** It used to start even right after you answered on the PC and pulled focus back to the first tab with Shift+Tab, which looked like the tabs moving on their own. Answering even one tab changes the tab bar, so from then on the wrapper sends no keys to that dialog and does not forward it to the phone. **To answer a tabbed dialog from your phone, leave the keyboard alone for a second or two after it appears.**
- The tab bar is now located from the footer at the bottom of the screen instead of from the first numbered line. A numbered list scrolling by in the conversation no longer makes tabbed questions silently stop being forwarded. Conversely, when several tab-bar-like lines are visible and the real one cannot be told apart, the dialog is not forwarded and is left to the PC.
- Fixed ordinary approvals not reaching the phone while a checklist (a run of `☒` / `☐`) was on screen.
- On a plan approval screen (`shift+tab to approve`) the wrapper now never sends Shift+Tab, since that key is what confirms the plan.
- Fixed codex command approvals showing only the first line when the command was wrapped, hiding the rest (for example `&& rm -rf ...`) from the phone (present since v1.16.0). The wrapped continuation is now joined and displayed.
- **A command that could not be read to its end is no longer forwarded to the phone** (answer it on the PC). It used to be forwarded with a trailing `…`, which is indistinguishable from display-only shortening, so a command whose visible part looks harmless could be approved along with a hidden tail.
- The single line shown on the phone now **keeps the command text at the expense of the prompt** when it does not fit. If the command itself has to be shortened, it is marked explicitly with `[長すぎるため表示省略]`.
- **The sweep now starts only while a tab bar drawn by the CLI is visible.** A tab-bar-like line plus a navigation hint scrolling by in the conversation is no longer enough to make the wrapper send any keys (it used to start sweeping in that state, which could send Shift+Tab into the ordinary input). The check looks at the **background color** of the tab bar row; bold is deliberately not counted, because Claude's own output can be bold. As a side effect, terminals that do not report background colors will not forward tabbed dialogs to the phone; answer those on the PC. **The codex CLI multi-question flow (`Question N/M`) has no tab bar and does not go through this check, so it is still forwarded on terminals that report no background colors** (set `dialogDetection.tabSweep` to `false` to stop it).
- **Two similar approvals in quick succession are now treated as separate requests when the command differs.** They used to be treated as a redraw of the same dialog, so the phone could keep showing `ls` while an approval landed on `rm -rf ...`. Frames where the command has not been drawn yet are still treated as a redraw.
- **The tool name and command are now read from inside the approval box.** The wrapper used to take "the last `● Tool(...)` before the prompt", which allowed two things: (1) a leftover `● Bash(ls)` from the previous turn, separated by output lines, kept `ls` on the phone while a different command was being approved; (2) a `● Read(README.md)` written inside the command text could disguise a dangerous command as `Read README.md`. A `● Tool(...)` line is used only when it is **flush against the box border**; otherwise the command text drawn **inside the box** (under the `Bash command` / `Run command` label) is shown.
- **Text outside the approval box is no longer used for the display.** The wrapper used to search the conversation log scrolling above the box, so writing `Bash command` plus a harmless command there was enough to make the phone show something harmless while the actual approval was `rm -rf ...`.
- **Fixed: the command text was being cut off without any marker.** It used to stop before a `?`, at 80 characters, at the first `)`, and at a wrapped line end — all silently. For example `curl -s "https://example.com/a?b=1" && rm -rf ~` reached the phone as `curl -s "https://example.com/a`, and the rest could be approved unseen. No attack is needed; ordinary commands with query-string URLs or globs trigger it.
- **Frames in which the command text has not been drawn yet are no longer forwarded.** The line after the label — the question itself — used to be picked up as the command, so a fake "command" could appear on the phone. The next redraw is forwarded normally.
- **Fixed: approval boxes labeled `Run command` did not show the command on the phone** (only `Bash command` boxes were matched, so those approvals could be granted with an empty command field).
- **Before injecting an answer from the phone, the wrapper now checks that the dialog currently in the viewport is the one the request was made for** (this check previously existed only for tabbed dialogs, now it covers ordinary single-question ones too). It compares the question, the option order, the tool and command, and **the exact line that was sent to the phone**, rebuilt and matched byte for byte. If anything differs, or the screen cannot be read, nothing is injected and the request is re-issued to the phone. Cancels (Esc) go through the same check, including tabbed dialogs (those compare the tab bar fingerprint only — no keys are sent).
- **Dialogs with the same question and the same number of options but a different option order are now treated as different.** The phone sends the option number, so a different order could make an answer meant as "2 = cancel" confirm "2 = apply" on screen.
- The single line shown on the phone now always carries an ellipsis marker when it does not fit, and reserves only as much room as the question actually needs — so more of the command text survives.
- Setting `dialogDetection.tabSweep` to `false` in `approval-config.json` disables tab sweeping entirely (tabbed dialogs are then not forwarded to the phone). **The same switch also governs the codex CLI multi-question sweep (`Question N/M`), so setting it to `false` stops those from reaching the phone as well.**

- **Fixed: the display could be swapped by writing a fake rule line and label *inside* the approval box.** The box is read as "from the rule line just above the prompt down to the prompt", so writing `───` + `Bash command` + a harmless command inside the command text moved the box's top border to that fake rule — the real command never reached the phone at all (terminal wrapping can produce the same shape). **Frames where two or more label-like lines are visible are no longer forwarded** (answer on the PC).
- **Command text longer than 500 characters is no longer forwarded** (it used to be cut at 500 with no marker). A silently cut command is indistinguishable from "display shortened", and two different commands sharing the first 500 characters were treated as the *same* request — the phone could show `… && ls` while `… && rm -rf ~` was approved. This now matches the codex path.
- **"Flush against the approval box" for a `● Tool(...)` line now requires the box rule on the *next* line.** Blank lines used to be skipped, so a model that ended its output with `● Bash(ls -la)` could have that display inherited by a different command's approval box.
- Boxes with a bottom separator line (not present in any real recording) are no longer read; a box with no label is treated as "approval with an empty target" and not forwarded.
- Single-word labels (`Update` / `Delete` / `Search`) only pin the tool name **when the command text could be read** — no more confident-looking `[Bash]` with an empty target.
- Whether a key may be sent during tab sweeping is now decided by "does the screen read as a dialog", not by "is this dialog forwardable". Otherwise each added fail-close made a partially drawn approval screen look like "not a dialog", opening a path for Shift+Tab (which on an ordinary approval screen means "allow all edits this session").
- **Fixed a mix-up where two approvals sharing a long prompt prefix but differing only in the tail were confirmed as the same request.** With a long prompt, the tail difference was hidden by both the near-match (85% subsequence) and the 500-character display truncation, so a reply to `… SAFE` could confirm `… DANGEROUS` on screen (same tool / args / options required; found by codex review, reproduced in code). **The prompt check for injection is now an exact match** (rejecting both a substituted tail and an appended tail). A near-match was originally kept to rescue dropout-frame registrations, but in the 500-character truncation zone "a dropout" and "an appended different approval" cannot be told apart in principle, so that dead relaxation was removed. A >500-character dropout frame differing only in its tail is not injected but re-registered instead (the phone shows the same thing; the approval never disappears).

**Known gaps in this version** (identified and deliberately deferred to a later release)

- **A "fake line start" produced by terminal wrapping is not closed.** The wrapper reads the screen as physical lines, so a `● Tool(...)` written inside the command text can land at the start of a line when the terminal wraps. Such lines are currently rejected by the "flush against the box border" check, but the line-start test itself is not airtight.
- **Deciding whether a tab bar was "drawn by the CLI" relies on background color.** Any path that can emit background color can forge it; this is not a guarantee of unforgeability.
- **Approval boxes for tools other than `Bash` / `Write` / `Edit` / `Read` / `Grep`** (`WebFetch`, MCP tools) may reach the phone without a readable tool name or target. **Two such approvals cannot be told apart even when they do different things** — both look like "unknown target", so the second is treated as a redraw of the first. Measured: an MCP `Navigate to a URL` and `Run shell(cmd: "rm -rf ~")` compared as identical. **If a second MCP approval follows the first, answering the first can settle the second.** Answer MCP approvals on the PC after checking what they do.
- **Identifying the approval box still relies on text alone.** Rule lines and labels are ordinary characters a model can write, so forging the box boundary remains possible in principle. This version closes it with a fail-close ("do not forward frames with two or more label-like lines"); **identifying the box by cell attributes (was this line drawn by the CLI?) is a later release.**
- **For approval boxes without a label (`WebFetch` / MCP tools, which have no `Bash command`-style heading), the `● Tool(...)` line is the only signal.** A model can produce such a line simply by starting its message with `Read(README.md)`, so **the display can be swapped for this kind of approval only**. Closing it would stop `WebFetch` / MCP approvals from reaching the phone, so it is left open in this version. **However, such a box is no longer forwarded when a heading word like `Bash command` is visible anywhere on screen** — that combination cannot be distinguished from a failed box extraction, so the wrapper fails closed. This heading-word check only covers the screen (viewport + 40 lines of scrollback), so **making the body long enough to push the heading word off-screen defeats this fail-close** (the guard itself was confirmed to drop at ~73 body lines; whether an actual display swap then follows requires the fake `● Tool(...)` line to meet strict flush conditions, and reachability on the real box is unverified). On the machine we recorded (Claude Code v2.1.226), the `WebFetch` approval box carries no end marker and is therefore **not detected at all**, so it never reaches the phone; the MCP approval box is detected but its tool name and target cannot be read, so it arrives as an approval with an unknown target. Both are single observations.
- **The first line of a wrapped question is shown as part of the command.** When the terminal width wraps the question across two or more lines, its first line is treated as box body and appended after the command. This only ever shows more, never less, so it cannot hide a dangerous approval — but the same string is used to decide whether two frames are the same approval, so **resizing the terminal can re-issue the same approval as a new request**. Fixing it requires redoing how the question paragraph is delimited, so it is deferred to the next release.
- **During tab sweeping, the single "give back the Tab I pressed" keystroke is sent without checking the CLI-drawn attribute.** It is limited to screens where no end marker is visible, but anyone who can write a fake tab bar row can create that condition. Adding the attribute check re-introduces a measured regression ("cannot return, focus stays on Submit"), so both must be fixed together — deferred.
- **The command text shown on the phone includes the box's description line**, which is drawn progressively, so the string can change between frames and the same approval may be re-issued as a new request on the phone (not observed in real recordings). Dropping the description risks hiding the tail of a wrapped command, so the display is not reduced.
- **Approval boxes whose command text has an odd number of quotes (`"` / `'`) are not forwarded**, since the command may have been read only partially (occurs only for label-less boxes; fail-close).
- **In the codex multi-question flow (`Question 1/N`), a cancel (Esc) from the phone is currently not sent and must be done on the PC.** The registration path for compound dialogs carries no tab-bar fingerprint, so the cancel identity check never matches and the request is handed to the PC (confirmed in code, not on a real device). Approve/reject answers still work from the phone.

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
