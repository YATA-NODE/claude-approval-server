# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-t4-tabbed.log --cols 120 --rows 40 --chunk 512`
- cols=120 rows=40 chunk=512
- 対象ログ: e2e-raw-t4-tabbed.log
- 対象ログ sha256: 0273f3c4aedb556d4fc2d7a29c3699c54999dfb0acdfb326a443447cf15f801a
- 総フレーム数: 27
- 承認枠(frameOf)検出回数: 1
- タブバー行(readTabBarRow)検出回数: 2
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 2

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #21 (iRule=9, iOpt=14)

### 1. 罫線行
- y=9  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=10  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"
  x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"

### 4a. 枠内のコマンド行
- y=12  text="好きな色はどちらですか?"
  x=  0.. 22  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな色はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=14  cursor=true  text="❯ 1. 青"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "青"
- y=15  cursor=false  text="     青系統の色が好き"
    x=  5.. 19  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "青系統の色が好き"
- y=16  cursor=false  text="  2. 赤xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "赤"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- 観測されず

## タブバー行(readTabBarRow、全フレーム走査)

- frame #21  y=10  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=12  inverse セル数=0
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"
- frame #22  y=10  text="● Use好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=9  inverse セル数=0
    x=  2..  4  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Use"
    x=  5.. 11  fg=rgb:0|bg=rgb:11647481|bold=0|dim=0|inverse=0|underline=0|italic=0  "好きな色"

