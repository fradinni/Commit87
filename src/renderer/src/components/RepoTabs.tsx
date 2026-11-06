import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderGit2, FolderOpen, GitBranch, Home, Plus, Waypoints, X } from 'lucide-react'
import { useStore } from '../store'
import { groupTabs, repoGroupKey, repoGroupLabel, repoPathKey } from '../lib/tabs'

/**
 * Editor-style strip of open repositories. Each tab owns its data and view, so
 * switching is a hydrate rather than a reload. A repository and its linked
 * worktrees stay together as one group.
 */
export function RepoTabs({ onOpen }: { onOpen: () => void }) {
  const tabs = useStore((state) => state.tabs)
  const activeTabId = useStore((state) => state.activeTabId)
  const recent = useStore((state) => state.recent)
  const currentRepo = useStore((state) => state.currentRepo)
  const worktrees = useStore((state) => state.worktrees)
  const activateTab = useStore((state) => state.activateTab)
  const closeTab = useStore((state) => state.closeTab)
  const moveTab = useStore((state) => state.moveTab)
  const showLaunchpad = useStore((state) => state.showLaunchpad)
  const openRepo = useStore((state) => state.openRepo)
  const notifyError = useStore((state) => state.notifyError)
  const [dragging, setDragging] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const platform = window.commit87.platform
  const openPathKeys = new Set(
    tabs.flatMap((tab) => [
      repoPathKey(tab.currentRepo.path, platform),
      repoPathKey(tab.currentRepo.canonicalPath, platform)
    ])
  )

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const placeMenu = useCallback((): void => {
    const button = addRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const width = Math.min(340, viewportWidth - 12)
    const spaceRight = viewportWidth - rect.left
    const spaceLeft = rect.right
    // Keep the menu on the side of the button with room for it. When neither
    // side fits, take the larger one and clamp inside the window.
    const preferred = spaceRight >= width || spaceRight >= spaceLeft ? rect.left : rect.right - width
    const left = Math.max(6, Math.min(preferred, viewportWidth - width - 6))
    const top = Math.max(6, rect.bottom + 4)
    const maxHeight = Math.max(120, viewportHeight - top - 8)
    setMenuPosition({ left, top, maxHeight })
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const update = (): void => placeMenu()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [menuOpen, placeMenu])

  if (!tabs.length) return null

  const openPath = (path: string): void => {
    setMenuOpen(false)
    void openRepo(path).catch(notifyError)
  }

  const groups = groupTabs(tabs, (tab) => repoGroupKey(tab.currentRepo, platform))
  let flatIndex = 0

  return (
    <div className="repo-tabs">
      <button
        className={`repo-tabs-home ${activeTabId ? '' : 'is-active'}`}
        title="Launchpad"
        aria-label="Show the launchpad"
        aria-pressed={!activeTabId}
        onClick={() => showLaunchpad()}
      >
        <Home size={14} />
      </button>
      <div className="repo-tabs-scroll" role="tablist" aria-label="Open repositories">
        {groups.map((group) => {
          const label = group.tabs.length > 1 ? repoGroupLabel(group.tabs[0].currentRepo) : null
          return (
            <div
              key={group.key}
              className={`repo-tab-group ${group.tabs.length > 1 ? 'is-grouped' : ''}`}
            >
              {label ? <span className="repo-tab-group-label">{label}</span> : null}
              {group.tabs.map((tab) => {
                const index = flatIndex
                flatIndex += 1
                const active = tab.id === activeTabId
                const branch = tab.status?.branch ?? (tab.currentRepo.detached ? 'detached' : tab.currentRepo.currentBranch)
                const changes = tab.status?.files.length ?? 0
                return (
                  <div
                    key={tab.id}
                    ref={active ? activeRef : undefined}
                    role="presentation"
                    className={`repo-tab ${active ? 'is-active' : ''} ${dragging === tab.id ? 'is-dragging' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      setDragging(tab.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', tab.id)
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => {
                      if (!dragging) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (dragging) moveTab(dragging, index)
                      setDragging(null)
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault()
                        closeTab(tab.id)
                      }
                    }}
                  >
                    <button
                      ref={(node) => {
                        tabRefs.current[index] = node
                      }}
                      role="tab"
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      className="repo-tab-main"
                      title={`${tab.currentRepo.name}${tab.currentRepo.worktree ? ' (worktree)' : ''}\n${tab.currentRepo.path}`}
                      onClick={() => activateTab(tab.id)}
                      onKeyDown={(event) => {
                        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                        if (step) {
                          event.preventDefault()
                          const next = (index + step + tabs.length) % tabs.length
                          activateTab(tabs[next].id)
                          requestAnimationFrame(() => tabRefs.current[next]?.focus())
                        } else if (event.key === 'Delete' || event.key === 'Backspace') {
                          event.preventDefault()
                          closeTab(tab.id)
                        }
                      }}
                    >
                      <span className="repo-tab-icon">
                        {tab.currentRepo.worktree ? <Waypoints size={13} /> : <FolderGit2 size={13} />}
                      </span>
                      <span className="repo-tab-name">{tab.currentRepo.name}</span>
                      {branch ? (
                        <span className="repo-tab-branch">
                          <GitBranch size={10} />
                          {branch}
                        </span>
                      ) : null}
                      {changes > 0 ? (
                        <span className="repo-tab-dirty" title={`${changes} changed file${changes === 1 ? '' : 's'}`} />
                      ) : null}
                    </button>
                    <button
                      className="repo-tab-close"
                      aria-label={`Close ${tab.currentRepo.name}`}
                      title="Close tab"
                      onClick={() => closeTab(tab.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="repo-tab-open">
        <button
          ref={addRef}
          className="repo-tab-add"
          onClick={() => {
            if (menuOpen) {
              setMenuOpen(false)
              return
            }
            placeMenu()
            setMenuOpen(true)
          }}
          title="Open a repository in a new tab"
          aria-label="Open a repository in a new tab"
          aria-expanded={menuOpen}
        >
          <Plus size={14} />
        </button>
        {menuOpen ? (
          <>
            <div className="click-catcher" onClick={() => setMenuOpen(false)} />
            <div
              className="dropdown repo-open-menu"
              role="menu"
              aria-label="Open a repository"
              style={menuPosition ?? undefined}
            >
              <div className="dropdown-header">Open in a new tab</div>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onOpen()
                }}
              >
                <FolderOpen size={14} />
                <span className="repo-open-text">
                  <span>Browse folder…</span>
                  <small>Pick any local Git repository</small>
                </span>
              </button>

              {worktrees.length ? (
                <>
                  <div className="repo-open-section">Worktrees of {currentRepo?.name ?? 'this repository'}</div>
                  {worktrees.map((worktree) => {
                    const worktreeBranch = worktree.branch ?? (worktree.detached ? 'detached HEAD' : 'bare')
                    return (
                      <button
                        key={worktree.path}
                        role="menuitem"
                        disabled={worktree.isCurrent}
                        title={worktree.path}
                        onClick={() => openPath(worktree.path)}
                      >
                        <Waypoints size={14} />
                        <span className="repo-open-text">
                          <span>
                            {worktreeBranch}
                            {worktree.isMain ? ' · main worktree' : ''}
                          </span>
                          <small>{worktree.path}</small>
                        </span>
                        {worktree.isCurrent ? <span className="repo-open-badge">open</span> : null}
                      </button>
                    )
                  })}
                </>
              ) : null}

              {recent.length ? (
                <>
                  <div className="repo-open-section">Known projects</div>
                  {recent.slice(0, 10).map((item) => {
                    const isOpen = openPathKeys.has(repoPathKey(item.path, platform))
                    return (
                      <button key={item.path} role="menuitem" title={item.path} onClick={() => openPath(item.path)}>
                        <FolderGit2 size={14} />
                        <span className="repo-open-text">
                          <span>{item.name}</span>
                          <small>{item.path}</small>
                        </span>
                        {isOpen ? <span className="repo-open-badge">open</span> : null}
                      </button>
                    )
                  })}
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
