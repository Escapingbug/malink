#!/bin/sh
set -eu

DIST_ROOT="${1:-}"
PAGES_WORKTREE="${2:-}"

if [ -z "$DIST_ROOT" ] || [ -z "$PAGES_WORKTREE" ]; then
    echo "Usage: stage-github-pages.sh <official-dist-root> <gh-pages-worktree>" >&2
    exit 1
fi

for required_file in index.html 404.html version.json sw.js; do
    if [ ! -f "$DIST_ROOT/$required_file" ]; then
        echo "Official PWA build is missing $required_file." >&2
        exit 1
    fi
done
if [ ! -d "$DIST_ROOT/assets" ]; then
    echo "Official PWA build is missing its assets directory." >&2
    exit 1
fi
if [ ! -d "$PAGES_WORKTREE/.git" ] && [ ! -f "$PAGES_WORKTREE/.git" ]; then
    echo "GitHub Pages target is not a git worktree." >&2
    exit 1
fi
if [ "$(git -C "$PAGES_WORKTREE" branch --show-current)" != "gh-pages" ]; then
    echo "GitHub Pages target must have the gh-pages branch checked out." >&2
    exit 1
fi
if [ -n "$(git -C "$PAGES_WORKTREE" status --porcelain)" ]; then
    echo "GitHub Pages target has uncommitted changes." >&2
    exit 1
fi

# Mutable shell files follow the new build. Immutable update trees and every
# content-hashed asset already published remain available to cached clients.
rsync -a --delete \
    --exclude='.git' \
    --exclude='assets/' \
    --exclude='gateway-agent-updates/' \
    --exclude='native-updates/' \
    "$DIST_ROOT/" "$PAGES_WORKTREE/"
mkdir -p "$PAGES_WORKTREE/assets"
rsync -a "$DIST_ROOT/assets/" "$PAGES_WORKTREE/assets/"

echo "Staged the Official PWA without deleting previously published hashed assets."
