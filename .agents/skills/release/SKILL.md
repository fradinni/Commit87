---
name: release
description: >-
  Publish a Commit87 release (patch, minor or -beta.N) and drive it to green: bump the
  version through scripts/sync-version.mjs, write the CHANGELOG section, tag, watch the
  Release workflow, triage failing jobs, fix, repoint the tag and re-run, then verify and
  promote the release. Use when asked to publish/cut/ship a release or beta, repoint a
  release tag, or check why a release build failed.
---

# Commit87 release

One version source (`package.json`), one resolver (`scripts/sync-version.mjs`), one tag
workflow (`.github/workflows/release.yml`). Everything below follows from that: never type a
version into a second file, never derive channel/draft flags by hand, never publish before
`publish` verified the assembled artifacts.

## 0. Read the current state first

```bash
git status --short --branch                 # must be clean and level with origin/main
git log --oneline -5
git tag --list 'v*' --sort=-v:refname | head -5
gh release list --limit 5                   # what is already published / drafted
gh run list --limit 5                       # is a Release run already in flight?
```

The Release workflow serializes on `concurrency: group: release`, `cancel-in-progress: false`.
A stale queued/cancelled run therefore delays yours — check before assuming a hang.

Known trap: a "cancelled" job from an earlier run (e.g. `macOS packages`) looks like a failure
in `gh run list`. Confirm with `gh run view <id> --json jobs`.

## 1. Pick the version — and confirm the channel

**Ask which channel is wanted before bumping.** "Release" is ambiguous, and the two channels
are not interchangeable: a patch on the current line and a new beta cycle differ in the version
number, the update feed and whether the release publishes itself. Guessing wrong once already
cost a cancelled run, a deleted draft, a force-pushed `main` and a re-tag.

- **Patch** on the current line: `0.2.0` → `0.2.1`. Stable channel (`latest*`), created as a
  **draft** until a maintainer promotes it. This is the answer for "ship the fix we just
  landed".
- **New cycle beta**: `0.3.0-beta.1`, then `.2`, `.3`… Only `x.y.z` and `x.y.z-beta.N` are
  accepted; `-rc.1`/`-alpha.1` fail in `prepare` before anything is built. Publishes itself as
  a pre-release. This is the answer for "start the next cycle early", not for a single fix.

The channel is derived from the version alone: stable → `latest.yml`, `latest-linux.yml`,
`latest-linux-arm64.yml`, `latest-mac.yml` and a draft; `-beta.N` → the four `beta*` files and
an immediate pre-release. Clients read the feed matching their Settings → Updates channel, so
a beta built to satisfy a bug report is invisible to Stable users.

If the wrong channel was already cut, undo it completely before cutting the right one:
cancel the runs (`gh run cancel <id>`), `gh release delete v<wrong> --yes`, delete the remote
and local tag, `git reset --hard <previous commit>`, then force-push with a lease
(`git push --force-with-lease=main:<wrong commit> origin main`). Check `gh release list`,
`git ls-remote --tags origin 'v<wrong>'` and `git status` show nothing left of it — the Release
workflow refuses a tag that points at another commit, so a leftover tag blocks the re-cut.

## 2. Bump, changelog, commit, tag

```bash
node scripts/sync-version.mjs 0.2.1        # rewrites package.json, package-lock.json,
                                            # src/main/version.ts, snap/snapcraft.yaml and
                                            # the Flatpak metainfo release entry
git diff --stat                             # expect exactly those five files
```

Add the CHANGELOG section **at the top**, directly under `## [Unreleased]`, with the version
as the heading:

```markdown
## [0.2.1] — 2026-11-13
```

The release body is extracted from `CHANGELOG.md` by matching the literal `## [<version>]`
prefix up to the next `## [`, so a typo there ships the fallback text ("See CHANGELOG.md…").
Use `### Added` / `### Changed` / `### Fixed` and write user-facing sentences, not commit
subjects.

Gates before pushing (the release re-runs tests on every platform anyway):

```bash
node scripts/sync-version.mjs --resolve --tag v0.2.1   # expect version/tag/channel/prerelease
npm run typecheck && npm test
```

Then:

```bash
git add -A && git commit -m "chore(release): 0.2.1"
git push origin main
git tag -a v0.2.1 -m "Commit87 0.2.1" && git push origin v0.2.1
```

Annotated tags, same message shape as previous releases. Push `main` before the tag so the
commit exists on the branch when the release is created.

## 3. Watch the run

Never assume a trigger worked; resolve the run id from the tag push:

```bash
gh run list --workflow=Release --limit 3
gh run view <id> --json status,conclusion,jobs \
  --jq '.jobs[] | "\(.name): \(.status)/\(.conclusion)"'
```

Stages and what they mean:

| Job | Green means |
| --- | --- |
| `Resolve release and prepare draft` | tag matches the checked-out SHA and `package.json`; draft created |
| `Build linux/win/mac (x64+arm64)` | both architectures packaged in one invocation, metadata written, signing status recorded |
| `Verify and publish` | metadata/architecture/artifact checks passed, assets uploaded, flags applied |

A full run is ~9–15 minutes. Poll every ~30–60 s; `gh run watch --exit-status` blocks longer
than most tool timeouts.

## 4. Triage a red run

```bash
gh run view <id> --log-failed                       # only the failing steps
gh run view <job-id> --log | tail -80               # one job, full log
gh api repos/fradinni/Commit87/actions/runs/<id>/jobs \
  --jq '.jobs[] | select(.conclusion=="failure") | .name'
```

Map the failing step to the cause:

- **prepare: "Tag … already points at … not at this run's commit"** — the tag is stale; go to
  §5. The workflow deliberately refuses to attach assets to another commit.
- **prepare: "version does not match" / "Unsupported prerelease"** — `package.json` and the
  tag disagree, or the suffix is not `-beta.N`.
- **prepare: "release … is already published"** — a published release is never overwritten;
  bump the version instead of reusing it.
- **build: npm/typecheck/test failure** — a real code regression; fix on `main`, then §5.
- **build: apt mirror / Electron download 5xx** — retry the same tag by re-running the job
  (`gh run rerun <id> --failed`) before touching the tag.
- **build: macOS `codesign`/Gatekeeper check** — the app bundle is not validly signed; check
  `SIGNING-STATUS-mac.txt` and the `MAC_CERT_P12`/`APPLE_*` secrets. Without a certificate the
  job only requires a valid ad-hoc signature.
- **publish: missing metadata / artifact / empty file / architecture mismatch** — one platform
  leg uploaded an incomplete payload; read which file the `fail "…"` line names, then fix the
  build (or `package.json` of that platform) and §5.

Fix code in a normal commit first (`fix(…): …`), push `main`, and let CI confirm before
re-cutting the release.

## 5. Repoint the release tag

The tag is immutable for the workflow: `prepare` compares the tag commit to `$GITHUB_SHA`.
To move it, remove the draft and the tag, then re-create both on the fixed commit.

```bash
git log --oneline -3                        # confirm the fix is committed and pushed
gh release delete v0.2.1 --yes              # remove the draft (assets included)
git push origin :refs/tags/v0.2.1           # delete the remote tag
git tag -d v0.2.1                           # delete the local tag
git tag -a v0.2.1 -m "Commit87 0.2.1"       # re-create on the current HEAD
git push origin v0.2.1
```

Notes:

- `gh release delete` without `--cleanup-tag` leaves the tag; both steps are needed.
- Re-create the release by pushing the tag, *not* with `gh release create` — `prepare` owns
  creation, notes, and asset cleanup.
- If the fix commit already landed, re-tagging the same version is correct for a patch/beta.
  Do not bump the version for an infrastructure retry.
- The Release workflow's `concurrency: group: release` does not cancel an in-flight run, so a
  cancelled run that is still tearing down can hold the queue for a minute; wait for it to
  reach `completed` before pushing the re-cut tag.

## 6. Exit criteria (check, don't assume)

```bash
gh run view <id> --json conclusion,jobs --jq '{conclusion, jobs:[.jobs[]|"\(.name): \(.status)/\(.conclusion)"]}'
gh release view v0.2.1 --json isDraft,isPrerelease,tagName,assets \
  --jq '{isDraft,isPrerelease,tagName,assets:(.assets|map(.name)|sort)}'
gh release view v0.2.1 --json body --jq .body | head -20      # notes came from CHANGELOG
git rev-list -n1 v0.2.1; gh release view v0.2.1 --json targetCommitish
```

Expected asset set for a stable/beta build: `*.AppImage` ×2 (x64+arm64), `*.deb` ×2,
`*.rpm` ×2, `*.pkg.tar.xz` ×2, `*.tar.gz` ×2, `*.exe` ×4, `*.dmg` ×2, the four zips
(`-win-x64/arm64`, `-mac-x64/arm64`), `*.blockmap`, `latest.yml` **or** `beta.yml`, the
three Linux/macOS feeds for the channel, `SHA256SUMS.txt`, `BUILD-INFO.txt`,
`SIGNING-STATUS.txt`, `install-macos.sh`.

```bash
gh release download v0.2.1 --pattern 'latest-linux.yml' --output -   # version: 0.2.1
gh release download v0.2.1 --pattern 'BUILD-INFO.txt' --output -     # source commit = tag commit
```

Stable releases stay **drafts** by design. Publishing one is a separate, explicit act:

```bash
gh release edit v0.2.1 --draft=false
```

Beta (`-beta.N`) releases need nothing: the workflow publishes them as pre-releases.

`gh release download` resolves the repository from the working directory, so run it from the
checkout or pass `-R fradinni/Commit87`.

A green `v0.2.1` run took about 9 minutes end to end: `prepare` under a minute, the three
platform builds finishing within 2 minutes of each other, `publish` the last silent stage
before the flags are applied. Anything still `in_progress` after ~15 minutes is worth a look at
the job log, not at the clock.

## 7. Keep the tree honest

The version bump, `CHANGELOG.md`, and any doc line that names a version (e.g.
`docs/testing.md`'s "for example 0.3.0 from 0.2.0") belong in the same release commit. If a
release changed user-facing behaviour, `README.md`/`docs/` must describe it before the tag,
not after.

## Quick reference

```bash
node scripts/sync-version.mjs <version>            # bump every version file
node scripts/sync-version.mjs --resolve --tag v<version>   # what the workflow will do
gh run list --workflow=Release --limit 3
gh run view <id> --json jobs --jq '.jobs[]|"\(.name): \(.status)/\(.conclusion)"'
gh run view <id> --log-failed
gh run rerun <id> --failed                         # transient infra retry, same tag
gh release delete v<version> --yes; git push origin :refs/tags/v<version>; git tag -d v<version>
gh release edit v<version> --draft=false           # publish a stable draft
```