# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-mcp.log --cols 120 --rows 40 --chunk 512`
- cols=120 rows=40 chunk=512
- 対象ログ: e2e-raw-mcp.log
- 対象ログ sha256: 3680b3c39b0a4617e0e188a96a9b83bc70e8b5dbcd747ff7d7b20526b187c335
- 総フレーム数: 32
- 承認枠(frameOf)検出回数: 2
- タブバー行(readTabBarRow)検出回数: 0
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 0

[警告] タブバー行が 1 度も見つからなかった。幾何(cols=120 rows=40)が 録画時と違うか、chunk=512 が粗すぎる可能性がある。「このログにタブバーが無い」と断定しないこと。

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #27 (iRule=11, iOpt=18)

### 1. 罫線行
- y=11  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=12  text=" Tool use"

### 4a. 枠内のコマンド行
- y=14  text="   playwright - Navigate to a URL(url: \"https://example.com/\") (MCP)"
  x= 63.. 67  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "(MCP)"

### 4b. 枠内の説明行
- y=15  text="   Navigate to a URL"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=18  cursor=true  text=" ❯ 1. Yes"
    x=  1..  1  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  6..  8  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Yes"
- y=19  cursor=false  text="   2. Yes, and don't ask again for playwright - Navigate to a URL commands in"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
- y=20  cursor=false  text="      /home/xxxxxx/projects/YATA-NODE/claude-approval-server"
- y=21  cursor=false  text="   3. No"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "3."
    x=  6..  7  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=9  insideFrame=false  isFindLastToolLineMatch=false  text="● Calling playwright... (ctrl+o to expand)"
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"

## frame #29 (iRule=15, iOpt=18)

### 1. 罫線行
- y=15  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:8947848|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=16  text="  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart with CLAUDE_CODE_FORCE_SESSION_PERS..."

### 4a. 枠内のコマンド行
- y=17  text="  c you want to proceed?"
  x=  2..  2  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "c"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=18  cursor=true  text=" ❯ 1. Yes"
    x=  1..  1  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  6..  8  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Yes"
- y=19  cursor=false  text="   2. Yes, and don't ask again for playwright - Navigate to a URL commands in"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
- y=20  cursor=false  text="      /home/xxxxxx/projects/YATA-NODE/claude-approval-server"
- y=21  cursor=false  text="   3. No"
    x=  3..  4  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "3."
    x=  6..  7  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "No"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- 観測されず

## タブバー行(readTabBarRow、全フレーム走査)

- 検出されず(0 件)

