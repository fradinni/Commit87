#!/usr/bin/env node
/**
 * Local update feed for exercising the Commit87 updater without publishing a
 * release. It serves stable and beta metadata plus placeholder artifacts that
 * are large enough to show download progress.
 *
 *   node scripts/demo-updates.mjs serve
 *   node scripts/demo-updates.mjs prepare dist/Commit87-0.1.0-linux-x86_64.AppImage
 *
 * `prepare` extracts the AppImage and points its app-update.yml at the local
 * feed. Installing the downloaded placeholder is not supported; the demo stops
 * at the "ready to install" state on purpose.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve('dist/update-demo')
const FEED_DIR = path.join(ROOT, 'feed')
const PORT = Number(process.env.COMMIT87_UPDATE_DEMO_PORT || 8787)
const ARTIFACT_BYTES = Number(process.env.COMMIT87_UPDATE_DEMO_SIZE || 2 * 1024 * 1024)
const THROTTLE_BYTES_PER_SECOND = Number(process.env.COMMIT87_UPDATE_DEMO_RATE || 420 * 1024)

// The demo must offer something newer than the checked-out app, so derive the
// next minor from package.json instead of pinning versions a release turns into
// "no update available".
const appVersion = JSON.parse(readFileSync(path.join(ROOT, '..', '..', 'package.json'), 'utf8')).version
const [appMajor, appMinor] = appVersion.split('.').map(Number)
const demoMinor = `${appMajor}.${appMinor + 1}`

const channels = [
  {
    id: 'stable',
    version: `${demoMinor}.0`,
    file: `Commit87-${demoMinor}.0-linux-x86_64.AppImage`,
    notes: 'Stable demo build'
  },
  {
    id: 'beta',
    version: `${demoMinor}.1-beta.1`,
    file: `Commit87-${demoMinor}.1-beta.1-linux-x86_64.AppImage`,
    notes: 'Beta demo build'
  }
]

function ensureArtifact(channel) {
  mkdirSync(FEED_DIR, { recursive: true })
  const target = path.join(FEED_DIR, channel.file)
  if (!existsSync(target) || statSync(target).size !== ARTIFACT_BYTES) {
    const block = Buffer.alloc(64 * 1024)
    block.fill(`Commit87 ${channel.version} update placeholder\n`)
    const handle = []
    for (let written = 0; written < ARTIFACT_BYTES; written += block.length) {
      handle.push(block.subarray(0, Math.min(block.length, ARTIFACT_BYTES - written)))
    }
    writeFileSync(target, Buffer.concat(handle))
    console.log(`created ${path.relative(process.cwd(), target)} (${ARTIFACT_BYTES} bytes)`)
  }
  return target
}

function writeFeed() {
  for (const channel of channels) {
    const target = ensureArtifact(channel)
    const data = readFileSync(target)
    const sha512 = createHash('sha512').update(data).digest('base64')
    const file = channel.id === 'beta' ? 'beta-linux.yml' : 'latest-linux.yml'
    const payload = [
      `version: ${channel.version}`,
      'files:',
      `  - url: ${channel.file}`,
      `    sha512: ${sha512}`,
      `    size: ${data.length}`,
      `path: ${channel.file}`,
      `sha512: ${sha512}`,
      `releaseDate: '2026-11-05T10:00:00.000Z'`,
      `releaseNotes: |`,
      `  ## ${channel.version}`,
      `  `,
      `  - ${channel.notes}`,
      `  - Local update feed served by scripts/demo-updates.mjs`,
      ''
    ].join('\n')
    writeFileSync(path.join(FEED_DIR, file), payload)
  }
  console.log(`update metadata written to ${path.relative(process.cwd(), FEED_DIR)}`)
}

async function sendSlow(res, file, range) {
  const size = statSync(file).size
  let start = 0
  let end = size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.split(',')[0].trim())
    if (match) {
      if (match[1]) start = Number(match[1])
      if (match[2]) end = Math.min(Number(match[2]), size - 1)
    }
  }
  const length = Math.max(0, end - start + 1)
  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': String(length)
  }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(range ? 206 : 200, headers)
  const delay = Math.max(10, Math.round((64 * 1024 * 1000) / Math.max(1, THROTTLE_BYTES_PER_SECOND)))
  try {
    for await (const chunk of createReadStream(file, { start, end })) {
      if (res.destroyed) return
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve))
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  } catch {
    res.destroy()
    return
  }
  if (!res.destroyed) res.end()
}

function prepare(appImage) {
  if (!appImage) throw new Error('Pass the path to a packaged AppImage')
  const source = path.resolve(appImage)
  if (!existsSync(source)) throw new Error(`AppImage not found: ${source}`)
  mkdirSync(ROOT, { recursive: true })
  const extractDir = path.join(ROOT, 'squashfs-root')
  rmSync(extractDir, { recursive: true, force: true })
  console.log(`extracting ${source} …`)
  execFileSync(source, ['--appimage-extract'], { cwd: ROOT, stdio: 'inherit' })
  const appUpdate = path.join(extractDir, 'resources', 'app-update.yml')
  writeFileSync(
    appUpdate,
    [
      'provider: generic',
      `url: http://127.0.0.1:${PORT}/`,
      'updaterCacheDirName: commit87-updater',
      ''
    ].join('\n')
  )
  console.log(`pointed ${path.relative(process.cwd(), appUpdate)} at http://127.0.0.1:${PORT}/`)
  console.log('')
  console.log('Start the feed in another terminal:')
  console.log('  node scripts/demo-updates.mjs serve')
  console.log('')
  console.log('Launch the prepared build with the AppImage runtime env:')
  console.log(`  APPIMAGE="${source}" ${path.join(extractDir, 'AppRun')}`)
}

function serve() {
  writeFeed()
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
    console.log(`${req.method} ${url.pathname}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(
        [
          'Commit87 local update feed',
          '',
          `stable: http://127.0.0.1:${PORT}/latest-linux.yml`,
          `beta:   http://127.0.0.1:${PORT}/beta-linux.yml`,
          '',
          'Use scripts/demo-updates.mjs prepare <AppImage> to point a packaged build here.'
        ].join('\n')
      )
      return
    }
    const name = path.basename(url.pathname)
    const target = path.join(FEED_DIR, name)
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    if (name.endsWith('.yml')) {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      createReadStream(target).pipe(res)
      return
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(statSync(target).size)
      })
      res.end()
      return
    }
    sendSlow(res, target, req.headers.range)
  })
  server.listen(PORT, '127.0.0.1', () => {
    const [stable, beta] = channels
    const rate = Math.round(THROTTLE_BYTES_PER_SECOND / 1024)
    console.log(`Commit87 update feed on http://127.0.0.1:${PORT}/`)
    console.log(`stable ${stable.version} and beta ${beta.version}, throttled to ~${rate} KiB/s`)
    console.log('Press Ctrl+C to stop.')
  })
  process.on('SIGINT', () => {
    server.close(() => process.exit(0))
  })
}

const [command = 'serve', target] = process.argv.slice(2)
if (command === 'serve') {
  serve()
} else if (command === 'prepare') {
  prepare(target)
} else {
  console.error('Usage: node scripts/demo-updates.mjs [serve|prepare <AppImage>]')
  process.exit(1)
}
