import path from 'node:path'
import { destinationFromUrl } from '../providers/remote'

/**
 * Strict decoders for the untrusted side of the IPC channel.
 *
 * Every helper rejects instead of coercing: `"false"` is not a boolean, an
 * unknown enum member is not its default, and a value that Git could read as an
 * option never reaches an argument list. Callers pass a short label so the
 * message points at the offending field without echoing attacker-chosen text.
 */

export interface StringOptions {
  max?: number
}

export function str(value: unknown, label: string, options: StringOptions = {}): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  if (!value.trim()) throw new Error(`${label} is required`)
  if (value.includes('\0')) throw new Error(`${label} must not contain a NUL byte`)
  const max = options.max ?? 100_000
  if (value.length > max) throw new Error(`${label} is too long`)
  return value
}

/** Text that may legitimately be empty (resolved file content). */
export function text(value: unknown, label: string, options: StringOptions = {}): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  if (value.includes('\0')) throw new Error(`${label} must not contain a NUL byte`)
  const max = options.max ?? 10 * 1024 * 1024
  if (value.length > max) throw new Error(`${label} is too long`)
  return value
}

export function optStr(value: unknown, label: string, options: StringOptions = {}): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  if (!value.trim()) return undefined
  return str(value, label, options)
}

/** Only a real boolean is accepted: the string "false" must never enable a flag. */
export function bool(value: unknown, label: string): boolean {
  if (value === true) return true
  if (value === false) return false
  throw new Error(`${label} must be true or false`)
}

export function optBool(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return bool(value, label)
}

export interface NumberOptions {
  min?: number
  max?: number
  integer?: boolean
}

export function num(value: unknown, label: string, options: NumberOptions = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`)
  const integer = options.integer ?? true
  if (integer && !Number.isInteger(value)) throw new Error(`${label} must be a whole number`)
  if (options.min !== undefined && value < options.min) throw new Error(`${label} must be at least ${options.min}`)
  if (options.max !== undefined && value > options.max) throw new Error(`${label} must be at most ${options.max}`)
  return value
}

export function optNum(value: unknown, label: string, options: NumberOptions = {}): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return num(value, label, options)
}

export function enumOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

export function strArray(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; maxLength?: number } = {}
): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`)
  const min = options.min ?? 1
  if (value.length < min) throw new Error(`${label} is required`)
  const max = options.max ?? 10_000
  if (value.length > max) throw new Error(`${label} has too many entries`)
  return value.map((item) => str(item, label, { max: options.maxLength ?? 4096 }))
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

/** Decode a `Record<string, string>` such as workflow inputs. */
export function recordOf(value: unknown, label: string, maxEntries = 100): Record<string, string> {
  if (value === undefined || value === null) return {}
  const source = record(value, label)
  const entries = Object.entries(source)
  if (entries.length > maxEntries) throw new Error(`${label} has too many entries`)
  const result: Record<string, string> = {}
  for (const [key, raw] of entries) {
    const name = str(key, `${label} name`, { max: 200 })
    result[name] = str(raw, `${label} "${name}"`, { max: 4096 })
  }
  return result
}

/**
 * A Git revision operand: `HEAD`, a branch, tag, remote ref, `HEAD~2` or an
 * abbreviated/full object name. Rejects anything Git could read as an option,
 * revision-range syntax and characters that only belong in a path.
 */
export function revision(value: unknown, label: string): string {
  const text = str(value, label, { max: 240 })
  if (text.startsWith('-')) throw new Error(`${label} must not start with "-"`)
  if (text === '@') return text
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain whitespace or control characters`)
  if (text.includes('..')) throw new Error(`${label} must not contain ".."`)
  if (text.includes('@{')) throw new Error(`${label} must not contain "@{"`)
  if (/[:?*[\]\\]/.test(text)) throw new Error(`${label} contains characters a revision cannot use`)
  return text
}

/** A revision range such as `main..feature` or `main...feature`. */
export function revisionRange(value: unknown, label: string): string {
  const text = str(value, label, { max: 480 })
  const separator = text.includes('...') ? '...' : text.includes('..') ? '..' : null
  if (!separator) return revision(text, label)
  const [from, to, ...rest] = text.split(separator)
  if (rest.length || !from || !to) throw new Error(`${label} is not a valid revision range`)
  return `${revision(from, label)}${separator}${revision(to, label)}`
}

/** A branch or tag name. Stricter than a revision: no operators, no "@{". */
export function refName(value: unknown, label: string): string {
  const text = str(value, label, { max: 240 })
  if (text === '@' || text.startsWith('-')) throw new Error(`Invalid ${label.toLowerCase()}`)
  if (/[\s\u0000-\u001f\u007f~^:?*[\]\\]/.test(text)) throw new Error(`Invalid ${label.toLowerCase()}`)
  if (text.includes('..') || text.includes('@{')) throw new Error(`Invalid ${label.toLowerCase()}`)
  if (text.startsWith('/') || text.endsWith('/') || text.includes('//') || text.endsWith('.')) {
    throw new Error(`Invalid ${label.toLowerCase()}`)
  }
  const segments = text.split('/')
  if (segments.some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))) {
    throw new Error(`Invalid ${label.toLowerCase()}`)
  }
  return text
}

/** An absolute filesystem path. Authorization happens separately. */
export function repoPath(value: unknown, label = 'Repository path'): string {
  const text = str(value, label, { max: 4096 })
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain control characters`)
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`)
  return text
}

/**
 * A repository-relative file path. No absolute path, no `..` segment, no
 * option-shaped value and no control character.
 */
export function relPath(value: unknown, label = 'File'): string {
  const text = str(value, label, { max: 4096 })
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain control characters`)
  if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) throw new Error(`${label} must be relative to the repository`)
  if (text.startsWith('-')) throw new Error(`Invalid ${label.toLowerCase()}`)
  const segments = text.split(/[\\/]/)
  if (segments.some((segment) => segment === '..')) throw new Error(`${label} escapes the repository`)
  return text
}

export function optRelPath(value: unknown, label = 'File'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return relPath(value, label)
}

/** A path read from the object database: no revision/path separator. */
export function headPath(value: unknown, label = 'File'): string {
  const text = relPath(value, label)
  if (text.includes(':')) throw new Error(`${label} must not contain ":"`)
  if (/[\r\n]/.test(text)) throw new Error(`${label} must not contain a line break`)
  return text
}

/** A single folder name: no separator and no `.`/`..` traversal. */
export function folderName(value: unknown, label = 'Folder name'): string {
  const text = str(value, label, { max: 200 })
  if (text === '.' || text === '..' || /[\\/]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`Invalid ${label.toLowerCase()}`)
  }
  return text
}

export function optFolderName(value: unknown, label = 'Folder name'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return folderName(value, label)
}

export function hexDigest(value: unknown, label: string): string {
  const text = str(value, label, { max: 64 })
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} must be a SHA-256 hex digest`)
  return text
}

export function optHexDigest(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return hexDigest(value, label)
}

/** A remote name from `git remote add`, which the app restricts to this set. */
export function remoteName(value: unknown, label = 'Remote'): string {
  const text = str(value, label, { max: 120 })
  if (!/^[A-Za-z0-9._/-]+$/.test(text) || text === '.' || text === '..' || text.startsWith('-') || text.includes('..')) {
    throw new Error(`Invalid ${label.toLowerCase()} name`)
  }
  return text
}

export function optRemoteName(value: unknown, label = 'Remote'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return remoteName(value, label)
}

/** A single owner/repository path segment used by forge APIs. */
export function slugPart(value: unknown, label: string): string {
  const text = str(value, label, { max: 255 })
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === '.' || text === '..') throw new Error(`Invalid ${label.toLowerCase()}`)
  return text
}

/** A value passed to Git as a plain word (refspec, strategy, workflow id). */
export function word(value: unknown, label: string, max = 512): string {
  const text = str(value, label, { max })
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain whitespace or control characters`)
  if (text.startsWith('-')) throw new Error(`${label} must not start with "-"`)
  return text
}

export function optWord(value: unknown, label: string, max = 512): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return word(value, label, max)
}

/**
 * Reject remote URLs that would be read as options or reach a transport we do
 * not support. Local paths and `file://` URLs stay valid; credentials are never
 * released for them.
 */
export function remoteUrl(raw: unknown): string {
  const url = str(raw, 'Remote URL', { max: 4096 }).trim()
  if (url.startsWith('-')) throw new Error('Remote URL must not start with "-"')
  if (/[\u0000-\u001f\s]/.test(url)) throw new Error('Remote URL must not contain whitespace or control characters')
  if (/^[A-Za-z]:[\\/]/.test(url)) return url
  if (SCHEME_RE.test(url)) {
    const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
    if (scheme === 'file') return url
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh' && scheme !== 'git' && scheme !== 'git+ssh') {
      throw new Error(`Unsupported remote scheme "${scheme}"`)
    }
    if (!destinationFromUrl(url)) throw new Error('Enter a valid Git URL (https://, ssh:// or git@host:owner/repo)')
    return url
  }
  if (path.isAbsolute(url) || !url.includes(':')) return url
  if (!destinationFromUrl(url)) throw new Error('Enter a valid Git URL (https://, ssh:// or git@host:owner/repo)')
  return url
}

/** A submodule URL may also be relative to the superproject remote. */
export function submoduleUrl(raw: unknown): string {
  const url = str(raw, 'Submodule URL', { max: 2048 })
  if (/^\.{1,2}\//.test(url)) return url
  return remoteUrl(url)
}

/** A Git configuration key, as accepted by `git config --local`. */
export function configKey(value: unknown): string {
  const text = str(value, 'Configuration key', { max: 240 })
  if (!/^[a-zA-Z0-9.-]+$/.test(text) || text.startsWith('-') || text.startsWith('.') || text.endsWith('.')) {
    throw new Error('Invalid configuration key')
  }
  return text
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//
