export function formatRelativeTime(epochMs: number | undefined): string {
  if (!epochMs) return ''
  const diff = Date.now() - epochMs
  const future = diff < 0
  const abs = Math.abs(diff)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day
  let value: number
  let unit: string
  if (abs < minute) {
    value = Math.max(1, Math.round(abs / 1000))
    unit = 's'
  } else if (abs < hour) {
    value = Math.round(abs / minute)
    unit = 'm'
  } else if (abs < day) {
    value = Math.round(abs / hour)
    unit = 'h'
  } else if (abs < week) {
    value = Math.round(abs / day)
    unit = 'd'
  } else if (abs < month) {
    value = Math.round(abs / week)
    unit = 'w'
  } else if (abs < year) {
    value = Math.round(abs / month)
    unit = 'mo'
  } else {
    value = Math.round(abs / year)
    unit = 'y'
  }
  return future ? `in ${value}${unit}` : `${value}${unit} ago`
}

export function formatDate(epochMs: number | undefined): string {
  if (!epochMs) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(epochMs))
}

export function formatShortDate(epochMs: number | undefined): string {
  if (!epochMs) return '—'
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(new Date(epochMs))
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function initials(name: string | undefined): string {
  if (!name) return '?'
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : ''
}

export function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

export function dirname(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

export function languageFromPath(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    dart: 'dart',
    swift: 'swift',
    lua: 'lua',
    pl: 'perl',
    r: 'r',
    dockerfile: 'dockerfile',
    makefile: 'makefile'
  }
  return map[ext] ?? 'plaintext'
}
