# Recovery and limits

Commit87 runs real Git commands, so the repository keeps everything Git keeps. The app
itself has no trash, no operation history and no undo button. This page says exactly what
survives each destructive action and what does not.

## Quick reference

| Action | Undo in Commit87 | What remains |
| --- | --- | --- |
| Discard tracked changes | No | The file is restored from `HEAD`; the discarded worktree content is gone |
| Discard an untracked file | No | `git clean -f -d` deletes it; Git never had a copy |
| Drop a stash | No | The stash commit may stay unreferenced for a while; no app action restores it |
| Delete a local branch or tag | No | A branch tip may still be in the reflog for Git's expiry window; no app action restores it |
| Reset `--hard` | No | The previous tip may be in the branch reflog; worktree changes are gone |
| Force-remove a worktree | No | The folder and its uncommitted work are deleted; the branch ref itself survives |
| Remove a submodule | Not needed for history | The module clone is moved aside, not deleted |
| Interrupted merge/rebase/cherry-pick/revert/`am` | Yes, on disk | Real Git state; reopen the repository and Continue, Skip or Abort |
| Install an update | No rollback in the app | Re-download the previous release from the releases page |

Use **Settings → Appearance → Confirm destructive actions** to keep the confirmation
prompts on. When in doubt, create a stash before discarding or resetting: a stash is a real
commit and is listed in the Stashes view until you drop it.

## Discard has no app-level undo

The staging view shows a file once per changed side, but the side selects which diff you
review — discard itself acts on the whole path:

- a tracked path is restored with `git restore --source=HEAD --staged --worktree -- <path>`,
  so both the index and the worktree copy become the `HEAD` version;
- an untracked path is deleted with `git clean -f -d -- <path>` only when the confirmation
  explicitly covers untracked files.

For a partially staged file, discarding either the staged row or the worktree row therefore
drops **both** sides. To keep one side, use the git console (`git restore --worktree` or
`git restore --staged` for the side you want to drop) or stash the work before discarding.
A failed restore is reported per path, with Git's output, instead of being reported as
success.

Git may occasionally still hold an unreferenced blob for content that was staged before it
was discarded. That is not a recovery guarantee, and Commit87 offers no action that reads
it. Content that was never added to the index has no copy at all.

To recover something important: stop using the repository, then inspect it with the git
console (`git fsck --lost-found`, `git reflog`) or in a terminal. Nothing in the app blocks
you from doing that.

## Submodule removal keeps the module clone

Removing a submodule removes the checkout, the gitlink and the `.gitmodules` entry (the
change is staged) and never touches the remote repository. Before the checkout disappears,
its module clone is renamed — not copied or deleted — to:

```text
<git-dir>/modules/<name>.removed-<timestamp>
```

For a linked worktree, the module directory belongs to that worktree's Git directory, so
the main checkout's clone is untouched. The removal message shows the exact retained path.

What stays recoverable there:

- commits that were never pushed from the submodule;
- branches, tags and other local refs in the clone;
- stashes in the clone;
- the object database itself, because the move is a rename inside the same Git directory.

Ways back:

- **Re-add the same submodule** at the same path with the same URL. The live module path is
  free again, so `git submodule add` and `git submodule update --init` work normally.
- **Reuse the old clone:** move `<name>.removed-<timestamp>` back to
  `<git-dir>/modules/<name>`, restore the gitlink from history, then run
  **Submodules → Update**. Commit87 does not automate this move; use a file manager or a
  terminal.
- **Inspect without re-adding:** open the retained directory as a repository with the
  native picker, or run Git in it. It is a normal repository.

The force option controls whether local changes in the checkout may be discarded during
removal; it does not delete the clone. Purging the retained copies is a separate manual
decision. Nested submodules are not removed individually — remove the outer submodule.

## Interrupted merge, rebase, cherry-pick, revert and am

These are real Git operations with on-disk state. A conflict, a hook failure or an app
crash does not leave a half-finished command that Git cannot resume:

1. Reopen the repository in Commit87. The status bar detects `merging`, `rebasing`,
   `cherry-picking`, `reverting`, `applying` or `bisecting` from the Git directory.
2. **Continue** resumes the operation. For a merge it commits the resolved index; for the
   other operations it runs the matching `--continue`. The commit uses the repository
   identity precedence, not the application default.
3. **Skip** skips the current commit, and is offered for rebase, cherry-pick, revert and
   `git am` (not for merge or bisect).
4. **Abort** runs the matching `--abort` and restores the pre-operation state. For a bisect
   it resets the bisect state.

Every outcome is read from the real exit status and the repository state afterwards. A
conflict is shown as a pause pointing at Continue/Skip/Abort; a failure is reported as a
failure, never as success, and the view refreshes even when the operation only paused.

Resolve conflicts in the conflict editor or in your own editor, then stage the resolution.
The built-in editor is bound to the repository, file, side and content baseline it loaded;
it refuses a save whose file changed underneath it and keeps your bytes, so resolve again
from the new content rather than overwriting silently.

## A crashed or interrupted interactive rebase

The rebase planner writes its scripts, prepared todo and `context.json` under
`<git-dir>/commit87/rebase`; nothing enters the working tree. That directory survives a
conflict stop, an app restart or a crashed window, and is removed by Continue, Skip, Abort
or the next planner run once no rebase is pending.

- Reopen the repository and use Continue/Skip. A later reword still gets the message editor,
  and the comment character chosen for the session is reinstated, so a subject such as
  `#123 fix login` is not stripped as a comment after the restart.
- A missing, foreign or unreadable `context.json` is ignored rather than failing the resume.
  If the scripts are gone, Continue still runs Git's own continuation; a reword that still
  needs the message editor may fail and leave the rebase paused, which you can then Abort.
- To abandon it, use Abort. If something is so broken that Git refuses, use the console or
  a terminal (`git rebase --abort`) after inspecting the repository.

Commit messages and conflict drafts are kept per repository in the app's in-memory store,
so switching views or tabs does not erase them; they are cleared when the commit is made or
the conflict is staged. A reload or quit does not restore them, so commit or copy important
text before closing the window.

## Updates

Supported packaged builds (AppImage, installed NSIS build, macOS app bundle) check for and
download updates automatically by default. Downloading never installs anything: a quit
never swaps the binary. Installation requires **Restart & install** in Settings → Updates,
and the update target is revalidated immediately before download and again before install.

- Turning off **Check for and download updates automatically** leaves a manual check
  stopping at *available* until you press Download.
- Flatpak, Snap, portable and zip copies, and distro packages are not replaced in place;
  the app tells you to update through the package manager or by downloading the next
  release.
- There is no rollback in the app. Keep the previous release artifact if you might need it;
  repositories, identities and settings survive an update.
- A download that is not installed stays cached until the next check or channel change and
  never installs on quit.

## App profile and grants

Both live in the Electron `userData` folder (the app is named `Commit87`):

| Platform | Folder |
| --- | --- |
| Linux | `~/.config/Commit87/` |
| macOS | `~/Library/Application Support/Commit87/` |
| Windows | `%APPDATA%\Commit87\` |

- `config.json` — settings, identities, integrations, repository defaults, recents;
- `secrets.json` — tokens, encrypted with the OS keychain when available, otherwise mode
  `0600`;
- `grants.json` — repository roots, linked-worktree aliases and custom Git executables
  authorized by main.

An unreadable `config.json` is moved aside as `config.json.corrupt-<timestamp>` and the app
starts with defaults instead of overwriting it; the copy is kept so settings can be
recovered by hand. When the profile is read-only, grants still work for the session but are
not persisted. The profile folder also holds recents and can be opened from the app.

Removing an integration deletes its token. Changing an integration's endpoint clears the
token and requires it once more; version 1 tokens from an older profile are dropped on
first load because their destination is unknown. This is deliberate: neither is recoverable
except by entering the token again. See
[getting started](getting-started.md#when-a-token-is-refused).

The previous profile name is copied once at startup when no `Commit87` profile exists, so a
rename does not silently lose identities or integrations; the old folder is left in place.
