import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  CloudDownload,
  CloudUpload,
  Command,
  FilePlus2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Layers,
  ListTree,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  SquareTerminal,
  Tag,
  Waypoints,
  X
} from 'lucide-react'
import { activeIdentity, useStore, type ViewId } from '../store'
import { call } from '../lib/ipc'

export type PaletteAction = 'open' | 'clone' | 'init' | 'new-branch' | 'new-tag' | 'new-worktree' | 'new-submodule' | 'push'

interface PaletteCommand {
  id: string
  label: string
  hint?: string
  icon: React.ReactNode
  group: string
  run: () => void | Promise<void>
}

export function CommandPalette({ action }: { action: (action: PaletteAction) => void }) {
  const open = useStore((state) => state.paletteOpen)
  const setOpen = useStore((state) => state.setPaletteOpen)
  const setView = useStore((state) => state.setView)
  const repo = useStore((state) => state.currentRepo)
  const recent = useStore((state) => state.recent)
  const branches = useStore((state) => state.branches)
  const detection = useStore((state) => state.detection)
  const tabs = useStore((state) => state.tabs)
  const activeTabId = useStore((state) => state.activeTabId)
  const activateTab = useStore((state) => state.activateTab)
  const cycleTab = useStore((state) => state.cycleTab)
  const closeTab = useStore((state) => state.closeTab)
  const toggleConsole = useStore((state) => state.toggleConsole)
  const openRepo = useStore((state) => state.openRepo)
  const openRebase = useStore((state) => state.openRebase)
  const notifyError = useStore((state) => state.notifyError)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      setTimeout(() => inputRef.current?.focus(), 20)
    }
  }, [open])

  const commands = useMemo<PaletteCommand[]>(() => {
    const items: PaletteCommand[] = []
    const view = (id: ViewId, label: string, icon: React.ReactNode): PaletteCommand => ({
      id: `view-${id}`,
      label,
      group: 'Go to',
      icon,
      run: () => setView(id)
    })

    items.push(
      { id: 'open', label: 'Open repository…', hint: 'opens a tab', group: 'Repository', icon: <FolderOpen size={15} />, run: () => action('open') },
      { id: 'clone', label: 'Clone repository…', hint: 'https or SSH URL', group: 'Repository', icon: <FolderGit2 size={15} />, run: () => action('clone') },
      { id: 'init', label: 'Create repository…', hint: 'git init', group: 'Repository', icon: <FilePlus2 size={15} />, run: () => action('init') },
      view('graph', 'Commit graph', <GitCommitHorizontal size={15} />),
      view('files', 'Files & staging', <Layers size={15} />),
      view('branches', 'Branches', <GitBranch size={15} />),
      view('worktrees', 'Worktrees', <Waypoints size={15} />),
      view('submodules', 'Submodules', <Boxes size={15} />),
      view('tags', 'Tags', <Tag size={15} />),
      view('pulls', 'Pull requests', <GitPullRequest size={15} />),
      view('releases', 'Releases', <Rocket size={15} />),
      view('actions', 'Pipelines & actions', <Rocket size={15} />),
      view('settings', 'Settings', <Settings size={15} />),
      { id: 'console', label: 'Toggle git console', hint: 'Ctrl/Cmd+J', group: 'Tools', icon: <SquareTerminal size={15} />, run: () => toggleConsole() }
    )

    for (const tab of tabs) {
      if (tab.id === activeTabId) continue
      items.push({
        id: `tab-${tab.id}`,
        label: `Switch to ${tab.currentRepo.name}`,
        hint: tab.status?.branch ?? tab.currentRepo.path,
        group: 'Repository tabs',
        icon: <FolderGit2 size={15} />,
        run: () => activateTab(tab.id)
      })
    }
    if (tabs.length > 1) {
      items.push(
        {
          id: 'next-tab',
          label: 'Next repository tab',
          hint: 'Ctrl+Tab',
          group: 'Repository tabs',
          icon: <ArrowRight size={15} />,
          run: () => cycleTab(1)
        },
        {
          id: 'close-tab',
          label: 'Close repository tab',
          hint: 'Ctrl/Cmd+W',
          group: 'Repository tabs',
          icon: <X size={15} />,
          run: () => closeTab()
        }
      )
    }

    if (repo) {
      items.push(
        {
          id: 'fetch',
          label: 'Fetch from remote',
          group: 'Git',
          icon: <CloudDownload size={15} />,
          run: async () => {
            await call('git.fetch', { repoPath: repo.path, prune: true, accountId: detection.accountId })
          }
        },
        {
          id: 'pull',
          label: 'Pull',
          group: 'Git',
          icon: <RefreshCw size={15} />,
          run: async () => {
            await call('git.pull', { repoPath: repo.path, identityId: activeIdentity()?.id, accountId: detection.accountId })
          }
        },
        {
          id: 'push',
          label: 'Push…',
          group: 'Git',
          icon: <CloudUpload size={15} />,
          run: () => action('push')
        },
        { id: 'new-branch', label: 'Create branch…', group: 'Git', icon: <GitBranch size={15} />, run: () => action('new-branch') },
        {
          id: 'interactive-rebase',
          label: 'Interactive rebase…',
          hint: repo.upstream ?? 'choose a base',
          group: 'Git',
          icon: <ListTree size={15} />,
          run: () => openRebase(repo.upstream ?? undefined)
        },
        { id: 'new-tag', label: 'Create tag…', group: 'Git', icon: <Tag size={15} />, run: () => action('new-tag') },
        { id: 'new-worktree', label: 'Add worktree…', group: 'Git', icon: <Waypoints size={15} />, run: () => action('new-worktree') },
        { id: 'new-submodule', label: 'Add submodule…', group: 'Git', icon: <Boxes size={15} />, run: () => action('new-submodule') }
      )
      for (const branch of branches.filter((item) => item.type === 'branch').slice(0, 30)) {
        items.push({
          id: `checkout-${branch.name}`,
          label: `Checkout ${branch.shortName}`,
          hint: branch.isCurrent ? 'current' : branch.subject,
          group: 'Branches',
          icon: <GitBranch size={15} />,
          run: async () => {
            await call('git.checkout', { repoPath: repo.path, branch: branch.shortName })
            await useStore.getState().refreshAll(repo.path)
          }
        })
      }
    }

    for (const item of recent.slice(0, 8)) {
      items.push({
        id: `recent-${item.path}`,
        label: item.name,
        hint: item.path,
        group: 'Recent repositories',
        icon: <FolderOpen size={15} />,
        run: async () => {
          await openRepo(item.path)
        }
      })
    }
    return items
  }, [
    action,
    activateTab,
    activeTabId,
    branches,
    closeTab,
    cycleTab,
    detection.accountId,
    openRebase,
    openRepo,
    recent,
    repo?.path,
    repo?.upstream,
    setView,
    tabs,
    toggleConsole
  ])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return commands
    return commands.filter((command) => `${command.label} ${command.hint ?? ''} ${command.group}`.toLowerCase().includes(term))
  }, [commands, query])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    if (!open) return undefined
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setIndex((value) => Math.min(value + 1, filtered.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setIndex((value) => Math.max(value - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const command = filtered[index]
        if (!command) return
        setOpen(false)
        Promise.resolve()
          .then(() => command.run())
          .catch((error) => notifyError(error))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filtered, index, notifyError, open, setOpen])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null

  let lastGroup = ''
  return (
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input-row">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, branches and repositories…"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? <div className="palette-empty">No matching commands</div> : null}
          {filtered.map((command, itemIndex) => {
            const header = command.group !== lastGroup ? command.group : null
            lastGroup = command.group
            return (
              <div key={command.id}>
                {header ? <div className="palette-group">{header}</div> : null}
                <button
                  data-index={itemIndex}
                  className={`palette-item ${itemIndex === index ? 'is-active' : ''}`}
                  onMouseEnter={() => setIndex(itemIndex)}
                  onClick={() => {
                    setOpen(false)
                    Promise.resolve()
                      .then(() => command.run())
                      .catch((error) => notifyError(error))
                  }}
                >
                  <span className="palette-item-icon">{command.icon}</span>
                  <span className="palette-item-label">{command.label}</span>
                  {command.hint ? <span className="palette-item-hint">{command.hint}</span> : null}
                  {itemIndex === index ? <ArrowRight size={14} /> : null}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-footer">
          <span>
            <Command size={11} /> Keyboard first
          </span>
          <span>↑↓ navigate · ↵ run</span>
        </div>
      </div>
    </div>
  )
}
