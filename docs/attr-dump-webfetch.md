# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-webfetch.log --cols 120 --rows 40 --chunk 512`
- cols=120 rows=40 chunk=512
- 対象ログ: e2e-raw-webfetch.log
- 対象ログ sha256: 3aff9cbf8358436fd2eea43225a2b4813f13641ef0a52c2005c207e2bf7f774d
- 総フレーム数: 28
- 承認枠(frameOf)検出回数: 1
- タブバー行(readTabBarRow)検出回数: 0
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 0

[警告] タブバー行が 1 度も見つからなかった。幾何(cols=120 rows=40)が 録画時と違うか、chunk=512 が粗すぎる可能性がある。「このログにタブバーが無い」と断定しないこと。

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #23 (iRule=10, iOpt=17)

### 1. 罫線行
- y=10  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=11  text=" Fetch"
  x=  1..  5  fg=rgb:11647481|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Fetch"

### 4a. 枠内のコマンド行
- y=13  text="   url: \"https://example.com/\", prompt: \"このページの内容を要約してください。\""

### 4b. 枠内の説明行
- y=14  text="   Claude wants to fetch content from example.com"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=17  cursor=true  text=" ❯ 1. Yes5 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    x=  1..  1  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  6..  8  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Yes"
    x=  9..  9  fg=rgb:10066329|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "5"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- y=8  tool=Fetch  readable=true  args="https://example.com/"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2..  6  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Fetch"
    x=  7.. 28  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "(https://example.com/)"

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=8  insideFrame=false  isFindLastToolLineMatch=true  text="● Fetch(https://example.com/)"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2..  6  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Fetch"
    x=  7.. 28  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "(https://example.com/)"

## タブバー行(readTabBarRow、全フレーム走査)

- 検出されず(0 件)

