# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-tabs.log --cols 120 --rows 40 --chunk 512`
- cols=120 rows=40 chunk=512
- 対象ログ: e2e-raw-tabs.log
- 対象ログ sha256: 30c6a901b3165c72cb275bbe145e39e27387e519d2b42c3df11ad13c033b620f
- 総フレーム数: 35
- 承認枠(frameOf)検出回数: 2
- タブバー行(readTabBarRow)検出回数: 0
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 0

[警告] タブバー行が 1 度も見つからなかった。幾何(cols=120 rows=40)が 録画時と違うか、chunk=512 が粗すぎる可能性がある。「このログにタブバーが無い」と断定しないこと。

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #27 (iRule=13, iOpt=20)

### 1. 罫線行
- y=13  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=14  text=" Bash command"

### 4a. 枠内のコマンド行
- y=16  text="   touch /tmp/e2e-single-approval-probe.txt"

### 4b. 枠内の説明行
- y=17  text="   Create empty probe file at specified path"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=20  cursor=true  text=" ❯ 1. Yes"
    x=  1..  1  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  6..  8  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Yes"
- y=21  cursor=false  text="   2. Yes, and always allow access to tmp/ from this project"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x= 38.. 40  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "tmp"
- y=22  cursor=false  text="   3. No"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "3."
    x=  6..  7  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- y=10  tool=Bash  readable=true  args="touch /tmp/e2e-single-approval-probe.txt"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2..  5  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Bash"

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=10  insideFrame=false  isFindLastToolLineMatch=true  text="● Bash(touch /tmp/e2e-single-approval-probe.txt)"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2..  5  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Bash"

## frame #28 (iRule=15, iOpt=20)

### 1. 罫線行
- y=15  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:8947848|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=16  text="❯ "

### 4a. 枠内のコマンド行
- y=17  text="─────────────ty probe file at specified path"
  x=  0.. 12  fg=rgb:8947848|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "─────────────"

### 4b. 枠内の説明行
- y=19  text=" Do you want to proceed?"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=20  cursor=true  text=" ❯ 1. Yes"
    x=  1..  1  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  6..  8  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Yes"
- y=21  cursor=false  text="   2. Yes, and always allow access to tmp/ from this project"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x= 38.. 40  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "tmp"
- y=22  cursor=false  text="   3. No"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "3."
    x=  6..  7  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- y=10  tool=Bash  readable=true  args="touch /tmp/e2e-single-approval-probe.txt"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2..  5  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Bash"

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=10  insideFrame=false  isFindLastToolLineMatch=true  text="● Bash(touch /tmp/e2e-single-approval-probe.txt)"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2..  5  fg=default:-1|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "Bash"

## タブバー行(readTabBarRow、全フレーム走査)

- 検出されず(0 件)

