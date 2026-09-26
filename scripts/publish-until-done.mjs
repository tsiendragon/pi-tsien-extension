#!/usr/bin/env node
/**
 * Keep running `publish-packages.mjs` until every `pi-tsien-*` package is on the registry.
 *
 * npm throttles publishes per user (`E429 ... rate limited exceeded`) and does not publish the limit,
 * so a first-time bulk release of 26 packages cannot go out in a single pass. This driver runs the
 * resumable publisher, checks the registry itself, and waits out the throttle between passes.
 *
 * Usage (the token only ever lives in the child env, never on disk):
 *   sekret local exec tsien account -- node scripts/publish-until-done.mjs
 *
 * Env knobs: PUBLISH_MAX_ROUNDS (default 12), PUBLISH_ROUND_PAUSE_MS (default 600000),
 *            PUBLISH_DELAY_MS (per-package spacing, passed through to the publisher).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const maxRounds = Number(process.env.PUBLISH_MAX_ROUNDS ?? 12)
const roundPauseMs = Number(process.env.PUBLISH_ROUND_PAUSE_MS ?? 600_000)
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version ?? '0.1.0'
const names = readdirSync(join(root, 'packages'))
  .filter((name) => name.startsWith('pi-tsien-'))
  .sort()

// Must be async: blocking the main thread (Atomics.wait) while a registry fetch is pending makes Node
// exit with "Detected unsettled top-level await" and kills the whole run.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run the publisher for one pass; returns its exit code (4 = npm throttle still active). */
function run(args) {
  try {
    execFileSync(process.execPath, [join(root, 'scripts/publish-packages.mjs'), ...args], {
      stdio: 'inherit',
      env: process.env,
      cwd: root,
    })
    return 0
  } catch (error) {
    return typeof error.status === 'number' ? error.status : 1
  }
}

async function isPublished(name) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name}`, { headers: { accept: 'application/json' } })
    if (!response.ok) return false
    const body = await response.json()
    return Boolean(body['dist-tags']?.latest)
  } catch {
    return false
  }
}

for (let round = 1; round <= maxRounds; round += 1) {
  const missing = []
  for (const name of names) if (!(await isPublished(name))) missing.push(name)
  if (!missing.length) {
    console.log(`\n[round ${round}] all ${names.length} packages are on the registry ✅`)
    process.exit(0)
  }
  console.log(`\n[round ${round}/${maxRounds}] ${missing.length} missing: ${missing.join(', ')}`)

  // Probe with a single package first: retrying while throttled only keeps the window hot, and a
  // failed probe costs exactly one request.
  const probe = run(['--only=' + missing[0], '--attempts=1', '--delay=0'])
  if (probe !== 0) {
    console.log(`[round ${round}] still throttled (probe exit ${probe}); idling instead of hammering`)
    if (round < maxRounds) await sleep(roundPauseMs)
    continue
  }
  run([`--delay=${process.env.PUBLISH_DELAY_MS ?? 75000}`, '--attempts=1'])
  if (round < maxRounds) {
    console.log(`[round ${round}] waiting ${Math.round(roundPauseMs / 60000)} min for npm's throttle to relax`)
    await sleep(roundPauseMs)
  }
}

console.error('\nrounds exhausted; re-run me later to continue (the publisher skips what is already published)')
process.exit(1)