import { useMemo } from 'react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark-dimmed.css'
import type { FileContent } from '@shared/types'
import { FileWarning } from 'lucide-react'
import { languageFromPath } from '../lib/format'
import { EmptyState, LoadingBlock } from './ui'

export function CodeView({ content, loading }: { content: FileContent | null; loading?: boolean }) {
  const highlighted = useMemo(() => {
    if (!content || content.binary) return null
    const text = content.content
    if (text.length > 400_000) {
      return escapeHtml(text)
    }
    const language = languageFromPath(content.path)
    try {
      if (language !== 'plaintext' && hljs.getLanguage(language)) {
        return hljs.highlight(text, { language, ignoreIllegals: true }).value
      }
    } catch {
      // fall through to escaped text
    }
    return escapeHtml(text)
  }, [content])

  if (loading) return <LoadingBlock label="Loading file…" />
  if (!content) {
    return <EmptyState icon={<FileWarning size={20} />} title="No file selected" description="Choose a file from the tree to view its contents." />
  }
  if (content.binary) {
    return <EmptyState icon={<FileWarning size={20} />} title="Binary file" description={`${content.path} cannot be displayed as text.`} />
  }

  const lines = (highlighted ?? '').split('\n')
  return (
    <div className="code-view">
      <div className="code-toolbar">
        <span className="code-path">{content.path}</span>
        <span className="code-meta">
          {content.from === 'head' ? 'HEAD' : 'working tree'} · {content.size.toLocaleString()} bytes
          {content.truncated ? ' · truncated' : ''}
        </span>
      </div>
      <div className="code-body">
        {lines.map((line, index) => (
          <div className="code-line" key={index}>
            <span className="code-number">{index + 1}</span>
            <span className="code-text" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
