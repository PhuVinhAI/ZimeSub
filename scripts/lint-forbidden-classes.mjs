#!/usr/bin/env node
/**
 * Reject forbidden Tailwind utilities in source files.
 *
 * The ZimeSub style guide is pure flat — no shadow, no gradient, no blur.
 * Anywhere `shadow-*`, `bg-gradient-*`, `backdrop-blur-*`, or `drop-shadow-*`
 * appears in `src/` or `index.html`, the build/lint must fail loudly.
 *
 * Wired in `package.json` as `lint:classes` and runs before ESLint.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

// Scan source + the HTML entry. node_modules / dist / src-tauri are skipped.
const SCAN_ROOTS = ['src', 'index.html']

const ALLOWED_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.md',
  '.mdx'
])

const SKIP_DIRS = new Set(['node_modules', 'dist', 'src-tauri', 'target', '.git'])

/**
 * Regexes targeted at Tailwind utility class names. Each must:
 *  - anchor on a word boundary so identifiers like `dropShadowEnabled` don't trip
 *  - allow Tailwind suffixes including arbitrary values `[...]`
 */
const FORBIDDEN = [
  { name: 'shadow-*', re: /\bshadow-(?:none|inner|xs|sm|md|lg|xl|2xl|\[[^\]]+\])\b/g },
  { name: 'bg-gradient-*', re: /\bbg-gradient-(?:to-[trbl]{1,2}|radial|conic)[\w/\-[\]]*/g },
  { name: 'backdrop-blur-*', re: /\bbackdrop-blur(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|\[[^\]]+\]))?\b/g },
  { name: 'drop-shadow-*', re: /\bdrop-shadow(?:-(?:none|xs|sm|md|lg|xl|2xl|\[[^\]]+\]))?\b/g }
]

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && ALLOWED_EXTS.has(extname(entry.name))) {
      yield full
    }
  }
}

async function* targets() {
  for (const root of SCAN_ROOTS) {
    const abs = resolve(REPO_ROOT, root)
    let s
    try {
      s = await stat(abs)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    if (s.isDirectory()) {
      yield* walk(abs)
    } else if (s.isFile() && ALLOWED_EXTS.has(extname(abs))) {
      yield abs
    }
  }
}

const JS_LIKE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const CSS_LIKE = new Set(['.css', '.scss'])
const HTML_LIKE = new Set(['.html'])

/**
 * Replace comment bodies with spaces of equal length so that we can scan
 * code-only content while preserving line/column numbers for error reporting.
 *
 * Conservative: doesn't try to handle every edge case (e.g. // inside string
 * literals); but for the purpose of catching forbidden Tailwind utilities in
 * actual class lists this is more than enough.
 */
function maskNonCode(content, ext) {
  const maskBlock = m => m.replace(/[^\n]/g, ' ')
  let out = content
  if (JS_LIKE.has(ext)) {
    out = out.replace(/\/\*[\s\S]*?\*\//g, maskBlock)
    out = out.replace(/\/\/[^\n]*/g, maskBlock)
  }
  if (CSS_LIKE.has(ext)) {
    out = out.replace(/\/\*[\s\S]*?\*\//g, maskBlock)
  }
  if (HTML_LIKE.has(ext)) {
    out = out.replace(/<!--[\s\S]*?-->/g, maskBlock)
  }
  return out
}

function findOffenses(content) {
  const offenses = []
  for (const { name, re } of FORBIDDEN) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content)) !== null) {
      const lineStart = content.lastIndexOf('\n', m.index) + 1
      const lineEnd = content.indexOf('\n', m.index)
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      const lineNumber = content.slice(0, m.index).split('\n').length
      const column = m.index - lineStart + 1
      offenses.push({
        rule: name,
        match: m[0],
        line: lineNumber,
        column,
        snippet: line.trim()
      })
    }
  }
  return offenses
}

async function main() {
  // Allow self-exempt: this very script documents the forbidden patterns in
  // its own regex source, so excluding it is necessary to avoid false hits.
  const SELF = resolve(fileURLToPath(import.meta.url))
  let totalOffenses = 0
  let scanned = 0

  for await (const file of targets()) {
    if (file === SELF) continue
    scanned += 1
    const content = await readFile(file, 'utf8')
    const scannable = maskNonCode(content, extname(file))
    const offenses = findOffenses(scannable)
    if (offenses.length === 0) continue
    totalOffenses += offenses.length
    const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
    for (const o of offenses) {
      console.error(
        `${rel}:${o.line}:${o.column}  forbidden utility "${o.match}" (rule: ${o.rule})\n    ${o.snippet}`
      )
    }
  }

  if (totalOffenses > 0) {
    console.error(
      `\nlint:classes — ${totalOffenses} forbidden utility usage(s) found in ${scanned} file(s).`
    )
    console.error(
      'See docs/style-guide.md — ZimeSub is pure flat: no shadow / no gradient / no blur.'
    )
    process.exit(1)
  }

  console.log(`lint:classes — clean (${scanned} files scanned).`)
}

main().catch(err => {
  console.error(err)
  process.exit(2)
})
