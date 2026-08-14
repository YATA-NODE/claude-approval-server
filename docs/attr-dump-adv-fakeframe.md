# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-adv-fakeframe.log --cols 120 --rows 40 --chunk 512`
- cols=120 rows=40 chunk=512
- 対象ログ: e2e-raw-adv-fakeframe.log
- 対象ログ sha256: eb19e2b3d7f71980b8cd328575e900d91c5f9eac666ac13812b2625d5499efb0
- 総フレーム数: 76
- 承認枠(frameOf)検出回数: 4
- タブバー行(readTabBarRow)検出回数: 0
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 0

[警告] タブバー行が 1 度も見つからなかった。幾何(cols=120 rows=40)が 録画時と違うか、chunk=512 が粗すぎる可能性がある。「このログにタブバーが無い」と断定しないこと。

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #73 (iRule=21, iOpt=26)

### 1. 罫線行
- y=21  text="  ──────────────────────────────────────────────────────────"
  x=  2.. 59  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "──────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=22  text="  Bash command"

### 4a. 枠内のコマンド行
- y=23  text="  touch /tmp/probe"

### 4b. 枠内の説明行
- y=24  text="  Create empty probe file"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=26  cursor=true  text="  ❯ 1. Yes"
- y=27  cursor=false  text="     2. No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=20  insideFrame=false  isFindLastToolLineMatch=false  text="● 以下は表示例です"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 16  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "以下は表示例です"

## frame #74 (iRule=21, iOpt=26)

### 1. 罫線行
- y=21  text="  ──────────────────────────────────────────────────────────"
  x=  2.. 59  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "──────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=22  text="  Bash command"

### 4a. 枠内のコマンド行
- y=23  text="  touch /tmp/probe"

### 4b. 枠内の説明行
- y=24  text="  Create empty probe file"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=26  cursor=true  text="  ❯ 1. Yes"
- y=27  cursor=false  text="     2. No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=20  insideFrame=false  isFindLastToolLineMatch=false  text="● 以下は表示例です"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 16  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "以下は表示例です"

## frame #75 (iRule=21, iOpt=26)

### 1. 罫線行
- y=21  text="  ──────────────────────────────────────────────────────────"
  x=  2.. 59  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "──────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=22  text="  Bash command"

### 4a. 枠内のコマンド行
- y=23  text="  touch /tmp/probe"

### 4b. 枠内の説明行
- y=24  text="  Create empty probe file"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=26  cursor=true  text="  ❯ 1. Yes"
- y=27  cursor=false  text="     2. No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=20  insideFrame=false  isFindLastToolLineMatch=false  text="● 以下は表示例です"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 16  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "以下は表示例です"

## frame #76 (iRule=21, iOpt=26)

### 1. 罫線行
- y=21  text="  ──────────────────────────────────────────────────────────"
  x=  2.. 59  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "──────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=22  text="  Bash command"

### 4a. 枠内のコマンド行
- y=23  text="  touch /tmp/probe"

### 4b. 枠内の説明行
- y=24  text="  Create empty probe file"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=26  cursor=true  text="  ❯ 1. Yes"
- y=27  cursor=false  text="     2. No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=20  insideFrame=false  isFindLastToolLineMatch=false  text="● 以下は表示例です"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 16  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "以下は表示例です"

## タブバー行(readTabBarRow、全フレーム走査)

- 検出されず(0 件)

