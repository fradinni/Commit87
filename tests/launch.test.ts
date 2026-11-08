import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseLaunchTarget } from '../src/main/launch'

let folder = ''
let oddFolder = ''
let file = ''
let missing = ''
let appDir = ''

beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'commit87-launch-'))
  oddFolder = path.join(folder, 'a b%20c')
  await fs.mkdir(oddFolder)
  file = path.join(folder, 'notes.txt')
  await fs.writeFile(file, 'x')
  missing = path.join(folder, 'missing')
  appDir = path.join(folder, 'app')
  await fs.mkdir(path.join(appDir, 'out', 'main'), { recursive: true })
  await fs.writeFile(path.join(appDir, 'out', 'main', 'index.js'), '')
})

afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true })
})

describe('parseLaunchTarget', () => {
  it('accepts an absolute folder passed by the OS', () => {
    expect(parseLaunchTarget([folder], appDir)).toBe(folder)
  })

  it('skips flags and unrelated arguments', () => {
    expect(parseLaunchTarget(['--no-sandbox', '--remote-debugging-port=9222', folder], appDir)).toBe(folder)
  })

  it('accepts the file URL a Linux file manager passes', () => {
    expect(parseLaunchTarget([pathToFileURL(folder).href], appDir)).toBe(folder)
    expect(parseLaunchTarget([pathToFileURL(oddFolder).href], appDir)).toBe(oddFolder)
    expect(path.resolve(parseLaunchTarget([`${pathToFileURL(folder).href}/`], appDir) ?? '')).toBe(folder)
  })

  it('accepts deep links with a query and with a bare path', () => {
    expect(parseLaunchTarget([`commit87://open?path=${encodeURIComponent(folder)}`], appDir)).toBe(folder)
    const bare = process.platform === 'win32' ? `commit87:///${folder.replace(/\\/g, '/')}` : `commit87://${folder}`
    expect(parseLaunchTarget([bare], appDir)).toBe(folder)
    expect(parseLaunchTarget([`Commit87://open?path=${encodeURIComponent(folder)}`], appDir)).toBe(folder)
  })

  it('passes an absolute deep-link target through so a missing folder is reported', () => {
    expect(parseLaunchTarget([`commit87://open?path=${encodeURIComponent(missing)}`], appDir)).toBe(missing)
  })

  it('does not decode an already decoded deep-link query twice', () => {
    expect(parseLaunchTarget([`commit87://open?path=${encodeURIComponent(oddFolder)}`], appDir)).toBe(oddFolder)
  })

  it('ignores files, missing folders, the app and the filesystem root', () => {
    const roots = process.platform === 'win32' ? ['/', 'C:\\'] : ['/']
    expect(parseLaunchTarget([file, missing, appDir, `${appDir}/`, ...roots], appDir)).toBeNull()
    const deepLinks = ['commit87://open?path=%2F', 'commit87://', 'file:', 'file:///']
    if (process.platform === 'win32') deepLinks.push('file:///C:/', 'commit87://open?path=C%3A%5C')
    expect(parseLaunchTarget(deepLinks, appDir)).toBeNull()
  })

  it('ignores relative paths and malformed URLs', () => {
    expect(parseLaunchTarget(['repo', 'commit87://open?path=.', 'commit87://open?path=%E0%A4%A'], appDir)).toBeNull()
  })
})
