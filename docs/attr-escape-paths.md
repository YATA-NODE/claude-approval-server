# 入力経路 × 属性への反映 分類表(案C Phase 0)

有限回の敵対試行で「偽陽性 0」を主張するのは弱い。**どの入力経路なら属性を持ち得るのか**を
経路そのもので分類しておけば、試行で見つからなかったことの意味が強くなる。本表はその分類。

- 状態語彙は `docs/attr-facts.md` と共通(`verified` / `partial` / `unknown`)。
  **`unknown` は正常な状態**であり、推測で埋めない。
- 再現回数の規約: 録画の再生 = 決定論 1 回 / 実機での取得 = 2 回(`docs/attr-count-table.md`)。
- sha256 は先頭 16 桁のみ記載(全文は `docs/attr-manifest.json`)。corpus 7 本は
  `recordings.files`、pilot・敵対系は **`supplementary_recordings.files` に登録済み**
  (幾何がファイルごとに違うため別枠)。録画本体は個人環境の内容を含むため gitignore のまま
  ローカルに置く。

## 分類表

| # | 入力経路 | 属性への反映 | 到達しうる列 | 状態 | 出典(sha256 先頭 16) |
|---|---|---|---|---|---|
| P1 | モデルの地の文(markdown 装飾なし) | **付かない**(全 run が fg=default) | x≥2 | partial | `e2e-adv-pilot2.log`(`7247faa054cee23e`) |
| P2 | モデルの markdown 太字 | **付く**(bold=1、色は default)。インラインコードと併用すると **#B1B9F9 + bold=1** が同時に取れ、承認枠のラベル行と属性が完全一致する | x≥2 | verified | `e2e-adv-pilot4-markdown.log`(`57513ccba3f015d2`)/ 併用 = `e2e-adv-pilot7-boldwrap.log`(`043651bdf931e1b5`) |
| P3 | モデルの markdown インラインコード | **付く**(fg=#B1B9F9 = 承認枠の罫線・ラベルと同色) | x≥2 | verified | `e2e-adv-pilot4-markdown.log`(`57513ccba3f015d2`)/ `e2e-adv-pilot6-rule.log`(`3cb75b3148139453`) |
| P4 | モデルの markdown リンク | **付く**(fg=palette:12 + underline=1) | x≥2 | verified | `e2e-adv-pilot4-markdown.log`(同上) |
| P5 | モデルの fenced code block(構文強調) | **付く**(fg=palette:4 / palette:2 等) | x≥2 | verified | `e2e-adv-pilot4-markdown.log`(同上) |
| P6 | モデルの markdown 表 / 見出し | **付く**(見出しは bold + underline + italic、表は罫線が描画される) | x≥2 | verified | `e2e-adv-pilot8-hr.log`(`5984a3f1361ab627`) |
| P6b | モデルの markdown 水平線(`---`) | **全幅の罫線にはならない**(literal な `---` として描かれる) | x≥2 | verified | `e2e-adv-pilot8-hr.log`(同上) |
| P7 | tool 結果をモデルが本文へ再出力(生 SGR / CR / OSC) | 画面には ESC が乗らず `[44m` 等が可視文字として残る。CR も上書きに作用していない | x≥2 | **partial**(下記)| `e2e-adv-tooloutput-viamodel.log`(`61ae8cb0930a4587`) |
| P8 | tool 結果として**直接描画**(Bash の生 SGR) | **付く**(bg / bold / inverse すべて成立) | x≥5(`⎿` の後) | verified | `e2e-adv-tooloutput.log`(`b631cac8b2d7d3d5`) |
| P9 | tool 結果の生 CR(同上) | 上書きとして作用せず除去 | x≥5 | verified | `e2e-adv-tooloutput.log`(同上) |
| P10 | P8 の行が `readTabBarRow` / `barRowIsCliDrawn` に受理されるか | **受理される**(8 フレーム連続で `barRowIsCliDrawn()` = true) | x≥5 | verified | `e2e-raw-a2-tabbar-sgr-noecho.log`(`b4221e9cc05aefa2`) |
| P10b | 生 SGR **なし**で、CLI がプロンプトのエコー行に付けた背景色 | **受理される**(10 フレームで true)。行の中身は CLI 由来でない | x≥2 | verified | `e2e-raw-a-tabbar-sgr.log`(`482fe5d78acf0d2f`) |
| P11 | CLI 自身の描画(承認枠・タブバー・確認画面) | **付く** | **罫線行は x=0 から端末幅いっぱい**(cols=80 でも x=0..79)。ラベル行は x=1 から | verified | `docs/attr-dump-*.md` 全 7 本 |

## この分類から言えること

**属性の有無そのものは弁別に使えない**。P2-P6 でモデルは色も bold も underline も得られ、P8 で
tool 結果は背景色と反転まで得られる。承認枠の罫線・ラベルと同じ #B1B9F9 も P3 で作れる
(`docs/attr-facts.md` 事実 4)。

**分かれるのは到達しうる列**。モデル出力は常に 2 列インデントされ(x≥2)、tool 結果は `⎿` の後
(x≥5)から描かれる。x=0 は CLI 自身の chrome(`●` 等)が占める。7 通りの攻撃(素のテキスト /
インラインコード / 太字併用 / 300 文字の折り返し / 水平線 / 表 / 見出し)すべてで x=0 に到達
できていない。

したがって採用候補として残るのは **「x=0 始まり ∧ 端末幅いっぱい ∧ 属性一致」を AND で要求する形**
だけになる。ただしこれは「モデルが x=0 に書けない」ことに依存しており、**画面に既にある本物の
罫線を借用されると列位置の条件は満たされてしまう** — これは実測で**成立を確認した**
(`docs/attr-facts.md` の攻撃 3。`e2e-raw-b-borrow.log` frame #65)。

**P10 / P10b が示す別の帰結**: `barRowIsCliDrawn`(背景色セル > 0)は「CLI が描いた行」の
証明にならない。**CLI は自分が描いた行と、中身が CLI 由来の行を区別しない**。背景色は CLI が
付けるが、その行のテキストは tool の出力だったりプロンプトのエコーだったりする。
「素のテキストと markdown では作れない」という production コメントの保証は、この 2 経路では
成立しない。

## 未測定・既知の限界

- **P1 が `partial` な理由**: 1 payload の最終画面でしか確認していない(`docs/attr-facts.md` 事実 4)。
  ただし P2-P6 で「装飾を付ければ属性は得られる」ことが確定しているため、P1 の精度は
  採否の結論を左右しない(装飾ありの方が攻撃者に有利で、そちらは verified)。
- **P7 と P8 の差は経路の差であって、CLI の一般的なエスケープ方針ではない**。「モデルの本文は
  無害化される」ことを一般則として拡張しない。tool の種類を変えれば別経路が開く可能性は
  測っていない(`Bash` の `printf` 系でのみ確認)。
- **DCS / C1 制御 / BS 上書きは未測定**。攻撃系 ④ のうち実測できたのは SGR / CR / OSC の 3 種。
- **pilot 系の録画は、観測当時の sha256 が記録されないまま使われていた**。実際
  `docs/attr-pilot-findings.md` は `e2e-adv-pilot2.log` を 18,432 B と記録しているが現物は
  18,472 B(40 B 差)で、**当時のファイルと同一かは確認できない(`unknown`)**。
  対処として **現物を再生し直して再観測**し(P2-P6 の属性が同じく出ることを確認)、
  その sha256 を manifest の `supplementary_recordings` に固定した。
  **以後の主張は「今のファイルを再生した結果」に立脚する**。
  再観測していない P1 は `partial` のままとし、結論を支える主証拠には使わない。
- **P7 を `verified` から `partial` へ下げた理由(重要)**: 録画に生 ESC が無いことは
  「**出力**に ESC が乗らなかった」ことしか示さず、「**入力**に存在した制御列が除去された」
  証明にはならない。入力側に生 ESC があったことは観測時に `xxd` で確認したと
  `docs/attr-facts.md` に記録があるが、**その入力ファイルは残っておらず再検証できない**。
  「無害化される」と言い切るには、**入力の実バイトを記録した対照実験**が要る。
  それまでこの行を「モデル再出力経路は安全」の根拠に使わない。
- **P7 / P8 の出典は取り違えられていた**(本表作成時に録画の中身で確認して訂正)。
  再出力経路 = `e2e-adv-tooloutput-viamodel.log`(`cat` のみ / 生 ESC を含まない)、
  直接描画経路 = `e2e-adv-tooloutput.log`(`printf` / 生 ESC の `[44m` を含む)。
  `docs/attr-facts.md` 側も同時に訂正済み。
- 本表は 1 環境(`docs/attr-manifest.json` の `env-2026-08-10`)の実測。CLI の版が変われば
  再測が要る(版更新時の再認定条件は master plan を参照)。

## 参照

- `docs/attr-facts.md`(事実表。本表は事実 4 の経路分類を独立させたもの)
- `docs/attr-manifest.json`(版 manifest と corpus の sha256)
- `docs/attr-count-table.md`(corpus の件数表)
