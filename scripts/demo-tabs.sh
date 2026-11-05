#!/usr/bin/env bash
# Seeds throwaway repositories for manually exercising multiple repository tabs.
# Usage: bash scripts/demo-tabs.sh [target-dir]
set -euo pipefail

root="${1:-/tmp/commit87-tabs}"
if [[ "$root" == *..* ]]; then
  echo "Refusing a path containing '..': $root" >&2
  exit 1
fi
root="$(realpath -m -- "$root")"
case "$root" in
  /tmp/*|/var/tmp/*|/private/tmp/*) ;;
  *)
    echo "Refusing to delete outside a temporary directory: $root" >&2
    echo "Usage: bash scripts/demo-tabs.sh [/tmp/your-demo-root]" >&2
    exit 1
    ;;
esac
if [[ "$root" == "/tmp" || "$root" == "/var/tmp" || "$root" == "/private/tmp" ]]; then
  echo "Refusing to use the temporary directory root itself: $root" >&2
  exit 1
fi
export GIT_AUTHOR_NAME="Ada Lovelace"
export GIT_AUTHOR_EMAIL="ada@example.com"
export GIT_COMMITTER_NAME="Ada Lovelace"
export GIT_COMMITTER_EMAIL="ada@example.com"

rm -rf -- "$root"
mkdir -p "$root"

seed() {
  local name="$1" branch="$2"
  local dir="$root/$name"
  git init -q -b "$branch" "$dir"
  printf '# %s\n' "$name" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -qm "chore: initial commit"
  for step in 1 2 3; do
    printf 'step %s\n' "$step" >> "$dir/README.md"
    git -C "$dir" add README.md
    git -C "$dir" commit -qm "docs: step $step"
  done
  git -C "$dir" checkout -q -b "feat/next"
  printf 'feature\n' > "$dir/feature.txt"
  git -C "$dir" add feature.txt
  git -C "$dir" commit -qm "feat: next thing"
  git -C "$dir" checkout -q "$branch"
  printf 'uncommitted\n' >> "$dir/README.md"
}

seed alpha main
seed beta develop
seed gamma trunk

git -C "$root/alpha" worktree add -q "$root/alpha-worktree" feat/next

cat <<EOF
Seeded repositories under $root

  $root/alpha            main (one uncommitted change)
  $root/beta             develop
  $root/gamma            trunk
  $root/alpha-worktree   linked worktree on feat/next

Open them in separate tabs:

  npm run dev
  # then press Ctrl/Cmd+O three times and pick alpha, beta and gamma

Or start a built app with one repository and hand the others to it:

  npm run build
  ./node_modules/.bin/electron out/main/index.js "$root/alpha"
  ./node_modules/.bin/electron out/main/index.js "$root/beta"
  ./node_modules/.bin/electron out/main/index.js "$root/gamma"
EOF