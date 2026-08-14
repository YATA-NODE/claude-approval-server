# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-w80-webfetch.log --cols 80 --rows 30 --chunk 512`
- cols=80 rows=30 chunk=512
- 対象ログ: e2e-raw-w80-webfetch.log
- 対象ログ sha256: 4c321735f82b1a5dac47e955ce2696056f4a333e4534f6312d947f37fd77fe33
- 総フレーム数: 32
- 承認枠(frameOf)検出回数: 1
- タブバー行(readTabBarRow)検出回数: 0
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 0

[警告] タブバー行が 1 度も見つからなかった。幾何(cols=80 rows=30)が 録画時と違うか、chunk=512 が粗すぎる可能性がある。「このログにタブバーが無い」と断定しないこと。

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #26 (iRule=9, iOpt=16)

### 1. 罫線行
- y=9  text="────────────────────────────────────────────────────────────────────────────────"
  x=  0.. 79  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=10  text=" Fetch"
  x=  1..  5  fg=rgb:11647481|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Fetch"

### 4a. 枠内のコマンド行
- y=12  text="   url: \"https://example.com/\", prompt: \"このページの内容を要約してください\""

### 4b. 枠内の説明行
- y=13  text="   Claude wants to fetch content from example.com"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=16  cursor=true  text=" ❯ 1. Yes"
    x=  1..  1  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  6..  8  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Yes"
- y=17  cursor=false  text="   2. Yes, and don't ask again for example.com"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x= 35.. 45  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "example.com"
- y=18  cursor=false  text="   3. No, and tell Claude what to do"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "3."

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- 観測されず

## タブバー行(readTabBarRow、全フレーム走査)

- 検出されず(0 件)

