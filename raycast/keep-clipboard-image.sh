#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Keep Clipboard Image
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 📋
# @raycast.packageName SlideWell

# Documentation:
# @raycast.description Send the image on the clipboard (e.g. CleanShot's "Copy") to the SlideWell well.

. "$(dirname "$0")/_slidewell-common.sh"

inbox="$(sw_inbox)"
name="clipboard-$(date +%Y-%m-%d-%H%M%S).png"
part="$inbox/.$name.part"

if ! osascript \
  -e 'set png to the clipboard as «class PNGf»' \
  -e "set f to open for access POSIX file \"$part\" with write permission" \
  -e 'set eof f to 0' \
  -e 'write png to f' \
  -e 'close access f' >/dev/null 2>&1; then
  rm -f "$part"
  echo "No image on the clipboard"
  exit 1
fi

mv "$part" "$inbox/$name"
echo "Kept clipboard image for SlideWell"
