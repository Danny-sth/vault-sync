#!/bin/bash
# Git Pull - Pull latest changes from remote
# Usage: ./git-pull.sh

set -e

VAULT_PATH="${VAULT_SYNC_STORAGE:-/opt/obsidian-vault}"

echo "Pulling latest changes in: $VAULT_PATH"
echo ""

cd "$VAULT_PATH"

# Show current branch
BRANCH=$(git branch --show-current)
echo "Branch: $BRANCH"

# Pull with rebase
echo "Pulling..."
git pull --rebase origin "$BRANCH"

echo ""
echo "Pull completed successfully"

exit 0
