# 実行条件

- コマンド: `node tools/dump-attrs.js e2e-raw-t5-review.log --cols 120 --rows 40 --chunk 512`
- cols=120 rows=40 chunk=512
- 対象ログ: e2e-raw-t5-review.log
- 対象ログ sha256: b1d69fa3594a476d8cc740e9091c671f13039679ce1cec0e4d064af6d85223f4
- 総フレーム数: 78
- 承認枠(frameOf)検出回数: 11
- タブバー行(readTabBarRow)検出回数: 11
- production ゲート barRowIsCliDrawn()=true だったフレーム数: 11

# ダンプ本体

全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。

## frame #56 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"
  x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"

### 4a. 枠内のコマンド行
- y=17  text="好きな色はどちらですか?"
  x=  0.. 22  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな色はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. 赤"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "赤"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #57 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"
  x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"

### 4a. 枠内のコマンド行
- y=17  text="好きな色はどちらですか?"
  x=  0.. 22  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな色はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. 赤"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "赤"
- y=20  cursor=false  text="     情熱的で目を引く色"
    x=  5.. 21  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "情熱的で目を引く色"
- y=21  cursor=false  text="  2. 青"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "青"
- y=22  cursor=false  text="     落ち着いた印象の色"
    x=  5.. 21  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "落ち着いた印象の色"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #58 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"

### 4a. 枠内のコマンド行
- y=17  text="好きな飲み物はどちらですか?"
  x=  0.. 26  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな飲み物はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. コーヒー"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5.. 11  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "コーヒー"
- y=20  cursor=false  text="     苦味と香りが特徴"
    x=  5.. 19  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "苦味と香りが特徴"
- y=21  cursor=false  text="  2. 紅茶"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  7  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "紅茶"
- y=22  cursor=false  text="     雪や年末年始の季節"
    x=  5.. 21  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "雪や年末年始の季節"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #59 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"

### 4a. 枠内のコマンド行
- y=17  text="好きな時間帯はどちらですか?"
  x=  0.. 26  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな時間帯はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. 朝"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "朝"
- y=20  cursor=false  text="     静かで頭が冴える時間"
    x=  5.. 23  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "静かで頭が冴える時間"
- y=21  cursor=false  text="  2. 夜"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "夜"
- y=22  cursor=false  text="     落ち着いて集中できる時間"
    x=  5.. 27  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "落ち着いて集中できる時間"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #60 (iRule=13, iOpt=22)

### 1. 罫線行
- y=13  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=14  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"
  x= 71.. 71  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "→"

### 4a. 枠内のコマンド行
- y=16  text="Review your answers"

### 4b. 枠内の説明行
- y=18  text="⚠ You have not answered all questions"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=22  cursor=true  text="❯ 1. Submit answers"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
- y=23  cursor=false  text="  2. Cancel"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5.. 10  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Cancel"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #61 (iRule=14, iOpt=22)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text=""
  (非空セルなし)

### 4a. 枠内のコマンド行
- y=16  text="Review your answers"

### 4b. 枠内の説明行
- y=18  text="⚠ You have not answered all questions"

### 3. 選択肢行(iOpt から最初の空行まで)
- y=22  cursor=true  text="❯ 1. Submit answers"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
- y=23  cursor=false  text="  2. Cancel"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5.. 10  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "Cancel"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #62 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"

### 4a. 枠内のコマンド行
- y=17  text="好きな時間帯はどちらですか?"
  x=  0.. 26  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな時間帯はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. 朝"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "朝"
- y=20  cursor=false  text="     静かで頭が冴える時間"
    x=  5.. 23  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "静かで頭が冴える時間"
- y=21  cursor=false  text="  2. 夜"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "夜"
- y=22  cursor=false  text="     落ち着いて集中できる時間"
    x=  5.. 27  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "落ち着いて集中できる時間"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────"
    x=  0.. 71  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #63 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"

### 4a. 枠内のコマンド行
- y=17  text="好きな飲み物はどちらですか?"
  x=  0.. 26  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな飲み物はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. コーヒー"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5.. 11  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "コーヒー"
- y=20  cursor=false  text="     苦味と香りが特徴"
    x=  5.. 19  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "苦味と香りが特徴"
- y=21  cursor=false  text="  2. 紅茶"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  7  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "紅茶"
- y=22  cursor=false  text="     香り高く種類豊富"
    x=  5.. 19  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "香り高く種類豊富"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #64 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"
  x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"

### 4a. 枠内のコマンド行
- y=17  text="好きな色はどちらですか?"
  x=  0.. 22  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな色はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. 赤"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "赤"
- y=20  cursor=false  text="     情熱的で目を引く色"
    x=  5.. 21  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "情熱的で目を引く色"
- y=21  cursor=false  text="  2. 青"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "青"
- y=22  cursor=false  text="     雪や年末年始の季節"
    x=  5.. 21  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "雪や年末年始の季節"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #65 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☒ 好きな色  ☒ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"

### 4a. 枠内のコマンド行
- y=17  text="好きな飲み物はどちらですか?"
  x=  0.. 26  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな飲み物はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. コーヒー"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5.. 11  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "コーヒー"
- y=20  cursor=false  text="     桜や新緑の季節"
    x=  5.. 17  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "桜や新緑の季節"
- y=21  cursor=false  text="  2. 冬"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "冬"
- y=22  cursor=false  text="     雪や年末年始の季節"
    x=  5.. 21  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "雪や年末年始の季節"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## frame #66 (iRule=14, iOpt=19)

### 1. 罫線行
- y=14  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
  x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

### 2. 罫線の直下のラベル行
- y=15  text="←  ☒ 好きな色  ☒ 好きな季節  ☒ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →"

### 4a. 枠内のコマンド行
- y=17  text="好きな時間帯はどちらですか?"
  x=  0.. 26  fg=rgb:16777215|bg=default:-1|bold=1|dim=0|inverse=0|underline=0|italic=0  "好きな時間帯はどちらですか?"

### 4b. 枠内の説明行
- 観測されず(該当行が見つからなかった)

### 3. 選択肢行(iOpt から最初の空行まで)
- y=19  cursor=true  text="❯ 1. 朝"
    x=  0..  0  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "❯"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "1."
    x=  5..  5  fg=rgb:11647481|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "朝"
- y=20  cursor=false  text="     静かで頭が冴える時間"
    x=  5.. 23  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "静かで頭が冴える時間"
- y=21  cursor=false  text="  2. 夜"
    x=  2..  3  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "2."
    x=  5..  5  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "夜"
- y=22  cursor=false  text="     落ち着いて集中できる時間"
    x=  5.. 27  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "落ち着いて集中できる時間"
- y=23  cursor=false  text="  3. Type something."
- y=24  cursor=false  text="────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
    x=  0..119  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"
- y=25  cursor=false  text="  4. Chat about this"

### 5a. tool 行(findLastToolLine、production の export をそのまま使用)
- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)

### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)
- y=11  insideFrame=false  isFindLastToolLineMatch=false  text="● ユーザーに4つの質問をまとめて聞きます。"
    x=  0..  0  fg=rgb:16777215|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "●"
    x=  2.. 39  fg=default:-1|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "ユーザーに4つの質問をまとめて聞きます。"

## タブバー行(readTabBarRow、全フレーム走査)

- frame #56  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=12  inverse セル数=0
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"
- frame #57  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=12  inverse セル数=0
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"
- frame #58  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=16  inverse セル数=0
- frame #59  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=16  inverse セル数=0
- frame #60  y=14  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=10  inverse セル数=0
    x= 71.. 71  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "→"
- frame #62  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=16  inverse セル数=0
- frame #63  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=16  inverse セル数=0
- frame #64  y=15  text="←  ☐ 好きな色  ☐ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=12  inverse セル数=0
    x=  0..  0  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "←"
- frame #65  y=15  text="←  ☒ 好きな色  ☒ 好きな季節  ☐ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=16  inverse セル数=0
- frame #66  y=15  text="←  ☒ 好きな色  ☒ 好きな季節  ☒ 好きな飲み物  ☐ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=16  inverse セル数=0
- frame #67  y=14  text="←  ☒ 好きな色  ☒ 好きな季節  ☒ 好きな飲み物  ☒ 好きな時間帯  ✔ Submit  →                                                "
  production ゲート barRowIsCliDrawn()=true  観測(生カウント、ゲートではない): 背景色が既定でないセル数=10  inverse セル数=0
    x= 71.. 71  fg=rgb:10066329|bg=default:-1|bold=0|dim=0|inverse=0|underline=0|italic=0  "→"

