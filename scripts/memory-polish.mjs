#!/usr/bin/env node
/**
 * Memory polish pass.
 *
 * Finds memories that are hard to read — written mostly in another language, or long enough that the
 * durable fact is buried — and asks a model for a concise Simplified-Chinese rewrite.
 *
 * This script never writes to the memory database. It only writes proposals under
 * `~/.pi/tsien-memory/polish/`, because a rewrite can quietly change meaning and that has to be a
 * human decision. Apply an approved rewrite with the ordinary memory tools.
 *
 * Usage:
 *   node --import tsx scripts/memory-polish.mjs [--limit 10] [--model provider/model]
 * Default model is openai-codex/gpt-5.6-luna; override with --model or PI_MEMORY_POLISH_MODEL.
 * With --report-only it lists what needs work and calls no model.
 */
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir = process.env.PI_TSIEN_MEMORY_DIR?.trim() || join(homedir(), '.pi', 'tsien-memory')
const dbPath = join(dataDir, 'memory.db')
const outDir = join(dataDir, 'polish')
const manifestPath = join(outDir, 'manifest.json')

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : fallback
}

const limit = Math.min(Math.max(Number(arg('--limit', 10)) || 10, 1), 50)
const reportOnly = process.argv.includes('--report-only')
const model = arg('--model', process.env.PI_MEMORY_POLISH_MODEL?.trim()) || 'openai-codex/gpt-5.6-luna'
const timeoutMs = Number(process.env.PI_MEMORY_POLISH_TIMEOUT_MS) || 90_000
const piBin = process.env.PI_MEMORY_PI_BIN?.trim() || 'pi'

if (!existsSync(dbPath)) {
  process.stderr.write(`memory database not found: ${dbPath}\n`)
  process.exit(1)
}

function cjkRatio(text) {
  const visible = String(text).replace(/\s/gu, '')
  if (!visible) return 0
  const cjk = visible.match(/[\u4e00-\u9fff]/gu)?.length ?? 0
  return cjk / visible.length
}

/** Identifiers that must survive a rewrite untouched: paths, URLs, versions, snake/camel names. */
function anchors(text) {
  const found = String(text).match(/[A-Za-z0-9][A-Za-z0-9_./:@-]{2,}/gu) ?? []
  // Only machine-ish tokens must survive translation: paths, versions, ids, code names. Plain English
  // words are expected to disappear, so treating them as anchors would reject every good rewrite.
  const cleaned = found.map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, '')).filter((token) => token.length > 2)
  return [...new Set(cleaned.filter((token) => /[0-9]/u.test(token) || /[_/:@]/u.test(token) || /[A-Z]{2}/u.test(token) || /[a-z][A-Z]/u.test(token)))]
}

function needReasons(content) {
  const reasons = []
  if (cjkRatio(content) < 0.5) reasons.push('不是中文')
  if (String(content).length > 160) reasons.push('太长')
  if (/(?:^|\n)\s*[-*]\s/u.test(content) || content.split('\n').length > 3) reasons.push('结构松散')
  return reasons
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare(
    `SELECT i.id, i.kind, i.status, v.content
       FROM memory_items i JOIN memory_revisions v ON v.id = i.current_revision_id
      WHERE i.status IN ('active','candidate')
      ORDER BY i.updated_at DESC`,
  )
  .all()
db.close()

const targets = rows.map((row) => ({ ...row, reasons: needReasons(String(row.content ?? '')) })).filter((row) => row.reasons.length > 0)

function rewrite(content) {
  const prompt = `把下面这条记忆改写为简体中文，要求：
1. 只保留长期有效的事实，一句话说清，不超过 120 字；
2. 所有标识符、路径、版本号、数字、URL、产品名、代码名必须原样保留，不要翻译；
3. 不新增、不推断任何原句没有的信息；不确定就保守一点；
4. 只输出改写后的文本本身，不要解释、不要加引号、不要 markdown 代码块。

原文：
${content}`
  // --no-context-files keeps the user's reply rules (for example a required chat prefix) out of
  // the rewrite, otherwise the polish output inherits them.
  const result = spawnSync(piBin, ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--model', model], {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) return { error: result.error?.message ?? `exit ${result.status}` }
  const cleaned = String(result.stdout ?? '')
    .trim()
    .replace(/^```[a-z]*\n?|```$/gu, '')
    .replace(/^喵[：:\s]+/u, '')
    .trim()
  return { text: cleaned }
}

function verify(before, after) {
  const problems = []
  if (!after) problems.push('模型没有返回内容')
  // Identifier-dense memories keep the Latin share high, so require real Chinese instead of a ratio.
  const cjkChars = (String(after).match(/[\u4e00-\u9fff]/gu) ?? []).length
  if (after && cjkChars < 12) problems.push('改写后中文太少')
  if (after && after.length > Math.min(240, Math.max(before.length, 40) * 1.2)) problems.push('改写后更长')
  const missing = anchors(before).filter((token) => token.length > 2 && !after?.includes(token))
  if (missing.length > 0) problems.push(`丢失标识符：${missing.slice(0, 5).join(', ')}`)
  return problems
}

const manifest = (() => {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
})()
const known = new Set(manifest.map((entry) => entry.memoryId))

mkdirSync(outDir, { recursive: true, mode: 0o700 })
const summary = []
let proposed = 0
for (const target of targets.slice(0, limit)) {
  if (known.has(target.id)) continue
  const before = String(target.content ?? '')
  if (reportOnly) {
    summary.push(`- 需要润色（${target.reasons.join('、')}）：${before.slice(0, 80)}…（${target.id}）`)
    continue
  }
  const result = rewrite(before)
  if (result.error) {
    summary.push(`- 跳过（模型不可用：${result.error}）：${target.id}`)
    continue
  }
  const problems = verify(before, result.text ?? '')
  const entry = {
    memoryId: target.id,
    kind: target.kind,
    status: 'proposed',
    reasons: target.reasons,
    before,
    after: result.text ?? '',
    checks: problems,
    model,
    createdAt: Date.now(),
  }
  manifest.push(entry)
  if (problems.length === 0) proposed += 1
  summary.push(`- ${problems.length === 0 ? '可发布草稿' : `需人工检查（${problems.join('；')}）`}：${before.slice(0, 60)}…（${target.id}）`)
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
const markdown = [
  `# 记忆润色 ${new Date().toISOString().slice(0, 10)}`,
  '',
  `- 需要润色的记忆：${targets.length}（本次处理 ${Math.min(targets.length, limit)}）`,
  `- 可用草稿：${proposed}`,
  `- 模型：${model ?? '未启用（只列出需要润色的记忆）'}`,
  '',
  '## 明细',
  '',
  ...(summary.length > 0 ? summary : ['- 没有需要润色的记忆。']),
  '',
  '## 说明',
  '',
  '- 本脚本只写草稿，不修改记忆库：改写可能悄悄改变含义，必须人工确认。',
  '- 确认后可用 memory_update 应用，旧版本仍可回滚。',
  '',
].join('\n')
writeFileSync(join(outDir, 'latest.md'), markdown, { mode: 0o600 })
process.stdout.write(`polish: ${targets.length} need work, ${proposed} clean proposals, ${manifest.length} total in manifest\n`)
process.stdout.write(`report: ${join(outDir, 'latest.md')}\n`)