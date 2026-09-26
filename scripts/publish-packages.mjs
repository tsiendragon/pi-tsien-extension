#!/usr/bin/env node
/**
 * Publish every `packages/pi-tsien-*` package to the public npm registry.
 *
 * Why a script instead of 26 manual `npm publish` calls:
 *  - the packages depend on each other, so the order has to be topological;
 *  - publishing is resumable: a version that is already on the registry is skipped,
 *    so a failed run can simply be re-run;
 *  - the token never touches disk: a throwaway userconfig with `${NPM_TOKEN}` is written to the
 *    system temp dir and deleted afterwards, and the value only ever exists in the child env.
 *
 * Usage:
 *   NPM_TOKEN=... node scripts/publish-packages.mjs            # publish what is missing
 *   NPM_TOKEN=... node scripts/publish-packages.mjs --dry-run   # show tarballs + order, publish nothing
 *
 * Get NPM_TOKEN from the local vault (never echo it):
 *   sekret local exec tsien account -- node scripts/publish-packages.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REGISTRY = 'https://registry.npmjs.org/'
const root = new URL('..', import.meta.url).pathname
const packagesDir = join(root, 'packages')
const dryRun = process.argv.includes('--dry-run')

/** @returns {Array<{ name: string, dir: string, version: string, deps: string[] }>} */
function readPackages() {
  return readdirSync(packagesDir)
    .filter((name) => name.startsWith('pi-tsien-'))
    .map((name) => {
      const dir = join(packagesDir, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
      return {
        name: manifest.name,
        dir,
        version: manifest.version,
        deps: Object.keys(manifest.dependencies ?? {}),
      }
    })
    .filter((pkg) => pkg.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Dependencies before dependents; falls back to alphabetical for anything left over. */
function topoSort(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const sorted = []
  const visiting = new Set()
  const visit = (pkg) => {
    if (sorted.includes(pkg) || visiting.has(pkg.name)) return
    visiting.add(pkg.name)
    for (const dep of pkg.deps) {
      const inside = byName.get(dep)
      if (inside) visit(inside)
    }
    visiting.delete(pkg.name)
    sorted.push(pkg)
  }
  for (const pkg of packages) visit(pkg)
  return sorted
}

const npmBin = process.env.NPM_BIN || 'npm'
// Fallback path when the token may not bypass 2FA: publishing then needs an interactive 6-digit
// code. The script is resumable, so re-running with a fresh code after each expiry is enough.
const otp = process.env.NPM_OTP
// npm rate limits publish requests (E429); space them out and back off when it happens.
const delayMs = Number(process.env.PUBLISH_DELAY_MS ?? process.argv.find((a) => a.startsWith('--delay='))?.slice(8) ?? 20000)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const npmEnv = { ...process.env }
let userconfig = null
if (!dryRun) {
  const token = process.env.NPM_TOKEN
  if (!token) {
    console.error('NPM_TOKEN is not set. Run through: sekret local exec tsien account -- node scripts/publish-packages.mjs')
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), 'pi-tsien-publish-'))
  userconfig = join(dir, 'npmrc')
  writeFileSync(userconfig, `registry=${REGISTRY}\n//registry.npmjs.org/:_authToken=\${NPM_TOKEN}\n`, { mode: 0o600 })
}
const npmArgs = (args) => (userconfig ? [...args, '--userconfig', userconfig] : args)

/** Registry writes take a few seconds to become readable, so retry before calling it missing. */
function isPublished(name, version, attempts = 1) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const out = execFileSync(npmBin, npmArgs(['view', `${name}@${version}`, 'version']), {
        env: npmEnv,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (out.trim() === version) return true
    } catch {
      // not visible yet
    }
    if (attempt < attempts - 1) sleep(4000)
  }
  return false
}

/** Publish one package, backing off on npm's publish rate limit. */
function publishWithBackoff(pkg) {
  const args = ['publish', '--access', 'public', ...(otp ? [`--otp=${otp}`] : []), pkg.dir]
  for (let attempt = 0; ; attempt += 1) {
    try {
      execFileSync(npmBin, npmArgs(args), { env: npmEnv, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
      return
    } catch (error) {
      const output = [error.stdout, error.stderr].filter(Boolean).join('')
      if (/E429|Too Many Requests/i.test(output) && attempt < 5) {
        const wait = 30000 * (attempt + 1)
        console.log(`  ...   ${pkg.name} rate limited, retry in ${wait / 1000}s`)
        sleep(wait)
        continue
      }
      throw error
    }
  }
}

const packages = topoSort(readPackages())
console.log(`${dryRun ? '[dry-run] ' : ''}${packages.length} packages, publish order:`)
for (const pkg of packages) console.log(`  ${pkg.name}@${pkg.version}${pkg.deps.length ? `  (needs: ${pkg.deps.join(', ')})` : ''}`)

const failed = []
for (const pkg of packages) {
  if (dryRun) {
    try {
      execFileSync(npmBin, npmArgs(['publish', '--dry-run', '--access', 'public', pkg.dir]), {
        env: npmEnv,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      console.log(`  ok (dry-run)  ${pkg.name}@${pkg.version}`)
    } catch (error) {
      failed.push(pkg.name)
      console.error(`  FAIL (dry-run) ${pkg.name}: ${error.message.split('\n')[0]}`)
    }
    continue
  }
  if (isPublished(pkg.name, pkg.version)) {
    console.log(`  skip  ${pkg.name}@${pkg.version} (already on the registry)`)
    continue
  }
  try {
    publishWithBackoff(pkg)
  } catch (error) {
    failed.push(pkg.name)
    const output = [error.stdout, error.stderr].filter(Boolean).join('')
    if (/(EOTP|one-time password)/i.test(output)) {
      if (userconfig) rmSync(join(userconfig, '..'), { recursive: true, force: true })
      console.error(`\n需要新的 6 位验证码（当前${otp ? '已过期' : '未提供'}）——已发布的部分会保留，重新运行时自动跳过。`)
      process.exit(3)
    }
    const detail = output.split('\n').filter((l) => /npm error/.test(l)).slice(0, 2).join(' | ')
    console.error(`  FAIL  ${pkg.name}@${pkg.version}: ${detail || error.message.split('\n')[0]}`)
    continue
  }
  if (isPublished(pkg.name, pkg.version, 8)) {
    console.log(`  ok    ${pkg.name}@${pkg.version}`)
    sleep(delayMs)
  } else {
    failed.push(pkg.name)
    console.error(`  FAIL  ${pkg.name}@${pkg.version}: published but not visible on the registry yet`)
  }
}

if (userconfig) rmSync(join(userconfig, '..'), { recursive: true, force: true })
console.log(
  failed.length
    ? `\n${failed.length} failed: ${failed.join(', ')}`
    : dryRun
      ? '\ndry-run complete: every package can be packed and published'
      : '\nall packages are on the registry',
)
process.exit(failed.length ? 1 : 0)