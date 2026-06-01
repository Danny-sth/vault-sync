#!/bin/bash
# Git Status - Check vault git status
# Usage: ./git-status.sh

set -e

VAULT_PATH="${VAULT_SYNC_STORAGE:-/opt/obsidian-vault}"

echo "Checking git status in: $VAULT_PATH"
echo ""

cd "$VAULT_PATH"

# Show current branch
echo "Branch:"
git branch --show-current

echo ""
echo "Status:"
git status --short

echo ""
echo "Recent commits:"
git log --oneline -5

exit 0
