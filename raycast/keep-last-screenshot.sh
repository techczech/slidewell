#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Keep Last Screenshot
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 📥
# @raycast.packageName SlideWell
# @raycast.argument1 { "type": "text", "placeholder": "how many (1)", "optional": true }

# Documentation:
# @raycast.description Send the newest screenshot(s) or recording(s) to the SlideWell well — OCR'd and described by your local model, no triage later.

# Where screenshots land, first match wins:
#   1. $SLIDEWELL_SCREENSHOT_DIR
#   2. SlideWell's Triage source folder (Settings → Triage source folder)
#   3. the macOS screenshot location (also where CleanShot saves if you pointed it there)
#   4. ~/Desktop

. "$(dirname "$0")/_slidewell-common.sh"

count="${1:-1}"
case "$count" in '' | *[!0-9]*) count=1 ;; esac
[ "$count" -ge 1 ] || count=1

dir="${SLIDEWELL_SCREENSHOT_DIR:-}"
[ -n "$dir" ] || dir="$(sw_config_get screenshotRoot)"
[ -n "$dir" ] || dir="$(defaults read com.apple.screencapture location 2>/dev/null || true)"
dir="${dir/#\~/$HOME}"
[ -d "$dir" ] || dir="$HOME/Desktop"

inbox="$(sw_inbox)"

# Newest media files first (macOS stat: "%m" = mtime epoch, "%N" = name).
files=$(find "$dir" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' \
  -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.mp4' -o -iname '*.mov' \) -print0 2>/dev/null |
  xargs -0 stat -f '%m %N' 2>/dev/null | sort -rn | head -n "$count" | cut -d' ' -f2-)

if [ -z "$files" ]; then
  echo "No screenshots found in $dir"
  exit 1
fi

kept=0
last=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if sw_drop "$f" "$inbox"; then
    kept=$((kept + 1))
    last="$(basename "$f")"
  fi
done <<< "$files"

if [ "$kept" -eq 1 ]; then
  echo "Kept for SlideWell: $last"
else
  echo "Kept $kept items for SlideWell"
fi
