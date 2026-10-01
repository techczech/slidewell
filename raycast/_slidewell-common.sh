#!/bin/bash
# Shared helpers for the SlideWell Raycast script commands (sourced, not run directly).
# Raycast skips files starting with "_" when it lists script commands.

SW_CONFIG="$HOME/Library/Application Support/SlideWell/config.json"

# Read a top-level string from SlideWell's config.json ('' when absent).
sw_config_get() {
  [ -f "$SW_CONFIG" ] || return 0
  /usr/bin/plutil -extract "$1" raw -o - "$SW_CONFIG" 2>/dev/null || true
}

# The well's inbox: SlideWell ingests anything dropped here (live while it runs, else on next launch).
sw_inbox() {
  local well
  well="$(sw_config_get wellRoot)"
  [ -n "$well" ] || well="$HOME/SlideWell/well"
  mkdir -p "$well/_inbox"
  printf '%s\n' "$well/_inbox"
}

# Copy a file into the inbox atomically: write to a dot-file (ignored by SlideWell), then rename.
sw_drop() {
  local src="$1" inbox="$2" base dest n=1
  base="$(basename "$src")"
  dest="$inbox/$base"
  while [ -e "$dest" ]; do
    dest="$inbox/${base%.*}-$n.${base##*.}"
    n=$((n + 1))
  done
  cp -p "$src" "$inbox/.$(basename "$dest").part" && mv "$inbox/.$(basename "$dest").part" "$dest"
}
