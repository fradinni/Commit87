import { useEffect, useRef, useState } from 'react'
import { ChevronUp, Trash2, X } from 'lucide-react'
import { useStore, activeIdentity } from '../store'
import { call, errorMessage } from '../lib/ipc'
import { IconButton } from './ui'

export function ConsoleDrawer() {
  const open = useStore((state) => state.consoleOpen)
  const toggle = useStore((state) => state.toggleConsole)
  const lines = useStore((state) => state.consoleLines)
  const clear = useStore((state) => state.clearConsole)
  const pushLine = useStore((state) => state.pushConsoleLine)
  const repo = useStore((state) => state.currentRepo)
  const detection = useStore((state) => state.detection)
  const notifyError = useStore((state) => state.notifyError)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [height, setHeight] = useState(260)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [lines.length, open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  if (!open) return null

  const submit = async (): Promise<void> => {
    if (!repo) return
    const value = command.trim()
    if (!value) return
    setHistory((items) => [value, ...items].slice(0, 100))
    setHistoryIndex(-1)
    setCommand('')
    pushLine(`$ ${value}`, 'stdout')
    try {
      await call('git.console', {
        repoPath: repo.path,
        command: value,
        identityId: activeIdentity()?.id,
        accountId: detection.accountId
      })
    } catch (error) {
      pushLine(errorMessage(error), 'stderr')
      notifyError(error)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(next)
      if (history[next] !== undefined) setCommand(history[next])
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      const next = historyIndex - 1
      setHistoryIndex(next)
      setCommand(next >= 0 ? history[next] ?? '' : '')
    }
  }

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const move = (moveEvent: MouseEvent): void => {
      setHeight(Math.min(520, Math.max(150, startHeight + startY - moveEvent.clientY)))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="console-drawer" style={{ height }}>
      <div className="console-resize" onMouseDown={startResize} />
      <div className="console-header">
        <span className="console-title">Git console</span>
        <span className="console-repo">{repo ? repo.name : 'No repository'}</span>
        <span className="console-hint">Runs only git commands, without a shell</span>
        <div className="console-actions">
          <IconButton label="Scroll to top" onClick={() => bodyRef.current?.scrollTo({ top: 0 })}>
            <ChevronUp size={14} />
          </IconButton>
          <IconButton label="Clear console" onClick={clear}>
            <Trash2 size={14} />
          </IconButton>
          <IconButton label="Close console" onClick={() => toggle(false)}>
            <X size={15} />
          </IconButton>
        </div>
      </div>
      <div className="console-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <div className="console-empty">
            Try <code>git status</code>, <code>git log --oneline -n 20</code>, <code>git remote -v</code> or <code>git worktree list</code>.
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`console-line ${line.stream === 'stderr' ? 'is-error' : ''}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
      <div className="console-input-row">
        <span className="console-prompt">$</span>
        <input
          ref={inputRef}
          className="console-input"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={repo ? 'git status' : 'Open a repository first'}
          disabled={!repo}
          spellCheck={false}
        />
      </div>
    </div>
  )
}
