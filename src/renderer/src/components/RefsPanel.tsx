import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  CloudUpload,
  Download,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  ListTree,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Unplug,
  Upload,
  Waypoints,
  X
} from 'lucide-react'
import type { GitOperationResult, RefInfo, StashInfo, TagInfo, WorktreeInfo, WorktreeStatus } from '@shared/types'
import { operationNotice, selectedIdentityId, useStore } from '../store'
import { call } from '../lib/ipc'
import { repoPathKey } from '../lib/tabs'
import {
  REF_SECTION_MIN_HEIGHT,
  defaultWorktreePath,
  findWorktreeForBranch,
  fitRefSections,
  groupLocalBranches,
  groupRemoteBranches,
  linkedWorktrees,
  localNameForRemote,
  matchesQuery,
  pathBaseName,
  refSectionBudget,
  remoteNameOf,
  sizeRefSections
} from '../lib/refs'
import type { RefSectionId } from '../lib/refs'
import { IconButton, Modal, Select, TextInput, Button, ConfirmDialog, Field } from './ui'

type SectionId = RefSectionId
type RowKind = 'branch' | 'remote' | 'worktree' | 'stash' | 'tag' | 'detached'

interface PanelRow {
  key: string
  kind: RowKind
  label: string
  title?: string
  current?: boolean
  branch?: RefInfo
  worktree?: WorktreeInfo
  stash?: StashInfo
  tag?: TagInfo
  status?: WorktreeStatus
  openTab?: boolean
  dirty?: number
  ahead?: number
  behind?: number
  worktreePath?: string
}

interface PanelGroup {
  key: string
  label: string
  rows: PanelRow[]
}

interface PanelSection {
  id: SectionId
  label: string
  count: number
  groups: PanelGroup[]
}

type MenuEntry =
  | {
      kind: 'item'
      id: string
      label: string
      icon: ReactNode
      danger?: boolean
      disabled?: boolean
      run: () => void
    }
  | { kind: 'separator'; id: string }

interface MenuState {
  left: number
  top: number
  maxHeight: number
  row: PanelRow
}

interface WorktreeDraft {
  mode: 'existing' | 'new'
  branch: string
  startPoint: string
  target: string
  /** Target follows the branch name until the user edits or browses for a folder. */
  autoTarget: boolean
}

interface BranchDraft {
  name: string
  startPoint: string
  checkout: boolean
}

/**
 * The refs body is a stack of panes: Local grows from the top, the remaining
 * sections keep a stored height and sit against the bottom edge. Every expanded
 * bottom pane can be resized by dragging the splitter above its header.
 */
const DEFAULT_SECTION_HEIGHT = 168
const MIN_SECTION_HEIGHT = REF_SECTION_MIN_HEIGHT
const SECTION_RESIZE_STEP = 24

/**
 * A compact, keyboard-first ref browser that lives inside the sidebar. It is a
 * switching surface, not a replacement for the Branches and Worktrees pages:
 * the same validated IPC calls are used and the full pages remain the place for
 * advanced work.
 */
export function RefsPanel() {
  const repo = useStore((state) => state.currentRepo)
  const repoStatus = useStore((state) => state.status)
  const branches = useStore((state) => state.branches)
  const worktrees = useStore((state) => state.worktrees)
  const stashes = useStore((state) => state.stashes)
  const tags = useStore((state) => state.tags)
  const tabs = useStore((state) => state.tabs)
  const config = useStore((state) => state.config)
  const detection = useStore((state) => state.detection)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const setView = useStore((state) => state.setView)
  const setSidebarMode = useStore((state) => state.setSidebarMode)
  const openRebase = useStore((state) => state.openRebase)

  const repoPath = repo?.path ?? ''
  const platform = window.commit87.platform
  const mainWorktreePath = worktrees.find((worktree) => worktree.isMain)?.path ?? repo?.root ?? ''
  /**
   * Only a readable checkout can be opened. A prunable or bare entry still shows
   * up in the list, but clicking its branch must fall back to a checkout instead
   * of trying to open a folder that is gone.
   */
  const checkoutWorktrees = useMemo(
    () => worktrees.filter((worktree) => !worktree.prunable && !worktree.bare),
    [worktrees]
  )

  const [query, setQuery] = useState('')
  const [collapsedSections, setCollapsedSections] = useState<Set<SectionId>>(
    () => new Set<SectionId>(['remote', 'stashes', 'tags'])
  )
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set<string>())
  const [activeIndex, setActiveIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [worktreeStatuses, setWorktreeStatuses] = useState<WorktreeStatus[]>([])
  const [statusNonce, setStatusNonce] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [sectionHeights, setSectionHeights] = useState<Partial<Record<SectionId, number>>>({})
  const [bodyHeight, setBodyHeight] = useState(0)
  const [resizingSection, setResizingSection] = useState<SectionId | null>(null)

  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDraft | null>(null)
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null)
  const [renameTarget, setRenameTarget] = useState<RefInfo | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<RefInfo | null>(null)
  const [deleteRemote, setDeleteRemote] = useState('')
  const [forceDelete, setForceDelete] = useState(false)
  const [remoteDelete, setRemoteDelete] = useState<{ name: string; remote: string } | null>(null)
  const [mergeTarget, setMergeTarget] = useState<RefInfo | null>(null)
  const [mergeMode, setMergeMode] = useState<'default' | 'no-ff' | 'ff-only' | 'squash'>('default')
  const [rebaseTarget, setRebaseTarget] = useState<RefInfo | null>(null)
  const [removeTarget, setRemoveTarget] = useState<WorktreeInfo | null>(null)
  const [forceRemove, setForceRemove] = useState(false)
  const [tagPush, setTagPush] = useState<TagInfo | null>(null)
  const [tagPushRemote, setTagPushRemote] = useState('origin')
  const [tagDelete, setTagDelete] = useState<TagInfo | null>(null)
  const [tagDeleteRemote, setTagDeleteRemote] = useState('')
  const [tagCheckout, setTagCheckout] = useState<TagInfo | null>(null)
  const [stashDrop, setStashDrop] = useState<StashInfo | null>(null)

  const filterRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{
    id: SectionId
    startY: number
    startHeight: number
    heights: Partial<Record<SectionId, number>>
  } | null>(null)
  const worktreeSignature = worktrees.map((worktree) => `${worktree.path}:${worktree.head ?? ''}`).join('|')

  useEffect(() => {
    filterRef.current?.focus()
  }, [])

  // A tab switch changes the repository under the panel: close transient UI so
  // an action opened for the previous checkout can never run against the new one.
  useEffect(() => {
    setMenu(null)
    setWorktreeDraft(null)
    setBranchDraft(null)
    setRenameTarget(null)
    setDeleteTarget(null)
    setRemoteDelete(null)
    setMergeTarget(null)
    setRebaseTarget(null)
    setRemoveTarget(null)
    setTagPush(null)
    setTagDelete(null)
    setTagCheckout(null)
    setStashDrop(null)
  }, [repoPath])

  useEffect(() => {
    if (!repoPath) return undefined
    let cancelled = false
    setWorktreeStatuses([])
    void call('git.worktreeStatuses', { path: repoPath })
      .then((list) => {
        if (!cancelled) setWorktreeStatuses(list)
      })
      .catch(() => {
        if (!cancelled) setWorktreeStatuses([])
      })
    return () => {
      cancelled = true
    }
  }, [repoPath, worktreeSignature, statusNonce])

  // The pane budget depends on the panel height; measure before paint so the
  // first frame does not fit every pane to the minimum.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return undefined
    const measure = (): void => setBodyHeight(body.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [repoPath])

  // A resize cannot survive the splitters unmounting, otherwise a later hover
  // over a remounted splitter would keep resizing without a pressed button.
  useEffect(
    () => () => {
      resizeRef.current = null
    },
    []
  )

  const run = useCallback(
    async (task: () => Promise<void>, success?: string): Promise<void> => {
      if (!repoPath) return
      setBusy(true)
      try {
        await task()
        await useStore.getState().refreshAll(repoPath)
        setStatusNonce((value) => value + 1)
        if (success) notify(success, 'success')
      } catch (error) {
        notifyError(error)
      } finally {
        setBusy(false)
      }
    },
    [notify, notifyError, repoPath]
  )

  /** Merge and rebase report the real outcome; a conflict is not success. */
  const runOutcome = useCallback(
    async (task: () => Promise<GitOperationResult>, success: string, label: string): Promise<void> => {
      if (!repoPath) return
      setBusy(true)
      try {
        const result = await task()
        await useStore.getState().refreshAll(repoPath)
        setStatusNonce((value) => value + 1)
        const notice = operationNotice(result, success, label)
        notify(notice.message, notice.kind)
      } catch (error) {
        notifyError(error)
      } finally {
        setBusy(false)
      }
    },
    [notify, notifyError, repoPath]
  )

  const openWorktree = useCallback(
    async (worktree: WorktreeInfo): Promise<void> => {
      if (worktree.isCurrent) return
      try {
        await useStore.getState().openRepo(worktree.path)
      } catch (error) {
        notifyError(error)
      }
    },
    [notifyError]
  )

  const switchBranch = useCallback(
    (branch: RefInfo): void => {
      if (!repoPath || branch.isCurrent) return
      const worktree = findWorktreeForBranch(checkoutWorktrees, branch.shortName)
      if (worktree) {
        void openWorktree(worktree)
        return
      }
      void run(async () => {
        await call('git.checkout', { repoPath, branch: branch.shortName })
      }, `Checked out ${branch.shortName}`)
    },
    [checkoutWorktrees, openWorktree, repoPath, run]
  )

  const switchRemote = useCallback(
    (branch: RefInfo): void => {
      if (!repoPath) return
      const localName = localNameForRemote(branch.shortName)
      const local = branches.find((item) => item.type === 'branch' && item.shortName === localName)
      if (local) {
        switchBranch(local)
        return
      }
      const worktree = findWorktreeForBranch(checkoutWorktrees, localName)
      if (worktree) {
        void openWorktree(worktree)
        return
      }
      void run(async () => {
        await call('git.checkout', {
          repoPath,
          branch: localName,
          create: true,
          startPoint: branch.shortName,
          track: true
        })
      }, `Checked out ${localName}`)
    },
    [branches, checkoutWorktrees, openWorktree, repoPath, run, switchBranch]
  )

  const showInGraph = useCallback(
    (ref: string): void => {
      if (!repoPath) return
      const state = useStore.getState()
      state.setGraphBranch(ref)
      state.setView('graph')
      void state.refreshTab(repoPath, false)
    },
    [repoPath]
  )

  /** A commit sha is not a ref, so it selects the commit instead of filtering. */
  const showCommitInGraph = useCallback((sha: string): void => {
    const state = useStore.getState()
    state.selectCommit(sha)
    state.setView('graph')
  }, [])

  const copyText = useCallback(
    (value: string, label: string): void => {
      void navigator.clipboard
        .writeText(value)
        .then(() => notify(`${label} copied`, 'success'))
        .catch((error) => notifyError(error))
    },
    [notify, notifyError]
  )

  const refreshRefs = useCallback(async (): Promise<void> => {
    if (!repoPath) return
    setRefreshing(true)
    try {
      await Promise.all([
        useStore.getState().refreshBranches(repoPath),
        useStore.getState().refreshTags(repoPath),
        useStore.getState().refreshWorktrees(repoPath),
        useStore.getState().refreshStashes(repoPath)
      ])
      setStatusNonce((value) => value + 1)
    } finally {
      setRefreshing(false)
    }
  }, [repoPath])

  const openBranchDialog = useCallback((startPoint = ''): void => {
    setBranchDraft({ name: '', startPoint, checkout: true })
  }, [])

  const openWorktreeDialog = useCallback(
    (branch?: RefInfo, remote?: RefInfo): void => {
      const checkedOut = branch ? findWorktreeForBranch(worktrees, branch.shortName) : undefined
      const canUseExisting = Boolean(branch && !branch.isCurrent && !checkedOut)
      const branchName = remote ? localNameForRemote(remote.shortName) : canUseExisting && branch ? branch.shortName : ''
      const startPoint = remote ? remote.shortName : branch?.shortName ?? repoStatus?.branch ?? ''
      const target = branchName
        ? defaultWorktreePath(mainWorktreePath, branchName, config?.worktreeParent, platform)
        : ''
      setWorktreeDraft({
        mode: canUseExisting ? 'existing' : 'new',
        branch: branchName,
        startPoint,
        target,
        autoTarget: true
      })
    },
    [config?.worktreeParent, mainWorktreePath, platform, repoStatus?.branch, worktrees]
  )

  const updateWorktreeDraft = (patch: Partial<WorktreeDraft>): void => {
    setWorktreeDraft((current) => {
      if (!current) return current
      const next = { ...current, ...patch }
      if (next.autoTarget) {
        next.target = next.branch.trim()
          ? defaultWorktreePath(mainWorktreePath, next.branch.trim(), config?.worktreeParent, platform)
          : ''
      }
      return next
    })
  }

  const createWorktree = (): void => {
    if (!worktreeDraft || !repoPath) return
    const branch = worktreeDraft.mode === 'new' ? worktreeDraft.branch.trim() : worktreeDraft.branch
    if (!branch) return
    const target =
      worktreeDraft.target.trim() ||
      defaultWorktreePath(mainWorktreePath, branch, config?.worktreeParent, platform)
    void run(async () => {
      await call('git.worktreeAdd', {
        repoPath,
        path: target,
        branch,
        createBranch: worktreeDraft.mode === 'new',
        startPoint: worktreeDraft.mode === 'new' ? worktreeDraft.startPoint || undefined : undefined
      })
      setWorktreeDraft(null)
    }, 'Worktree created')
  }

  const createBranch = (): void => {
    if (!branchDraft || !repoPath || !branchDraft.name.trim()) return
    const name = branchDraft.name.trim()
    const tracksRemote = branches.some(
      (branch) => branch.type === 'remote' && branch.shortName === branchDraft.startPoint
    )
    void run(async () => {
      await call('git.createBranch', {
        path: repoPath,
        name,
        startPoint: branchDraft.startPoint || undefined,
        checkout: branchDraft.checkout,
        track: tracksRemote
      })
      setBranchDraft(null)
    }, `Branch ${name} created`)
  }

  const doRename = (): void => {
    if (!renameTarget || !renameValue.trim() || !repoPath) return
    const to = renameValue.trim()
    void run(async () => {
      await call('git.renameBranch', { path: repoPath, from: renameTarget.shortName, to })
      setRenameTarget(null)
    }, 'Branch renamed')
  }

  const doDelete = (): void => {
    if (!deleteTarget || !repoPath) return
    void run(async () => {
      await call('git.deleteBranch', {
        path: repoPath,
        name: deleteTarget.shortName,
        force: forceDelete,
        remote: deleteRemote || undefined,
        identityId: selectedIdentityId(),
        accountId: detection.accountId
      })
      setDeleteTarget(null)
    }, 'Branch deleted')
  }

  const doRemoteDelete = (): void => {
    if (!remoteDelete || !repoPath) return
    void run(async () => {
      await call('git.deleteBranch', {
        path: repoPath,
        name: remoteDelete.name,
        remote: remoteDelete.remote,
        identityId: selectedIdentityId(),
        accountId: detection.accountId
      })
      setRemoteDelete(null)
    }, 'Remote branch deleted')
  }

  const doMerge = (): void => {
    if (!mergeTarget || !repoPath) return
    const target = mergeTarget.shortName
    void runOutcome(async () => {
      const result = await call('git.merge', {
        repoPath,
        branch: target,
        noFf: mergeMode === 'no-ff' || mergeMode === 'default',
        ffOnly: mergeMode === 'ff-only',
        squash: mergeMode === 'squash',
        identityId: selectedIdentityId()
      })
      setMergeTarget(null)
      return result
    }, `Merged ${target}`, `Merge of ${target}`)
  }

  const doRebase = (): void => {
    if (!rebaseTarget || !repoPath) return
    const target = rebaseTarget.shortName
    void runOutcome(async () => {
      const result = await call('git.rebase', {
        path: repoPath,
        onto: target,
        identityId: selectedIdentityId()
      })
      setRebaseTarget(null)
      return result
    }, `Rebased onto ${target}`, `Rebase onto ${target}`)
  }

  const doRemoveWorktree = (): void => {
    if (!removeTarget || !repoPath) return
    void run(async () => {
      await call('git.worktreeRemove', {
        path: repoPath,
        worktreePath: removeTarget.path,
        force: forceRemove
      })
      setRemoveTarget(null)
    }, 'Worktree removed')
  }

  const toggleWorktreeLock = (worktree: WorktreeInfo): void => {
    if (!repoPath) return
    void run(async () => {
      if (worktree.locked) {
        await call('git.worktreeUnlock', { path: repoPath, worktreePath: worktree.path })
      } else {
        await call('git.worktreeLock', { path: repoPath, worktreePath: worktree.path })
      }
    }, worktree.locked ? 'Worktree unlocked' : 'Worktree locked')
  }

  const pruneWorktrees = (): void => {
    if (!repoPath) return
    void run(async () => {
      await call('git.worktreePrune', { path: repoPath })
    }, 'Pruned stale worktrees')
  }

  const doTagPush = (): void => {
    if (!tagPush || !repoPath) return
    void run(async () => {
      await call('git.tagPush', {
        path: repoPath,
        name: tagPush.name,
        remote: tagPushRemote,
        identityId: selectedIdentityId(),
        accountId: detection.accountId
      })
      setTagPush(null)
    }, 'Tag pushed')
  }

  const doTagDelete = (): void => {
    if (!tagDelete || !repoPath) return
    void run(async () => {
      await call('git.tagDelete', {
        path: repoPath,
        name: tagDelete.name,
        remote: tagDeleteRemote || undefined
      })
      setTagDelete(null)
    }, 'Tag deleted')
  }

  const doTagCheckout = (): void => {
    if (!tagCheckout || !repoPath) return
    void run(async () => {
      // The fully qualified ref is authoritative: a branch with the same name
      // must not win ref lookup, and a short name is not stable.
      await call('git.checkout', { repoPath, branch: tagCheckout.ref, detach: true })
      setTagCheckout(null)
    }, `Checked out tag ${tagCheckout.name} (detached HEAD)`)
  }

  const applyStash = (stash: StashInfo, pop: boolean): void => {
    if (!repoPath) return
    void run(async () => {
      if (pop) await call('git.stashPop', { path: repoPath, index: stash.index })
      else await call('git.stashApply', { path: repoPath, index: stash.index })
    }, pop ? 'Stash popped' : 'Stash applied')
  }

  const doStashDrop = (): void => {
    if (!stashDrop || !repoPath) return
    void run(async () => {
      await call('git.stashDrop', { path: repoPath, index: stashDrop.index })
      setStashDrop(null)
    }, 'Stash dropped')
  }

  const filteredLocal = useMemo(
    () =>
      branches.filter(
        (branch) =>
          branch.type === 'branch' &&
          matchesQuery(query, branch.shortName, branch.upstream, branch.subject, branch.author)
      ),
    [branches, query]
  )
  const filteredRemote = useMemo(
    () =>
      branches.filter(
        (branch) =>
          branch.type === 'remote' &&
          matchesQuery(query, branch.shortName, branch.subject, branch.author)
      ),
    [branches, query]
  )
  const filteredWorktrees = useMemo(
    () =>
      worktrees.filter((worktree) =>
        matchesQuery(
          query,
          worktree.branch,
          worktree.path,
          worktree.locked ? 'locked' : '',
          worktree.prunable ? 'prunable' : '',
          worktree.detached ? 'detached' : ''
        )
      ),
    [query, worktrees]
  )
  const filteredStashes = useMemo(
    () =>
      stashes.filter((stash) =>
        matchesQuery(query, stash.message, stash.branch, `stash@{${stash.index}}`, stash.sha)
      ),
    [query, stashes]
  )
  const filteredTags = useMemo(
    () => tags.filter((tag) => matchesQuery(query, tag.name, tag.subject, tag.message)),
    [query, tags]
  )

  const statusByPath = useMemo(
    () => new Map(worktreeStatuses.map((status) => [status.path, status])),
    [worktreeStatuses]
  )
  const openTabPaths = useMemo(
    () =>
      new Set(
        tabs.flatMap((tab) => [
          repoPathKey(tab.currentRepo.path, platform),
          repoPathKey(tab.currentRepo.canonicalPath, platform)
        ])
      ),
    [platform, tabs]
  )

  const sections = useMemo<PanelSection[]>(() => {
    const localGroups: PanelGroup[] = []
    if (repoStatus?.detached && matchesQuery(query, 'detached head', repoStatus.headSha)) {
      localGroups.push({
        key: 'local:detached',
        label: '',
        rows: [
          {
            key: 'detached',
            kind: 'detached',
            label: 'detached HEAD',
            title: repoStatus.headSha ?? 'detached HEAD',
            current: true
          }
        ]
      })
    }
    for (const group of groupLocalBranches(filteredLocal)) {
      localGroups.push({
        key: `local:${group.folder || 'root'}`,
        label: group.folder,
        rows: group.branches.map((branch) => {
          const worktree = findWorktreeForBranch(worktrees, branch.shortName)
          return {
            key: `branch:${branch.name}`,
            kind: 'branch' as const,
            label: branch.shortName,
            title: `${branch.shortName}${branch.upstream ? ` → ${branch.upstream}` : ''}${
              worktree ? ` · worktree ${worktree.path}` : ''
            }`,
            current: branch.isCurrent,
            branch,
            ahead: branch.ahead,
            behind: branch.behind,
            worktreePath: worktree?.path
          }
        })
      })
    }

    const remoteGroups: PanelGroup[] = groupRemoteBranches(filteredRemote).flatMap((remoteGroup) =>
      remoteGroup.groups.map((group) => ({
        key: `remote:${remoteGroup.remote}:${group.folder || 'root'}`,
        label: group.folder ? `${remoteGroup.remote}/${group.folder}` : remoteGroup.remote,
        rows: group.branches.map((branch) => ({
          key: `remote:${branch.name}`,
          kind: 'remote' as const,
          label: localNameForRemote(branch.shortName),
          title: branch.shortName,
          branch
        }))
      }))
    )

    const worktreeRows: PanelRow[] = linkedWorktrees(filteredWorktrees).map((worktree) => {
      const status = statusByPath.get(worktree.path)
      return {
        key: `worktree:${worktree.path}`,
        kind: 'worktree',
        label: worktree.branch ?? (worktree.detached ? 'detached HEAD' : 'bare'),
        title: `${worktree.path}${worktree.lockReason ? ` · ${worktree.lockReason}` : ''}`,
        current: worktree.isCurrent,
        worktree,
        status,
        openTab: openTabPaths.has(repoPathKey(worktree.path, platform)),
        dirty: status?.available ? status.fileCount : 0
      }
    })

    const stashRows: PanelRow[] = filteredStashes.map((stash) => ({
      key: `stash:${stash.index}`,
      kind: 'stash',
      label: stash.message || 'Stashed changes',
      title: `stash@{${stash.index}} · ${stash.branch}`,
      stash
    }))

    const tagRows: PanelRow[] = filteredTags.map((tag) => ({
      key: `tag:${tag.name}`,
      kind: 'tag',
      label: tag.name,
      title: tag.subject || tag.message || tag.name,
      tag
    }))

    const section = (id: SectionId, label: string, groups: PanelGroup[]): PanelSection => {
      const populated = groups.filter((group) => group.rows.length > 0)
      return {
        id,
        label,
        groups: populated,
        count: populated.reduce((total, group) => total + group.rows.length, 0)
      }
    }

    return [
      section('local', 'Local', localGroups),
      section('remote', 'Remote', remoteGroups),
      section('worktrees', 'Worktrees', worktreeRows.length ? [{ key: 'worktrees', label: '', rows: worktreeRows }] : []),
      section('stashes', 'Stashes', stashRows.length ? [{ key: 'stashes', label: '', rows: stashRows }] : []),
      section('tags', 'Tags', tagRows.length ? [{ key: 'tags', label: '', rows: tagRows }] : [])
    ]
  }, [
    filteredLocal,
    filteredRemote,
    filteredStashes,
    filteredTags,
    filteredWorktrees,
    openTabPaths,
    platform,
    query,
    repoStatus?.detached,
    repoStatus?.headSha,
    statusByPath,
    worktrees
  ])

  const filtering = Boolean(query.trim())

  useEffect(() => {
    if (!filtering) return
    resizeRef.current = null
    setResizingSection(null)
  }, [filtering])

  const visibleRows = useMemo(() => {
    const rows: PanelRow[] = []
    for (const section of sections) {
      if (!filtering && collapsedSections.has(section.id)) continue
      for (const group of section.groups) {
        if (!filtering && collapsedGroups.has(group.key)) continue
        rows.push(...group.rows)
      }
    }
    return rows
  }, [collapsedGroups, collapsedSections, filtering, sections])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    setActiveIndex((value) => Math.min(value, Math.max(0, visibleRows.length - 1)))
  }, [visibleRows.length])

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, visibleRows.length])

  useEffect(() => {
    if (!menu) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(null)
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const toggleSection = (id: SectionId): void => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const bottomSections = sections.slice(1)
  const openBottomSections = (): SectionId[] =>
    bottomSections
      .filter((section) => section.count > 0 && !collapsedSections.has(section.id))
      .map((section) => section.id)
  const headerOnlyBottom = (): number =>
    bottomSections.filter((section) => section.count === 0 || collapsedSections.has(section.id)).length
  const localIsPane = (): boolean =>
    !collapsedSections.has('local') && (sections[0]?.count ?? 0) > 0
  const sectionBudget = (): number => {
    const height = bodyHeight || bodyRef.current?.clientHeight || 0
    return refSectionBudget(height, localIsPane(), headerOnlyBottom())
  }

  /**
   * Preferred sizes fitted into the current budget. `sectionHeights` keeps the
   * user's choice, so growing the panel or closing a pane restores it instead of
   * leaving everything at the last compressed size.
   */
  const fittedHeights = (): Partial<Record<SectionId, number>> => {
    const height = bodyHeight || bodyRef.current?.clientHeight || 0
    // Before the panel has been measured, keep the preferred sizes rather than
    // fitting everything to the budget floor.
    if (!height) return { ...sectionHeights }
    return fitRefSections(
      sectionHeights,
      openBottomSections(),
      sectionBudget(),
      MIN_SECTION_HEIGHT,
      DEFAULT_SECTION_HEIGHT
    )
  }

  /**
   * Heights the panes render at. A collapsed Local cannot grow into the height
   * it frees, so the first expanded section below takes that space and expands
   * upward; this is display-only and never becomes a preferred size.
   */
  const displayedHeights = (): Partial<Record<SectionId, number>> => {
    const displayed = fittedHeights()
    const open = openBottomSections()
    if (!localIsPane() && open.length > 0) {
      const used = open.reduce((sum, id) => sum + (displayed[id] ?? 0), 0)
      const leftover = Math.max(0, sectionBudget() - used)
      displayed[open[0]] = (displayed[open[0]] ?? 0) + leftover
    }
    return displayed
  }

  /** How far a pane can grow before the local section and every other pane hit their minimum. */
  const maxSectionHeight = (id: SectionId): number => {
    const others = openBottomSections().filter((sectionId) => sectionId !== id).length
    const maximum = sectionBudget() - others * MIN_SECTION_HEIGHT
    return Math.max(MIN_SECTION_HEIGHT, Math.round(maximum))
  }

  const applySectionHeight = (
    id: SectionId,
    height: number,
    base: Partial<Record<SectionId, number>> = fittedHeights()
  ): void => {
    setSectionHeights(
      sizeRefSections({
        heights: base,
        open: openBottomSections(),
        resized: id,
        requested: height,
        budget: sectionBudget(),
        minimum: MIN_SECTION_HEIGHT,
        fallback: DEFAULT_SECTION_HEIGHT
      })
    )
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, id: SectionId): void => {
    if (event.button !== 0) return
    event.preventDefault()
    // preventDefault suppresses the focus a tabIndex element would get, but the
    // arrow keys should keep working after a click on the handle.
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const base = fittedHeights()
    resizeRef.current = {
      id,
      startY: event.clientY,
      startHeight: displayedHeights()[id] ?? DEFAULT_SECTION_HEIGHT,
      heights: base
    }
    setResizingSection(id)
  }

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = resizeRef.current
    if (!active || event.buttons === 0) return
    // Dragging the divider upward grows the pane below it; every move is measured
    // from the drag start so returning the pointer restores the layout.
    applySectionHeight(active.id, active.startHeight + (active.startY - event.clientY), active.heights)
  }

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!resizeRef.current) return
    resizeRef.current = null
    setResizingSection(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const nudgeSectionHeight = (event: ReactKeyboardEvent<HTMLDivElement>, id: SectionId): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? SECTION_RESIZE_STEP : -SECTION_RESIZE_STEP
    applySectionHeight(id, (displayedHeights()[id] ?? DEFAULT_SECTION_HEIGHT) + delta)
  }

  const primaryAction = useCallback(
    (row: PanelRow): void => {
      setMenu(null)
      if (row.kind === 'branch' && row.branch) {
        switchBranch(row.branch)
        return
      }
      if (row.kind === 'remote' && row.branch) {
        switchRemote(row.branch)
        return
      }
      if (row.kind === 'worktree' && row.worktree) {
        void openWorktree(row.worktree)
        return
      }
      if (row.kind === 'stash') {
        setView('stashes')
        return
      }
      if (row.kind === 'tag' && row.tag) {
        showInGraph(row.tag.name)
      }
    },
    [openWorktree, setView, showInGraph, switchBranch, switchRemote]
  )

  const openMenu = (row: PanelRow, left: number, top: number): void => {
    const width = 240
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const clampedLeft = Math.max(6, Math.min(left, viewportWidth - width - 6))
    const clampedTop = Math.max(6, Math.min(top, viewportHeight - 80))
    setMenu({
      row,
      left: clampedLeft,
      top: clampedTop,
      maxHeight: Math.max(120, viewportHeight - clampedTop - 8)
    })
  }

  const openMenuAtEvent = (event: ReactMouseEvent, row: PanelRow): void => {
    event.preventDefault()
    event.stopPropagation()
    openMenu(row, event.clientX, event.clientY)
  }

  const openMenuFromButton = (event: ReactMouseEvent<HTMLButtonElement>, row: PanelRow): void => {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    openMenu(row, rect.right - 240, rect.bottom + 4)
  }

  const menuEntriesFor = (row: PanelRow): MenuEntry[] => {
    if (row.kind === 'branch' && row.branch) {
      const branch = row.branch
      const linked = findWorktreeForBranch(linkedWorktrees(checkoutWorktrees), branch.shortName)
      const registered = findWorktreeForBranch(worktrees, branch.shortName)
      return [
        {
          kind: 'item',
          id: 'switch',
          label: branch.isCurrent
            ? 'Already current'
            : linked
              ? `Open worktree ${pathBaseName(linked.path)}…`
              : registered?.isMain && !registered.isCurrent
                ? 'Open main checkout…'
                : 'Checkout branch…',
          icon: branch.isCurrent ? (
            <Check size={14} />
          ) : linked || registered?.isMain ? (
            <Waypoints size={14} />
          ) : (
            <GitBranch size={14} />
          ),
          disabled: branch.isCurrent,
          run: () => switchBranch(branch)
        },
        {
          kind: 'item',
          id: 'worktree',
          label: 'Create worktree…',
          icon: <Waypoints size={14} />,
          run: () => openWorktreeDialog(branch)
        },
        {
          kind: 'item',
          id: 'branch',
          label: 'New branch from here…',
          icon: <Plus size={14} />,
          run: () => openBranchDialog(branch.shortName)
        },
        { kind: 'separator', id: 'branch-sep-1' },
        {
          kind: 'item',
          id: 'merge',
          label: `Merge into ${repoStatus?.branch ?? 'current'}`,
          icon: <GitMerge size={14} />,
          disabled: branch.isCurrent,
          run: () => {
            setMergeMode('default')
            setMergeTarget(branch)
          }
        },
        {
          kind: 'item',
          id: 'rebase',
          label: 'Rebase current onto this',
          icon: <ArrowUpRight size={14} />,
          disabled: branch.isCurrent,
          run: () => setRebaseTarget(branch)
        },
        {
          kind: 'item',
          id: 'interactive',
          label: 'Interactive rebase onto this',
          icon: <ListTree size={14} />,
          disabled: branch.isCurrent,
          run: () => openRebase(branch.shortName)
        },
        { kind: 'separator', id: 'branch-sep-2' },
        {
          kind: 'item',
          id: 'graph',
          label: 'Show in graph',
          icon: <GitCommitHorizontal size={14} />,
          run: () => showInGraph(branch.name)
        },
        {
          kind: 'item',
          id: 'copy',
          label: 'Copy branch name',
          icon: <Clipboard size={14} />,
          run: () => copyText(branch.shortName, 'Branch name')
        },
        { kind: 'separator', id: 'branch-sep-3' },
        {
          kind: 'item',
          id: 'rename',
          label: 'Rename…',
          icon: <Pencil size={14} />,
          run: () => {
            setRenameTarget(branch)
            setRenameValue(branch.shortName)
          }
        },
        {
          kind: 'item',
          id: 'delete',
          label: 'Delete…',
          icon: <Trash2 size={14} />,
          danger: true,
          disabled: branch.isCurrent || Boolean(registered),
          run: () => {
            setDeleteTarget(branch)
            setForceDelete(false)
            setDeleteRemote('')
          }
        }
      ]
    }

    if (row.kind === 'remote' && row.branch) {
      const branch = row.branch
      const localName = localNameForRemote(branch.shortName)
      const remote = remoteNameOf(branch.shortName)
      return [
        {
          kind: 'item',
          id: 'checkout',
          label: 'Checkout branch…',
          icon: <GitBranch size={14} />,
          run: () => switchRemote(branch)
        },
        {
          kind: 'item',
          id: 'worktree',
          label: 'Create worktree…',
          icon: <Waypoints size={14} />,
          run: () => openWorktreeDialog(undefined, branch)
        },
        {
          kind: 'item',
          id: 'graph',
          label: 'Show in graph',
          icon: <GitCommitHorizontal size={14} />,
          run: () => showInGraph(branch.name)
        },
        {
          kind: 'item',
          id: 'copy',
          label: 'Copy branch name',
          icon: <Clipboard size={14} />,
          run: () => copyText(branch.shortName, 'Branch name')
        },
        { kind: 'separator', id: 'remote-sep' },
        {
          kind: 'item',
          id: 'delete',
          label: `Delete ${remote}/${localName} on remote…`,
          icon: <Trash2 size={14} />,
          danger: true,
          run: () => setRemoteDelete({ name: localName, remote })
        }
      ]
    }

    if (row.kind === 'worktree' && row.worktree) {
      const worktree = row.worktree
      return [
        {
          kind: 'item',
          id: 'open',
          label: worktree.isCurrent ? 'Currently open' : row.openTab ? 'Activate tab' : 'Open worktree',
          icon: <FolderOpen size={14} />,
          disabled: worktree.isCurrent,
          run: () => void openWorktree(worktree)
        },
        {
          kind: 'item',
          id: 'reveal',
          label: 'Reveal in file manager',
          icon: <FolderOpen size={14} />,
          run: () => {
            void call('app.showItemInFolder', { path: worktree.path }).catch(notifyError)
          }
        },
        {
          kind: 'item',
          id: 'copy',
          label: 'Copy worktree path',
          icon: <Clipboard size={14} />,
          run: () => copyText(worktree.path, 'Worktree path')
        },
        { kind: 'separator', id: 'worktree-sep-1' },
        {
          kind: 'item',
          id: 'lock',
          label: worktree.locked ? 'Unlock worktree' : 'Lock worktree',
          icon: worktree.locked ? <LockOpen size={14} /> : <Lock size={14} />,
          run: () => toggleWorktreeLock(worktree)
        },
        {
          kind: 'item',
          id: 'remove',
          label: 'Remove worktree…',
          icon: <Trash2 size={14} />,
          danger: true,
          disabled: worktree.isCurrent,
          run: () => {
            setRemoveTarget(worktree)
            setForceRemove(Boolean(worktree.prunable))
          }
        },
        { kind: 'separator', id: 'worktree-sep-2' },
        {
          kind: 'item',
          id: 'prune',
          label: 'Prune stale worktrees',
          icon: <Unplug size={14} />,
          run: () => pruneWorktrees()
        }
      ]
    }

    if (row.kind === 'stash' && row.stash) {
      const stash = row.stash
      return [
        {
          kind: 'item',
          id: 'apply',
          label: 'Apply stash',
          icon: <Download size={14} />,
          run: () => applyStash(stash, false)
        },
        {
          kind: 'item',
          id: 'pop',
          label: 'Pop stash',
          icon: <Upload size={14} />,
          run: () => applyStash(stash, true)
        },
        {
          kind: 'item',
          id: 'stashes',
          label: 'Open stashes view',
          icon: <ArrowUpRight size={14} />,
          run: () => setView('stashes')
        },
        { kind: 'separator', id: 'stash-sep' },
        {
          kind: 'item',
          id: 'copy',
          label: 'Copy stash message',
          icon: <Clipboard size={14} />,
          run: () => copyText(stash.message || `stash@{${stash.index}}`, 'Stash message')
        },
        {
          kind: 'item',
          id: 'drop',
          label: 'Drop stash…',
          icon: <Trash2 size={14} />,
          danger: true,
          run: () => setStashDrop(stash)
        }
      ]
    }

    if (row.kind === 'tag' && row.tag) {
      const tag = row.tag
      return [
        {
          kind: 'item',
          id: 'graph',
          label: 'Show in graph',
          icon: <GitCommitHorizontal size={14} />,
          run: () => showInGraph(tag.name)
        },
        {
          kind: 'item',
          id: 'checkout',
          label: 'Check out detached…',
          icon: <GitBranch size={14} />,
          run: () => setTagCheckout(tag)
        },
        { kind: 'separator', id: 'tag-sep-1' },
        {
          kind: 'item',
          id: 'push',
          label: 'Push tag…',
          icon: <CloudUpload size={14} />,
          run: () => {
            setTagPushRemote('origin')
            setTagPush(tag)
          }
        },
        {
          kind: 'item',
          id: 'delete',
          label: 'Delete tag…',
          icon: <Trash2 size={14} />,
          danger: true,
          run: () => {
            setTagDeleteRemote('')
            setTagDelete(tag)
          }
        },
        {
          kind: 'item',
          id: 'copy',
          label: 'Copy tag name',
          icon: <Clipboard size={14} />,
          run: () => copyText(tag.name, 'Tag name')
        }
      ]
    }

    if (row.kind === 'detached') {
      return [
        {
          kind: 'item',
          id: 'branch',
          label: 'New branch here…',
          icon: <Plus size={14} />,
          run: () => openBranchDialog('HEAD')
        },
        {
          kind: 'item',
          id: 'graph',
          label: 'Show HEAD in graph',
          icon: <GitCommitHorizontal size={14} />,
          run: () => {
            if (repoStatus?.headSha) showCommitInGraph(repoStatus.headSha)
          }
        },
        {
          kind: 'item',
          id: 'copy',
          label: 'Copy HEAD SHA',
          icon: <Clipboard size={14} />,
          run: () => copyText(repoStatus?.headSha ?? 'HEAD', 'HEAD SHA')
        }
      ]
    }

    return []
  }

  const onFilterKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((value) => Math.min(value + 1, Math.max(0, visibleRows.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((value) => Math.max(0, value - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = visibleRows[activeIndex]
      if (row) primaryAction(row)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (query) {
        setQuery('')
        filterRef.current?.focus()
      } else {
        setSidebarMode('navigate')
      }
    }
  }

  const rowIcon = (row: PanelRow): ReactNode => {
    if (row.kind === 'branch') return row.branch?.isCurrent ? <Check size={12} /> : <GitBranch size={12} />
    if (row.kind === 'remote') return <GitBranch size={12} className="refs-icon-remote" />
    if (row.kind === 'worktree') return <Waypoints size={12} />
    if (row.kind === 'stash') return <History size={12} />
    if (row.kind === 'tag') return <Tag size={12} />
    return <GitCommitHorizontal size={12} />
  }

  const rowMeta = (row: PanelRow): ReactNode => {
    const meta: ReactNode[] = []
    if (row.kind === 'branch' || row.kind === 'remote') {
      if (row.ahead) {
        meta.push(
          <span className="refs-ahead" key="ahead" title={`${row.ahead} ahead`}>
            <ArrowUp size={9} />
            {row.ahead}
          </span>
        )
      }
      if (row.behind) {
        meta.push(
          <span className="refs-behind" key="behind" title={`${row.behind} behind`}>
            <ArrowDown size={9} />
            {row.behind}
          </span>
        )
      }
      if (row.worktreePath) {
        meta.push(
          <span key="worktree" title={`Checked out in ${row.worktreePath}`}>
            <Waypoints size={10} />
          </span>
        )
      }
    }
    if (row.kind === 'worktree') {
      if (row.current) meta.push(<span className="refs-open" key="current">current</span>)
      else if (row.openTab) meta.push(<span className="refs-open" key="open">open</span>)
      if (row.status && !row.status.available) {
        meta.push(
          <span className="refs-unavailable" key="missing" title="Worktree is not readable">
            missing
          </span>
        )
      } else if (row.dirty) {
        meta.push(
          <span
            className="refs-dirty"
            key="dirty"
            title={`${row.dirty} changed file${row.dirty === 1 ? '' : 's'}`}
          />
        )
      }
      if (row.worktree?.locked) {
        meta.push(
          <span key="locked" title={row.worktree.lockReason || 'Locked'}>
            <Lock size={10} />
          </span>
        )
      }
      if (row.worktree?.prunable) meta.push(<span className="refs-unavailable" key="prunable">prunable</span>)
      if (row.worktree?.isMain) meta.push(<span className="refs-main" key="main">main</span>)
    }
    if (row.kind === 'stash') meta.push(<span key="index">stash@{row.stash?.index}</span>)
    if (row.kind === 'tag' && row.tag?.annotated) meta.push(<span key="annotated">tag</span>)
    if (row.kind === 'detached' && repoStatus?.headSha) {
      meta.push(
        <span className="refs-sha" key="sha">
          {repoStatus.headSha.slice(0, 7)}
        </span>
      )
    }
    return meta.length ? <span className="refs-row-meta">{meta}</span> : null
  }

  const sectionAction = (section: PanelSection): ReactNode => {
    if (section.id === 'local') {
      return (
        <IconButton label="New branch" onClick={() => openBranchDialog(repoStatus?.branch ?? '')}>
          <Plus size={13} />
        </IconButton>
      )
    }
    if (section.id === 'remote') {
      return (
        <IconButton label="Refresh refs" onClick={() => void refreshRefs()}>
          <RefreshCw size={13} />
        </IconButton>
      )
    }
    if (section.id === 'worktrees') {
      return (
        <>
          <IconButton label="Add worktree" onClick={() => openWorktreeDialog()}>
            <Plus size={13} />
          </IconButton>
          <IconButton label="Prune stale worktrees" onClick={pruneWorktrees}>
            <Unplug size={13} />
          </IconButton>
        </>
      )
    }
    if (section.id === 'stashes') {
      return (
        <IconButton
          label="Open stashes view"
          onClick={() => {
            setView('stashes')
            setSidebarMode('navigate')
          }}
        >
          <ArrowUpRight size={13} />
        </IconButton>
      )
    }
    if (section.id === 'tags') {
      return (
        <IconButton
          label="Open tags view"
          onClick={() => {
            setView('tags')
            setSidebarMode('navigate')
          }}
        >
          <ArrowUpRight size={13} />
        </IconButton>
      )
    }
    return null
  }

  if (!repo) return null

  const allSectionsEmpty = sections.every((section) => section.count === 0)
  const displayed = displayedHeights()
  // While Local is collapsed, its freed space is given to this pane, so its own
  // splitter would have nothing left to move.
  const filler = localIsPane() ? undefined : openBottomSections()[0]
  let rowIndex = 0

  const renderSection = (section: PanelSection, index: number): ReactNode => {
    if (filtering && section.count === 0) return null
    const sectionCollapsed = !filtering && collapsedSections.has(section.id)
    const isTop = index === 0
    const empty = section.count === 0
    const isPane = !filtering && !isTop && !sectionCollapsed && !empty
    const resizable = isPane && section.id !== filler
    const className = [
      'refs-section',
      isTop ? 'is-top' : 'is-bottom',
      sectionCollapsed ? 'is-collapsed' : 'is-expanded',
      resizable ? 'is-resizable' : '',
      empty ? 'is-empty' : ''
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <section
        className={className}
        key={section.id}
        data-section={section.id}
        style={isPane ? { flexBasis: `${displayed[section.id] ?? DEFAULT_SECTION_HEIGHT}px` } : undefined}
      >
        {resizable ? (
          <div
            className={`refs-splitter ${resizingSection === section.id ? 'is-resizing' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Resize ${section.label} section`}
            aria-valuenow={Math.round(displayed[section.id] ?? DEFAULT_SECTION_HEIGHT)}
            aria-valuemin={MIN_SECTION_HEIGHT}
            aria-valuemax={Math.round(maxSectionHeight(section.id))}
            tabIndex={0}
            onPointerDown={(event) => startResize(event, section.id)}
            onPointerMove={moveResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={finishResize}
            onKeyDown={(event) => nudgeSectionHeight(event, section.id)}
            onDoubleClick={() => applySectionHeight(section.id, DEFAULT_SECTION_HEIGHT)}
          >
            <span className="refs-splitter-grip" />
          </div>
        ) : null}
        <div className="refs-section-head">
          <button
            className="refs-section-toggle"
            aria-expanded={!sectionCollapsed}
            onClick={() => toggleSection(section.id)}
          >
            {sectionCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span>{section.label}</span>
            <span className="refs-count">{section.count}</span>
          </button>
          <div className="refs-section-actions">{sectionAction(section)}</div>
        </div>

        {!sectionCollapsed && !empty ? (
          <div className="refs-section-body">
            {section.groups.map((group) => {
              const groupCollapsed = !filtering && collapsedGroups.has(group.key)
              return (
                <div className="refs-group" key={group.key}>
                  {group.label ? (
                    <button
                      className="refs-group-head"
                      aria-expanded={!groupCollapsed}
                      onClick={() => toggleGroup(group.key)}
                    >
                      {groupCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span>{group.label}</span>
                    </button>
                  ) : null}
                  {!groupCollapsed
                    ? group.rows.map((row) => {
                        const rowNumber = rowIndex
                        rowIndex += 1
                        const active = rowNumber === activeIndex
                        return (
                          <div
                            className={`refs-row ${row.current ? 'is-current' : ''} ${active ? 'is-active' : ''}`}
                            key={row.key}
                            onContextMenu={(event) => openMenuAtEvent(event, row)}
                          >
                            <button
                              ref={active ? activeRowRef : undefined}
                              className="refs-row-main"
                              title={`${row.title ?? row.label}\nDouble-click or press Enter to ${
                                row.kind === 'branch' || row.kind === 'remote' || row.kind === 'worktree'
                                  ? 'switch'
                                  : 'open'
                              }`}
                              aria-current={row.current ? 'true' : undefined}
                              onMouseMove={() => setActiveIndex(rowNumber)}
                              onClick={() => setActiveIndex(rowNumber)}
                              onDoubleClick={() => {
                                setActiveIndex(rowNumber)
                                primaryAction(row)
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  setActiveIndex(rowNumber)
                                  primaryAction(row)
                                  return
                                }
                                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                                  event.preventDefault()
                                  const rect = event.currentTarget.getBoundingClientRect()
                                  openMenu(row, rect.left + 12, rect.bottom + 2)
                                }
                              }}
                            >
                              <span className="refs-row-icon">{rowIcon(row)}</span>
                              <span className="refs-row-label">{row.label}</span>
                              {rowMeta(row)}
                            </button>
                            <IconButton
                              label="Ref actions"
                              className="refs-row-more"
                              aria-haspopup="menu"
                              onClick={(event) => openMenuFromButton(event, row)}
                            >
                              <MoreHorizontal size={14} />
                            </IconButton>
                          </div>
                        )
                      })
                    : null}
                </div>
              )
            })}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <div className="refs-panel" role="tabpanel" aria-label="Repository refs">
      <div className="refs-toolbar">
        <div className="refs-search">
          <Search size={13} />
          <input
            ref={filterRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter refs…"
            spellCheck={false}
            aria-label="Filter branches, worktrees, stashes and tags"
          />
          {query ? (
            <button
              className="refs-clear"
              aria-label="Clear ref filter"
              onClick={() => {
                setQuery('')
                filterRef.current?.focus()
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <IconButton label="Refresh refs" disabled={refreshing} onClick={() => void refreshRefs()}>
          <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
        </IconButton>
      </div>

      <div className={`refs-body ${filtering ? 'is-filtering' : ''}`} ref={bodyRef}>
        {filtering && allSectionsEmpty ? <div className="refs-empty">No refs match “{query.trim()}”.</div> : null}
        {filtering ? (
          sections.map(renderSection)
        ) : (
          <>
            {sections[0] ? renderSection(sections[0], 0) : null}
            <div className="refs-bottom">
              {sections.slice(1).map((section, index) => renderSection(section, index + 1))}
            </div>
          </>
        )}
      </div>

      <div className="refs-footer">
        <button onClick={() => { setView('branches'); setSidebarMode('navigate') }}>Branches</button>
        <button onClick={() => { setView('worktrees'); setSidebarMode('navigate') }}>Worktrees</button>
        <button onClick={() => { setView('tags'); setSidebarMode('navigate') }}>Tags</button>
        <button onClick={() => { setView('stashes'); setSidebarMode('navigate') }}>Stashes</button>
      </div>

      {menu ? (
        <>
          <div className="click-catcher" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null) }} />
          <div
            className="dropdown refs-menu"
            role="menu"
            style={{ left: menu.left, top: menu.top, maxHeight: menu.maxHeight }}
          >
            {menuEntriesFor(menu.row).map((entry) =>
              entry.kind === 'separator' ? (
                <div className="refs-menu-sep" key={entry.id} />
              ) : (
                <button
                  key={entry.id}
                  role="menuitem"
                  className={entry.danger ? 'is-danger' : ''}
                  disabled={entry.disabled || busy}
                  onClick={() => {
                    setMenu(null)
                    entry.run()
                  }}
                >
                  {entry.icon}
                  <span>{entry.label}</span>
                </button>
              )
            )}
          </div>
        </>
      ) : null}

      <Modal
        open={Boolean(worktreeDraft)}
        title="Add worktree"
        subtitle="Check out a branch in a separate folder"
        onClose={() => setWorktreeDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setWorktreeDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!worktreeDraft || !worktreeDraft.branch.trim()}
              onClick={createWorktree}
            >
              Create worktree
            </Button>
          </>
        }
      >
        {worktreeDraft ? (
          <>
            <Field label="Mode">
              <Select
                value={worktreeDraft.mode}
                onChange={(event) => {
                  const mode = event.target.value as WorktreeDraft['mode']
                  updateWorktreeDraft({
                    mode,
                    branch: mode === 'existing' ? '' : worktreeDraft.branch,
                    startPoint: worktreeDraft.startPoint
                  })
                }}
              >
                <option value="new">Create a new branch</option>
                <option value="existing">Use an existing branch</option>
              </Select>
            </Field>
            {worktreeDraft.mode === 'new' ? (
              <>
                <Field label="New branch name">
                  <TextInput
                    value={worktreeDraft.branch}
                    onChange={(event) => updateWorktreeDraft({ branch: event.target.value })}
                    placeholder="feature/my-branch"
                    autoFocus
                  />
                </Field>
                <Field label="Start point">
                  <Select
                    value={worktreeDraft.startPoint}
                    onChange={(event) => updateWorktreeDraft({ startPoint: event.target.value })}
                  >
                    <option value="">Current HEAD ({repoStatus?.branch ?? 'detached'})</option>
                    {worktreeDraft.startPoint &&
                    !branches.some((branch) => branch.shortName === worktreeDraft.startPoint) ? (
                      <option value={worktreeDraft.startPoint}>{worktreeDraft.startPoint}</option>
                    ) : null}
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.shortName}>
                        {branch.shortName}
                        {branch.type === 'remote' ? ' (remote)' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : (
              <Field label="Branch">
                <Select
                  value={worktreeDraft.branch}
                  onChange={(event) => updateWorktreeDraft({ branch: event.target.value })}
                >
                  <option value="">Select a branch…</option>
                  {branches
                    .filter(
                      (branch) =>
                        branch.type === 'branch' &&
                        !branch.isCurrent &&
                        !findWorktreeForBranch(worktrees, branch.shortName)
                    )
                    .map((branch) => (
                      <option key={branch.name} value={branch.shortName}>
                        {branch.shortName}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            <Field label="Folder" hint="Must be outside the repository root. Follows the branch name until you pick a folder.">
              <div className="row-gap">
                <TextInput
                  value={worktreeDraft.target}
                  onChange={(event) => updateWorktreeDraft({ target: event.target.value, autoTarget: false })}
                  placeholder={defaultWorktreePath(
                    mainWorktreePath,
                    worktreeDraft.branch || 'worktree',
                    config?.worktreeParent,
                    platform
                  )}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void call('app.pickDirectory', {
                      title: 'Choose worktree folder',
                      defaultPath: worktreeDraft.target || undefined
                    }).then((chosen) => {
                      if (chosen) updateWorktreeDraft({ target: chosen, autoTarget: false })
                    })
                  }
                >
                  Browse…
                </Button>
              </div>
            </Field>
            {worktreeDraft.mode === 'existing' &&
            worktreeDraft.branch &&
            findWorktreeForBranch(worktrees, worktreeDraft.branch) ? (
              <div className="danger-note">That branch is already checked out in another worktree.</div>
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(branchDraft)}
        title="Create branch"
        onClose={() => setBranchDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBranchDraft(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!branchDraft?.name.trim()}
              onClick={createBranch}
            >
              Create
            </Button>
          </>
        }
      >
        {branchDraft ? (
          <>
            <Field label="Branch name">
              <TextInput
                value={branchDraft.name}
                onChange={(event) => setBranchDraft({ ...branchDraft, name: event.target.value })}
                placeholder="feature/my-branch"
                autoFocus
              />
            </Field>
            <Field label="Start point">
              <Select
                value={branchDraft.startPoint}
                onChange={(event) => setBranchDraft({ ...branchDraft, startPoint: event.target.value })}
              >
                <option value="">HEAD ({repoStatus?.branch ?? 'detached'})</option>
                {branchDraft.startPoint &&
                !branches.some((branch) => branch.shortName === branchDraft.startPoint) ? (
                  <option value={branchDraft.startPoint}>{branchDraft.startPoint}</option>
                ) : null}
                {branches.map((branch) => (
                  <option key={branch.name} value={branch.shortName}>
                    {branch.shortName}
                    {branch.type === 'remote' ? ' (remote)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={branchDraft.checkout}
                onChange={(event) => setBranchDraft({ ...branchDraft, checkout: event.target.checked })}
              />
              Check out the new branch
            </label>
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        title={`Rename ${renameTarget?.shortName ?? ''}`}
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={doRename}>Rename</Button>
          </>
        }
      >
        <Field label="New name">
          <TextInput value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
        </Field>
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.shortName ?? ''}`}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={doDelete}>Delete branch</Button>
          </>
        }
      >
        <p className="confirm-message">This removes the local branch. Unmerged commits would be lost when force deleting.</p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={forceDelete}
            onChange={(event) => setForceDelete(event.target.checked)}
          />
          Force delete (discard unmerged commits)
        </label>
        <Field label="Also delete on remote" hint="Requires a configured integration token to authenticate.">
          <Select value={deleteRemote} onChange={(event) => setDeleteRemote(event.target.value)}>
            <option value="">Do not delete on remote</option>
            {repo.remotes.map((remote) => (
              <option key={remote.name} value={remote.name}>{remote.name}</option>
            ))}
          </Select>
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(remoteDelete)}
        title={`Delete ${remoteDelete?.remote ?? ''}/${remoteDelete?.name ?? ''}`}
        message={`This deletes the branch on ${remoteDelete?.remote ?? 'the remote'}. Local branches are kept. This cannot be undone.`}
        confirmLabel="Delete on remote"
        danger
        busy={busy}
        onCancel={() => setRemoteDelete(null)}
        onConfirm={doRemoteDelete}
      />

      <Modal
        open={Boolean(mergeTarget)}
        title={`Merge ${mergeTarget?.shortName ?? ''}`}
        onClose={() => setMergeTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMergeTarget(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={doMerge}>Merge</Button>
          </>
        }
      >
        <Field label="Strategy">
          <Select value={mergeMode} onChange={(event) => setMergeMode(event.target.value as typeof mergeMode)}>
            <option value="default">Create merge commit (--no-ff)</option>
            <option value="no-ff">Always merge commit (--no-ff)</option>
            <option value="ff-only">Fast-forward only</option>
            <option value="squash">Squash</option>
          </Select>
        </Field>
        <p className="muted">
          Merging into {repoStatus?.branch ?? 'the current branch'}. The commit uses this repository's configured Git
          identity.
        </p>
      </Modal>

      <ConfirmDialog
        open={Boolean(rebaseTarget)}
        title={`Rebase onto ${rebaseTarget?.shortName ?? ''}?`}
        message={`Replays ${repoStatus?.branch ?? 'the current branch'} commits on top of ${rebaseTarget?.shortName ?? 'the selected branch'}. Conflicts can be resolved from the status bar.`}
        confirmLabel="Rebase"
        busy={busy}
        onCancel={() => setRebaseTarget(null)}
        onConfirm={doRebase}
      />

      <Modal
        open={Boolean(removeTarget)}
        title="Remove worktree"
        onClose={() => setRemoveTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={doRemoveWorktree}>Remove worktree</Button>
          </>
        }
      >
        <p className="confirm-message">
          Remove the worktree at <strong>{removeTarget?.path}</strong>? The branch itself is kept.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={forceRemove}
            onChange={(event) => setForceRemove(event.target.checked)}
          />
          Force removal (discards uncommitted changes in that worktree)
        </label>
      </Modal>

      <Modal
        open={Boolean(tagPush)}
        title={`Push ${tagPush?.name ?? ''}`}
        onClose={() => setTagPush(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTagPush(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} icon={<CloudUpload size={14} />} onClick={doTagPush}>
              Push tag
            </Button>
          </>
        }
      >
        <Field label="Remote">
          <Select value={tagPushRemote} onChange={(event) => setTagPushRemote(event.target.value)}>
            {repo.remotes.map((remote) => (
              <option key={remote.name} value={remote.name}>{remote.name}</option>
            ))}
          </Select>
        </Field>
        <div className="inline-info">
          <GitCommitHorizontal size={14} /> {tagPush?.targetSha.slice(0, 12)} · {tagPush?.subject || 'tag'}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(tagDelete)}
        title={`Delete tag ${tagDelete?.name ?? ''}`}
        message={
          <div>
            <p>This deletes the local tag{tagDeleteRemote ? ' and the remote tag' : ''}. This cannot be undone.</p>
            <Field label="Also delete on remote">
              <Select value={tagDeleteRemote} onChange={(event) => setTagDeleteRemote(event.target.value)}>
                <option value="">Local only</option>
                {repo.remotes.map((remote) => (
                  <option key={remote.name} value={remote.name}>{remote.name}</option>
                ))}
              </Select>
            </Field>
          </div>
        }
        confirmLabel="Delete tag"
        danger
        busy={busy}
        onCancel={() => setTagDelete(null)}
        onConfirm={doTagDelete}
      />

      <ConfirmDialog
        open={Boolean(tagCheckout)}
        title={`Check out ${tagCheckout?.name ?? ''}?`}
        message="This detaches HEAD at the tag. Create a branch afterwards to keep working."
        confirmLabel="Check out"
        busy={busy}
        onCancel={() => setTagCheckout(null)}
        onConfirm={doTagCheckout}
      />

      <ConfirmDialog
        open={Boolean(stashDrop)}
        title="Drop stash"
        message={`Drop stash@{${stashDrop?.index ?? 0}}? The stashed changes will be lost permanently.`}
        confirmLabel="Drop"
        danger
        busy={busy}
        onCancel={() => setStashDrop(null)}
        onConfirm={doStashDrop}
      />
    </div>
  )
}