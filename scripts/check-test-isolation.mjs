#!/usr/bin/env node
/**
 * Prove that every integration case stands on its own.
 *
 * For each integration file this runs the file alone, then runs every test in
 * it with `vitest run <file> -t "<full name>"`. A case that only passes because
 * an earlier case created its fixture, or because the developer's Git config
 * leaked in, shows up as a failure here.
 *
 * Usage:
 *   node scripts/check-test-isolation.mjs
 *   node scripts/check-test-isolation.mjs tests/history.integration.test.ts
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FILES = [
  'tests/git.integration.test.ts',
  'tests/history.integration.test.ts',
  'tests/rebase.integration.test.ts',
  'tests/submodule.integration.test.ts',
  'tests/credential-destination.test.ts',
  'tests/repo-discovery.test.ts'
]

const TMP_ROOT = process.env.TMPDIR || (process.platform === 'win32' ? os.tmpdir() : '/tmp/opencode')
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.ISOLATION_CONCURRENCY) || os.cpus().length))
const RUN_TIMEOUT = Number(process.env.ISOLATION_TIMEOUT_MS) || 180_000

mkdirSync(TMP_ROOT, { recursive: true })
const workDir = mkdtempSync(path.join(TMP_ROOT, 'commit87-isolation-'))

const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES
const failures = []
let checkedFiles = 0
let checkedTests = 0
let skippedTests = 0

function vitest(args) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    execFile(
      command,
      ['--no-install', 'vitest', ...args],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          TMPDIR: TMP_ROOT,
          VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true'
        },
        maxBuffer: 32 * 1024 * 1024,
        timeout: RUN_TIMEOUT
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          timedOut: Boolean(error?.killed),
          output: `${stdout}${stderr}`
        })
      }
    )
  })
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function failureExcerpt(output) {
  const lines = output.split('\n')
  const start = lines.findIndex((line) => line.includes('FAIL') || line.includes('Error:'))
  const excerpt = start >= 0 ? lines.slice(start, start + 12) : lines.slice(-12)
  return excerpt.map((line) => line.trimEnd()).filter(Boolean).join('\n')
}

async function listCases(file) {
  const reportPath = path.join(workDir, `${path.basename(file)}.json`)
  const result = await vitest(['run', file, '--reporter=json', `--outputFile=${reportPath}`])
  let cases = []
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    for (const testResult of report.testResults ?? []) {
      for (const assertion of testResult.assertionResults ?? []) {
        const fullName = [...(assertion.ancestorTitles ?? []), assertion.title].join(' > ')
        cases.push({ name: fullName, status: assertion.status })
      }
    }
  } catch {
    // The file did not produce a report (for example a syntax error); the
    // file-alone failure below already carries the useful output.
  }
  return { result, cases }
}

async function checkCase(file, testCase) {
  const result = await vitest(['run', file, '-t', escapeRegExp(testCase.name), '--reporter=dot'])
  const passed = Number(/Tests\s+(\d+) passed/.exec(result.output)?.[1] ?? 0)
  if (result.timedOut) return { ok: false, reason: `timed out after ${RUN_TIMEOUT}ms` }
  if (result.code !== 0) return { ok: false, reason: failureExcerpt(result.output) }
  if (passed === 0) return { ok: false, reason: 'filter matched no test (it ran as skipped)' }
  if (passed !== 1) return { ok: false, reason: `filter matched ${passed} tests instead of 1` }
  return { ok: true }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  console.log(`Isolation check: ${files.length} integration file(s), concurrency ${CONCURRENCY}`)

  const planned = []
  for (const file of files) {
    const { result, cases } = await listCases(file)
    const label = path.relative(ROOT, path.resolve(ROOT, file))
    if (result.code !== 0) {
      failures.push({ scope: `${label} (file alone)`, reason: failureExcerpt(result.output) })
      console.log(`✖ ${label} — file alone failed`)
    } else {
      console.log(`✔ ${label} — file alone passed (${cases.length} cases)`)
    }
    checkedFiles += 1
    if (cases.length === 0) {
      failures.push({ scope: `${label} (case enumeration)`, reason: 'no test cases were reported' })
      continue
    }
    for (const testCase of cases) planned.push({ file: label, testCase })
  }

  const results = await mapLimit(planned, CONCURRENCY, async ({ file, testCase }) => {
    if (testCase.status === 'skipped' || testCase.status === 'pending') {
      return { file, name: testCase.name, skipped: true }
    }
    return { file, name: testCase.name, ...(await checkCase(file, testCase)) }
  })

  let lastFile = ''
  for (const entry of results) {
    if (entry.file !== lastFile) {
      lastFile = entry.file
      console.log(`\n${entry.file}`)
    }
    if (entry.skipped) {
      skippedTests += 1
      console.log(`  - ${entry.name} (skipped on this platform)`)
      continue
    }
    checkedTests += 1
    if (entry.ok) {
      console.log(`  ✔ ${entry.name}`)
    } else {
      failures.push({ scope: `${entry.file} > ${entry.name}`, reason: entry.reason })
      console.log(`  ✖ ${entry.name}`)
    }
  }

  console.log('\nSummary')
  console.log(`  files checked alone: ${checkedFiles}`)
  console.log(`  cases checked individually: ${checkedTests}`)
  if (skippedTests > 0) console.log(`  cases skipped by platform: ${skippedTests}`)
  console.log(`  failures: ${failures.length}`)

  if (failures.length > 0) {
    console.log('\nUnisolated or ambient-dependent cases:')
    for (const failure of failures) {
      console.log(`\n✖ ${failure.scope}`)
      console.log(
        failure.reason
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
      )
    }
    return 1
  }
  console.log('\nEvery integration case passes alone.')
  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
process.exitCode = exitCode
