#!/bin/bash
# Create Daily Note for Obsidian
# Runs daily at 00:01 via systemd timer
# Creates note in Daily/ folder with DD.MM.YYYY format

set -e

VAULT_PATH="${VAULT_SYNC_STORAGE:-/opt/obsidian-vault}"
DAILY_DIR="$VAULT_PATH/Daily"
TEMPLATE_PATH="$VAULT_PATH/Daily/Templates/Daily note template.md"

# Get today's date in DD.MM.YYYY format
TODAY=$(date '+%d.%m.%Y')
NOTE_PATH="$DAILY_DIR/$TODAY.md"

# Check if note already exists
if [ -f "$NOTE_PATH" ]; then
    echo "Daily note already exists: $NOTE_PATH"
    exit 0
fi

# Ensure Daily directory exists
mkdir -p "$DAILY_DIR"

# Check if template exists
if [ ! -f "$TEMPLATE_PATH" ]; then
    echo "Warning: Template not found at $TEMPLATE_PATH"
    echo "Creating note with basic template..."

    cat > "$NOTE_PATH" << EOF
---
date: $TODAY
processed: false
icon: LiCalendarDays
banner: "[[attachments/banner-rubber-duck.jpg]]"
banner_icon: 📅
banner_header: $TODAY
banner_y: 50.0%
---

# ✨ $TODAY

## MOEX

## Прочее

EOF
else
    # Use template and replace {{date:DD.MM.YYYY}} placeholders
    sed "s/{{date:DD.MM.YYYY}}/$TODAY/g" "$TEMPLATE_PATH" > "$NOTE_PATH"
fi

echo "Created daily note: $NOTE_PATH"
ls -lh "$NOTE_PATH"

exit 0
