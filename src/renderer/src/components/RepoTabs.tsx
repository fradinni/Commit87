import { useEffect, useRef, useState } from 'react'
import { FolderGit2, GitBranch, Plus, Waypoints, X } from 'lucide-react'
import { useStore } from '../store'

/**
 * Editor-style strip of open repositories. Each tab owns its data and view, so
 * switching is a hydrate rather than a reload.
 */
export function RepoTabs({ onOpen }: { onOpen: () => void }) {
  const tabs = useStore((state) => state.tabs)
  const activeTabId = useStore((state) => state.activeTabId)
  const activateTab = useStore((state) => state.activateTab)
  const closeTab = useStore((state) => state.closeTab)
  const moveTab = useStore((state) => state.moveTab)
  const [dragging, setDragging] = useState<string | null>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  if (!tabs.length) return null

  return (
    <div className="repo-tabs" role="tablist" aria-label="Open repositories">
      <div className="repo-tabs-scroll" role="presentation">
        {tabs.map((tab, index) => {
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
                title={`${tab.currentRepo.name}\n${tab.currentRepo.path}`}
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
      <button
        className="repo-tab-add"
        onClick={onOpen}
        title="Open repository"
        aria-label="Open repository in a new tab"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
