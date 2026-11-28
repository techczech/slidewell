#!/bin/sh
# SlideWell Air finder, MacBook Pro side. Starts the installed SlideWell with the finder on,
# using the private settings file ~/.slidewell-finder/finder.json (mode 0600, folder 0700).
CONFIG="$HOME/.slidewell-finder/finder.json"
if pgrep -f '/Applications/SlideWell.app/Contents/MacOS/SlideWell' >/dev/null; then
  echo "SlideWell is already running. Quit it (SlideWell › Quit), then open this again."
  printf 'Press Return to close.'; read -r _; exit 1
fi
open -a /Applications/SlideWell.app --args "--air-finder-config=$CONFIG"
echo "SlideWell is starting with the Air finder on. On the Air, open 'SlideWell Air finder'."
sleep 2
