#!/usr/bin/env node
/**
 * Nightly memory review.
 *
 * Reads the pi-tsien-memory database read-only, then writes a plain-language digest plus
 * `promotion_proposals` rows so the dashboard can show what looks worth turning into a long-term
 * rule, a skill, or nothing at all.
 *
 * It never edits memory, never calls a model, and never writes outside the memory data directory:
 * a scheduled job that silently rewrote memory would be much harder to trust than a report.
 *
 * Usage: node scripts/memory-nightly.mjs [--days 30]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dataDir = process.env.PI_TSIEN_MEMORY_DIR?.trim() || join(homedir(), '.pi', 'tsien-memory')
const dbPath = join(dataDir, 'memory.db')
const outDir = join(dataDir, 'nightly')
const daysArg = process.argv.indexOf('--days')
const windowDays = daysArg > 0 ? Number(process.argv[daysArg + 1]) || 30 : 30

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (!existsSync(dbPath)) fail(`memory database not found: ${dbPath}`)

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = (sql, ...params) => {
  try {
    return db.prepare(sql).all(...params)
  } catch (error) {
    process.stderr.write(`query skipped: ${error.message}\n`)
    return []
  }
}

const counts = Object.fromEntries(rows('SELECT status, COUNT(*) AS n FROM memory_items GROUP BY status').map((row) => [row.status, Number(row.n)]))
const now = Date.now()
const windowStart = now - windowDays * 86_400_000

const ITEM_SQL = `
  SELECT i.id, i.kind, i.status, i.scope_type, i.confidence, i.observed_count, i.verified_count, i.applied_count,
         i.corrected_count, i.updated_at, v.content,
         (SELECT s.authority FROM memory_sources s WHERE s.revision_id = i.current_revision_id ORDER BY s.created_at DESC LIMIT 1) AS authority,
         (SELECT s.verified FROM memory_sources s WHERE s.revision_id = i.current_revision_id ORDER BY s.created_at DESC LIMIT 1) AS verified,
         (SELECT COUNT(*) FROM memory_relations r JOIN memory_items t ON t.id = r.to_memory_id
            WHERE r.from_memory_id = i.id AND r.relation = 'conflicts_with' AND t.status IN ('active','candidate','stale')) AS conflicts
    FROM memory_items i LEFT JOIN memory_revisions v ON v.id = i.current_revision_id`

const reviewable = rows(`${ITEM_SQL} WHERE i.status = 'candidate' ORDER BY i.updated_at DESC LIMIT 200`)
const reusable = rows(
  `${ITEM_SQL} WHERE i.status = 'active' AND i.kind IN ('experience','decision','preference')
     AND (i.observed_count + i.applied_count + i.verified_count) >= 2
     ORDER BY (i.verified_count * 3 + i.applied_count * 2 + i.observed_count) DESC LIMIT 30`,
)
const staleOld = rows(`SELECT COUNT(*) AS n FROM memory_items WHERE status = 'stale' AND updated_at < ?`, now - 90 * 86_400_000)
const candidatesOld = rows(`SELECT COUNT(*) AS n FROM memory_items WHERE status = 'candidate' AND updated_at < ?`, now - 30 * 86_400_000)
const rejected = rows(`SELECT COUNT(*) AS n FROM memory_items WHERE status = 'rejected'`)
const usage = rows(
  `SELECT i.id, v.content, COUNT(CASE WHEN a.outcome = 'injected' THEN 1 END) AS injected,
          COUNT(CASE WHEN a.outcome = 'verified' THEN 1 END) AS verified
     FROM application_events a LEFT JOIN memory_items i ON i.id = a.memory_id
     LEFT JOIN memory_revisions v ON v.id = i.current_revision_id
    WHERE a.created_at >= ? GROUP BY a.memory_id ORDER BY injected DESC LIMIT 10`,
  windowStart,
)

function typeFor(row) {
  const text = String(row.content ?? '')
  if (row.kind === 'experience' && text.length > 120) return 'skill'
  if (row.kind === 'preference' || text.length <= 160) return 'rule'
  return 'knowledge'
}

function strength(row) {
  if (Number(row.verified_count) > 0) return '强'
  if (Number(row.applied_count) >= 2) return '中'
  return '弱'
}

function reasonFor(row) {
  if (Number(row.conflicts) > 0) return `与 ${row.conflicts} 条记忆冲突`
  if (row.scope_type === 'global') return '想升级为全局记忆'
  if (Number(row.verified) !== 1) return '没有可核验来源'
  return '来源已验证，建议直接保留为长期记忆'
}

const reusablePlan = reusable.map((row) => ({
  id: row.id,
  kind: row.kind,
  suggestedType: typeFor(row),
  strength: strength(row),
  content: String(row.content ?? '').slice(0, 300),
  signals: { observed: Number(row.observed_count), applied: Number(row.applied_count), verified: Number(row.verified_count) },
}))
const reviewPlan = reviewable.map((row) => ({
  id: row.id,
  reason: reasonFor(row),
  content: String(row.content ?? '').slice(0, 300),
  authority: row.authority ?? 'unknown',
}))

const weak = reusablePlan.filter((item) => item.strength === '弱')
const digest = {
  generatedAt: new Date(now).toISOString(),
  windowDays,
  counts,
  reusable: reusablePlan,
  review: reviewPlan.slice(0, 20),
  cleanup: { staleOlderThan90Days: Number(staleOld[0]?.n ?? 0), candidatesOlderThan30Days: Number(candidatesOld[0]?.n ?? 0), rejected: Number(rejected[0]?.n ?? 0) },
  usage: usage.map((row) => ({ id: row.id, content: String(row.content ?? '').slice(0, 200), injected: Number(row.injected), verified: Number(row.verified) })),
}

const lines = [
  `# 记忆夜间总结 ${new Date(now).toISOString().slice(0, 10)}`,
  '',
  `统计范围：近 ${windowDays} 天使用信号 · 数据库 ${dbPath}`,
  '',
  '## 一句话',
  '',
  reusablePlan.length === 0
    ? '目前没有哪条记忆累积了足够的使用证据，先不急着变成规则或技能。'
    : `${reusablePlan.length} 条记忆值得考虑沉淀（其中 ${reusablePlan.filter((item) => item.strength !== '弱').length} 条有较强证据），${reviewPlan.length} 条候选还在等你判断。`,
  '',
  '## 现状',
  '',
  `- 生效 ${counts.active ?? 0} · 候选 ${counts.candidate ?? 0} · 过时 ${counts.stale ?? 0} · 已替代 ${counts.superseded ?? 0}`,
  `- 需要你确认的候选：${reviewPlan.filter((item) => item.reason !== '来源已验证，可自动采纳').length}`,
  '',
  '## 可以考虑沉淀的',
  '',
  ...(reusablePlan.length === 0
    ? ['（暂无）', '']
    : reusablePlan.flatMap((item) => [
        `### 建议做成 ${item.suggestedType}（证据${item.strength}）`,
        '',
        item.content,
        '',
        `信号：被检索 ${item.signals.observed} 次 · 被采用 ${item.signals.applied} 次 · 经验证 ${item.signals.verified} 次`,
        `记忆 ID：${item.id}`,
        '',
      ])),
  '## 需要你判断的',
  '',
  ...(reviewPlan.length === 0
    ? ['（没有待确认项）', '']
    : reviewPlan.slice(0, 20).flatMap((item) => [`- ${item.reason}：${item.content}（${item.id}）`])),
  '',
  '## 建议清理（仅建议，本次没有删除任何东西）',
  '',
  `- 超过 90 天未动的过时记忆：${digest.cleanup.staleOlderThan90Days}`,
  `- 超过 30 天未动的候选：${digest.cleanup.candidatesOlderThan30Days}`,
  `- 历史拒绝：${digest.cleanup.rejected}`,
  '',
  '## 证据强度说明',
  '',
  '- 强 = 有结果被确认的采用记录；中 = 多次被使用但没有结果确认；弱 = 只是被检索到。',
  '- 弱证据只说明“出现过”，不能据此认为记忆正确或有效；本报告不会因为次数多就自动升级。',
  ...(weak.length > 0 ? ['', `本次 ${weak.length} 条属于弱证据，建议继续观察。`] : []),
  '',
]

mkdirSync(outDir, { recursive: true, mode: 0o700 })
const stamp = new Date(now).toISOString().slice(0, 10)
const markdown = `${lines.join('\n')}\n`
writeFileSync(join(outDir, `${stamp}.md`), markdown, { mode: 0o600 })
writeFileSync(join(outDir, 'latest.md'), markdown, { mode: 0o600 })
writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(digest, null, 2)}\n`, { mode: 0o600 })
if (existsSync(join(outDir, 'latest.reading.json'))) renameSync(join(outDir, 'latest.reading.json'), join(outDir, 'latest.json.previous'))

// Proposals are advisory rows the dashboard lists; nothing is promoted automatically.
try {
  const write = new DatabaseSync(dbPath)
  const existing = new Set(write.prepare(`SELECT memory_id || ':' || suggested_type AS k FROM promotion_proposals`).all().map((row) => row.k))
  const insert = write.prepare(
    'INSERT INTO promotion_proposals (id, memory_id, status, suggested_type, bundle_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  let created = 0
  for (const item of reusablePlan) {
    const key = `${item.id}:${item.suggestedType}`
    if (existing.has(key)) continue
    insert.run(`proposal_${item.id}_${item.suggestedType}`.slice(0, 80), item.id, 'proposed', item.suggestedType, JSON.stringify({ source: 'nightly', strength: item.strength, signals: item.signals, content: item.content }), now, now)
    created += 1
  }
  write.close()
  process.stdout.write(`nightly review: ${reusablePlan.length} reusable, ${reviewPlan.length} pending review, ${created} new proposal(s)\n`)
} catch (error) {
  process.stdout.write(`nightly review: report written, proposals skipped (${error.message})\n`)
}

db.close()
process.stdout.write(`report: ${join(outDir, 'latest.md')}\n`)
void readFileSync