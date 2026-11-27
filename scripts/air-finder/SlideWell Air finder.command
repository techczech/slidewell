#!/bin/sh
# SlideWell Air finder, Air side (runbook: docs/plans/cross-machine-discovery-2026-11/runbook-air-finder.md).
# Opens a loopback port on this Mac that SSH forwards to the finder's private socket on the
# MacBook Pro over Tailscale, then opens the finder in the browser. Close this window to stop.
PORT=8870
SOCKET="$HOME/.slidewell-finder/finder.sock"  # same account home on the Air and the Pro
HOST=macbook-pro

if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "Something on this Mac already uses port $PORT. If it is an earlier finder window, close that one first."
  printf 'Press Return to close.'; read -r _; exit 1
fi
echo "Connecting to SlideWell on the MacBook Pro…"
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ConnectTimeout=10 \
  -L "127.0.0.1:$PORT:$SOCKET" "$HOST" &
pid=$!
trap 'kill "$pid" 2>/dev/null' EXIT INT TERM HUP
i=0
until nc -z 127.0.0.1 "$PORT" 2>/dev/null; do
  if ! kill -0 "$pid" 2>/dev/null || [ "$i" -ge 40 ]; then
    echo "Could not reach the MacBook Pro. Check that it is awake and on Tailscale."
    printf 'Press Return to close.'; read -r _; exit 1
  fi
  i=$((i + 1)); sleep 0.5
done
open "http://127.0.0.1:$PORT/"
echo "The finder is open in your browser at http://127.0.0.1:$PORT/"
echo "If the page says it cannot connect, SlideWell on the MacBook Pro is not running with the finder on."
echo "Close this window when you are done; that ends the connection."
wait "$pid"
