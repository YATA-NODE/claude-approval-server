'use strict'

// test-pii-scan.js
//
// Scans this repository for accidentally-committed home-path identifiers
// (POSIX, macOS, Windows drive-letter/UNC, WSL /mnt mount forms; see
// tools/lib-redact.js findHomePathIdentifiers()). Invariants:
//  - Violation output never includes the raw value/path/line unless
//    PII_SCAN_REVEAL=1 AND not running in CI (GITHUB_ACTIONS truthy disables
//    reveal unconditionally, checked first, before anything else runs).
//  - Self-test fixtures are assembled at runtime from string fragments so the
//    full violation shape never appears as a contiguous literal in this file's
//    own source (this file is itself scanned by the HEAD walk below).
//
// Usage: node test-pii-scan.js [--range <base>..<head>]

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, spawnSync } = require('child_process')
const { findHomePathIdentifiers } = require('./tools/lib-redact.js')

const REPO_ROOT = __dirname
// bobsmith / alicejones / carollee: synthetic Windows-path fixture names in the same
// test-lib-redact.js [C12] block (drive-letter / lowercase-drive / UNC forms respectively;
// none are real people).
const ALLOWLIST = new Set(['user', 'username', 'alice', 'example', 'xxxxxx', 'bobsmith', 'alicejones', 'carollee'])

// Known-binary ledger: tracked binary files that are pre-cleared as containing no PII
// (visually reviewed), keyed by path with a content-hash binding. A NUL-containing file
// only passes when BOTH the path is listed AND its current sha256 matches the ledger
// value; otherwise (unlisted path, or listed path with changed content) it still fails
// closed as kind=binary, same as before this ledger existed.
const KNOWN_BINARY_LEDGER = new Map([
  ['docs/images/approval-panel-mobile.png', '765d60874536bdbfec45138e231877741aabcf1a5ca2515b8b7f9763c182620b'],
  ['docs/images/approval-panel-multi-text.png', 'f656c8c6dade576e526621d207bc808ccfc56f25fad51d6613768aa9abf8d2bd'],
])

function isKnownBinary(relPath, buf) {
  const expected = KNOWN_BINARY_LEDGER.get(relPath)
  if (!expected) return false
  const actual = crypto.createHash('sha256').update(buf).digest('hex')
  return actual === expected
}

function isTruthyEnv(v) {
  return v === 'true' || v === '1' || v === 'yes'
}

function isCI() {
  return isTruthyEnv(process.env.GITHUB_ACTIONS)
}

function revealAllowed() {
  return process.env.PII_SCAN_REVEAL === '1' && !isCI()
}

// CI guard: reveal mode must never be reachable in CI. This is the very first thing the
// process does (before self-test, before scanning) so a subprocess re-invocation with this
// env combo exits immediately without doing any real work.
if (isCI() && process.env.PII_SCAN_REVEAL === '1') {
  console.error('pii-scan: PII_SCAN_REVEAL=1 is not allowed when GITHUB_ACTIONS is set')
  process.exit(1)
}

let violationSeq = 0
let violationCount = 0

// Fixed-format violation line. detail (name/path/line) is appended only when
// revealAllowed() is true, and only for local debugging convenience.
function reportViolation(kind, pattern, detail) {
  violationSeq += 1
  violationCount += 1
  let line = `violation #${violationSeq} kind=${kind} pattern=${pattern}`
  if (revealAllowed() && detail) {
    if (detail.name !== undefined) line += ` name=${detail.name}`
    if (detail.path !== undefined) line += ` path=${detail.path}`
    if (detail.line !== undefined) line += ` line=${detail.line}`
  }
  console.log(line)
}

// ---------------------------------------------------------------------------
// Step 1: self-test (the detector's own positive/negative fixtures)
// ---------------------------------------------------------------------------

// Fragment-joined at runtime: no contiguous violation-shaped literal exists in this
// file's source text, so the HEAD content scan (step 2) never flags this fixture data.
function buildRejectCases() {
  const n1 = ['zz', 'synth1'].join('')
  const n2 = ['zz', 'synth2'].join('')
  const n3 = ['zz', 'synth3'].join('')
  const n4 = ['zz', 'synth4'].join('')
  const n5 = ['zz', 'synth5'].join('')
  const n6 = ['zz', 'synth6'].join('')
  return [
    { form: 'posix', name: n1, text: ['', 'home', n1].join('/') },
    { form: 'macos', name: n2, text: ['', 'Users', n2].join('/') },
    { form: 'windows', name: n3, text: ['C:', 'Users', n3].join('\\') },
    { form: 'wsl', name: n4, text: ['', 'mnt', 'c', 'Users', n4].join('/') },
    // Double-escaped (JSON-serialization style, two backslashes per separator).
    { form: 'windows', name: n5, text: ['C:', 'Users', n5].join('\\\\') },
    // Forward-slash separated Windows form.
    { form: 'windows', name: n6, text: ['C:', 'Users', n6].join('/') },
  ]
}

// These transformed values must NOT be detected under the current shape regexes (no raw
// "/home/" etc substring survives the transform); this pins that documented boundary.
function buildOutOfScopeCases() {
  return ['%2Fhome%2F' + ['zz', 'synth7'].join(''), '\\/home\\/' + ['zz', 'synth8'].join('')]
}

function isCiGuardEnforced() {
  const res = spawnSync(process.execPath, [__filename], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { GITHUB_ACTIONS: 'true', PII_SCAN_REVEAL: '1' }),
    encoding: 'utf8',
  })
  return res.status !== 0
}

function runSelfTest() {
  let ok = true
  const problems = []
  const buffer = []
  const savedLog = console.log
  const savedErr = console.error
  const savedSeq = violationSeq
  const savedCount = violationCount
  const savedReveal = process.env.PII_SCAN_REVEAL
  console.log = (l) => buffer.push(String(l))
  console.error = (l) => buffer.push(String(l))
  violationSeq = 0
  violationCount = 0
  // Force the non-reveal path for this probe regardless of the ambient env, so the
  // non-exposure assertion below is meaningful no matter how this script was invoked.
  delete process.env.PII_SCAN_REVEAL

  try {
    const rejectCases = buildRejectCases()
    for (const c of rejectCases) {
      const hits = findHomePathIdentifiers(c.text)
      if (!hits.some((h) => h.form === c.form && h.name === c.name)) {
        ok = false
        problems.push(`reject case not detected: form=${c.form}`)
        continue
      }
      for (const h of hits) reportViolation('content', h.form, { name: h.name })
    }

    for (const t of buildOutOfScopeCases()) {
      if (findHomePathIdentifiers(t).length !== 0) {
        ok = false
        problems.push('out-of-scope transform unexpectedly detected')
      }
    }

    for (const name of ALLOWLIST) {
      const hits = findHomePathIdentifiers(['', 'home', name].join('/'))
      if (hits.some((h) => !ALLOWLIST.has(h.name))) {
        ok = false
        problems.push(`allowlisted name flagged as violation: ${name}`)
      }
    }

    // bobsmith / alicejones / carollee are only ever seen in this repo in their real
    // Windows-path fixture shapes (test-lib-redact.js [C12]), not the generic /home/ shape
    // covered by the loop above. Paired allow-cases so an allowlist addition always ships
    // with its own fixture.
    {
      const winFormCases = [
        ['C:', 'Users', 'bobsmith'].join('\\'), // drive-letter form
        ['c:', 'users', 'alicejones'].join('\\'), // lowercase-drive form
        ['', '', 'fileserver', 'Users', 'carollee'].join('\\'), // UNC form
      ]
      for (const t of winFormCases) {
        const hits = findHomePathIdentifiers(t)
        if (hits.some((h) => !ALLOWLIST.has(h.name))) {
          ok = false
          problems.push(`allowlisted name flagged as violation (windows form): ${t}`)
        }
      }
    }

    for (const v of ['process.env.HOME', 'os.homedir()', '$HOME', '~/']) {
      if (findHomePathIdentifiers(v).length !== 0) {
        ok = false
        problems.push(`variable-reference form falsely detected: ${v}`)
      }
    }

    // Known-binary ledger: (a) a listed path with matching content passes, (b) an unlisted
    // binary (synthetic NUL content) still fails closed, (c) a listed path with content
    // that no longer matches its recorded hash still fails closed.
    {
      const ledgerPath = [...KNOWN_BINARY_LEDGER.keys()][0]
      try {
        const realBuf = fs.readFileSync(path.join(REPO_ROOT, ledgerPath))
        if (!isKnownBinary(ledgerPath, realBuf)) {
          ok = false
          problems.push(`known-binary ledger: matching real file did not pass: ${ledgerPath}`)
        }
      } catch (e) {
        ok = false
        problems.push(`known-binary ledger: could not read real ledgered file: ${ledgerPath}`)
      }

      const tmpFile = path.join(os.tmpdir(), `pii-scan-selftest-${process.pid}-${Date.now()}.bin`)
      try {
        fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x00, 0x01, 0x02, 0x00, 0x03]))
        const tmpBuf = fs.readFileSync(tmpFile)
        if (!tmpBuf.includes(0)) {
          ok = false
          problems.push('known-binary ledger: temp NUL fixture did not contain a NUL byte')
        }
        if (isKnownBinary('not/in/ledger.bin', tmpBuf)) {
          ok = false
          problems.push('known-binary ledger: unlisted synthetic binary incorrectly passed')
        }
      } finally {
        try {
          fs.unlinkSync(tmpFile)
        } catch (e) {
          // best-effort cleanup
        }
      }

      const wrongContentBuf = Buffer.from([0x00, 0x01, 0x02, 0x03])
      if (isKnownBinary(ledgerPath, wrongContentBuf)) {
        ok = false
        problems.push(`known-binary ledger: content-mismatched listed path incorrectly passed: ${ledgerPath}`)
      }
    }

    // Non-exposure: none of the reject-case names may appear in the captured output of
    // the real reportViolation() path exercised above.
    const joined = buffer.join('\n')
    for (const c of rejectCases) {
      if (joined.includes(c.name)) {
        ok = false
        problems.push('reject-case name leaked into self-test output')
      }
    }
  } finally {
    console.log = savedLog
    console.error = savedErr
    violationSeq = savedSeq
    violationCount = savedCount
    if (savedReveal === undefined) delete process.env.PII_SCAN_REVEAL
    else process.env.PII_SCAN_REVEAL = savedReveal
  }

  if (!isCiGuardEnforced()) {
    ok = false
    problems.push('CI guard subprocess did not exit non-zero')
  }

  if (!ok) for (const p of problems) console.error(`[self-test] ${p}`)
  return ok
}

// ---------------------------------------------------------------------------
// Step 2 + 3: HEAD walk (tracked file paths + contents) with a local-only
// "self-value" layer (own homedir literal / own username inside a path shape).
// ---------------------------------------------------------------------------

function scanHead() {
  const localExtra = !isCI()
  const homeDir = os.homedir()
  const username = os.userInfo().username

  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  })
  const files = raw.split('\0').filter(Boolean)

  for (const relPath of files) {
    const pathHits = findHomePathIdentifiers(relPath)
    for (const h of pathHits) {
      if (!ALLOWLIST.has(h.name)) {
        reportViolation('path', h.form, { name: h.name, path: relPath })
      } else if (localExtra && h.name === username) {
        reportViolation('path', 'self-value', { name: h.name, path: relPath })
      }
    }
    if (localExtra && homeDir && relPath.includes(homeDir)) {
      reportViolation('path', 'self-value', { path: relPath })
    }

    const abs = path.join(REPO_ROOT, relPath)
    let buf
    try {
      buf = fs.readFileSync(abs)
    } catch (e) {
      continue // unreadable (e.g. dangling symlink); not a PII finding
    }
    if (buf.includes(0)) {
      if (!isKnownBinary(relPath, buf)) {
        reportViolation('binary', 'binary', { path: relPath })
      }
      continue
    }
    // Scanned per line (not once over the whole text): none of the 4 shape regexes can
    // match across a newline (both the prefix and the name char class exclude \s), so this
    // loses no matches, and the loop index gives an exact line number for free. Scanning
    // the whole text once and then back-computing a line via text.indexOf(h.name) picks
    // the FIRST occurrence of that name in the file for every hit that shares the name,
    // so repeated occurrences all report the same (wrong) line -- observed for real on
    // test-parse-dialog.js (6 violations, all reported as the same line).
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]
      const lineNo = i + 1
      for (const h of findHomePathIdentifiers(lineText)) {
        if (!ALLOWLIST.has(h.name)) {
          reportViolation('content', h.form, { name: h.name, path: relPath, line: lineNo })
        } else if (localExtra && h.name === username) {
          reportViolation('content', 'self-value', { name: h.name, path: relPath, line: lineNo })
        }
      }
      if (localExtra && homeDir && lineText.includes(homeDir)) {
        reportViolation('content', 'self-value', { path: relPath, line: lineNo })
      }
    }
  }

  return files.length
}

// ---------------------------------------------------------------------------
// Step 4: --range <base>..<head> commit/diff scan (opt-in)
// ---------------------------------------------------------------------------

function parseRangeArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    let val = null
    if (argv[i] === '--range' && argv[i + 1] !== undefined) val = argv[i + 1]
    else if (argv[i].startsWith('--range=')) val = argv[i].slice('--range='.length)
    if (val !== null) {
      const idx = val.indexOf('..')
      if (idx === -1) return null
      return { base: val.slice(0, idx), head: val.slice(idx + 2) }
    }
  }
  return null
}

function scanRange(base, head) {
  let shallow
  try {
    shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim()
  } catch (e) {
    console.error('range-scan: failed to check shallow-repository state (fail)')
    return false
  }
  if (shallow !== 'false') {
    console.error('range-scan: shallow repository is not supported (fail)')
    return false
  }

  let baseSha, headSha
  try {
    baseSha = execFileSync('git', ['rev-parse', `${base}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    headSha = execFileSync('git', ['rev-parse', `${head}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch (e) {
    console.error('range-scan: could not resolve base/head to a commit SHA (fail)')
    return false
  }

  let commits
  try {
    const out = execFileSync('git', ['log', '--format=%H', `${baseSha}..${headSha}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
    })
    commits = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (e) {
    console.error('range-scan: failed to enumerate commits in range (fail)')
    return false
  }

  let ok = true
  for (const sha of commits) {
    let message
    try {
      message = execFileSync('git', ['log', '-1', '--format=%B', sha], { cwd: REPO_ROOT, encoding: 'utf8' })
    } catch (e) {
      console.error(`range-scan: failed to read commit message for ${sha.slice(0, 12)} (fail)`)
      ok = false
      continue
    }
    // Scanned per line, same reason as scanHead()'s content loop above (avoids the
    // first-occurrence-only bug of a whole-text indexOf-based line lookup).
    const messageLines = message.split('\n')
    for (let i = 0; i < messageLines.length; i++) {
      const lineNo = i + 1
      for (const h of findHomePathIdentifiers(messageLines[i])) {
        if (!ALLOWLIST.has(h.name)) {
          reportViolation('message', h.form, { name: h.name, path: `commit:${sha}`, line: lineNo })
          ok = false
        }
      }
    }

    let diff
    try {
      diff = execFileSync('git', ['show', '-p', '-m', '--unified=0', '--format=', sha], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 256,
      })
    } catch (e) {
      console.error(`range-scan: failed to read diff for ${sha.slice(0, 12)} (fail)`)
      ok = false
      continue
    }

    for (const line of diff.split('\n')) {
      if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
        reportViolation('binary', 'binary', { path: `commit:${sha}` })
        ok = false
        continue
      }
      if (line.startsWith('+++') || line.startsWith('---')) {
        for (const h of findHomePathIdentifiers(line)) {
          if (!ALLOWLIST.has(h.name)) {
            reportViolation('path', h.form, { name: h.name, path: `commit:${sha}` })
            ok = false
          }
        }
        continue
      }
      if (line.startsWith('+')) {
        const content = line.slice(1)
        for (const h of findHomePathIdentifiers(content)) {
          if (!ALLOWLIST.has(h.name)) {
            reportViolation('content', h.form, { name: h.name, path: `commit:${sha}` })
            ok = false
          }
        }
      }
    }
  }

  return ok
}

// ---------------------------------------------------------------------------
// Policy version: sha256(first 16 hex chars) of pattern/allowlist/execution
// description plus this file's and lib-redact.js's own content, key-sorted.
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function computePolicyVersion() {
  const selfSource = fs.readFileSync(__filename, 'utf8')
  const libSource = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'lib-redact.js'), 'utf8')
  const payload = {
    allowlist: Array.from(ALLOWLIST).sort(),
    execution:
      'self-test(reject/allow fixtures + non-exposure + CI-guard subprocess) -> ' +
      'git ls-files path+content scan -> local-only self-value scan -> optional --range commit/diff scan',
    patterns: {
      posix: 'home directory prefix, POSIX separator',
      macos: 'Users directory prefix, POSIX separator',
      windows:
        'drive-letter or UNC prefix + Users, backslash or forward-slash separator, case-folded, double-backslash collapsed',
      wsl: 'mnt mount prefix + single drive letter + Users, "Users" literal case-folded only',
    },
    libRedactSource: libSource,
    selfSource,
  }
  const json = stableStringify(payload)
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const selfTestOk = runSelfTest()

  const scannedCount = scanHead()

  const rangeArg = parseRangeArg(process.argv.slice(2))
  let rangeOk = true
  if (rangeArg) {
    rangeOk = scanRange(rangeArg.base, rangeArg.head)
  }

  console.log(`scanned files=${scannedCount} violations=${violationCount}`)
  console.log(`policy version=${computePolicyVersion()}`)

  const failed = !selfTestOk || violationCount > 0 || !rangeOk
  process.exit(failed ? 1 : 0)
}

main()
