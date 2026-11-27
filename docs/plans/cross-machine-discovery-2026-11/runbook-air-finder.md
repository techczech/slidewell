---
title: Air finder host and test runbook
register: FOR AGENTS
status: draft implementation
---

The Air uses its browser. The Pro runs one source build of SlideWell with an opt-in finder endpoint and an explicit allowlist of personal presentation IDs and added-image IDs. The finder opens the existing registries read-only. The same SlideWell process handles Meaning and More like this over its open picture index. The Air keeps only the selected downloads and their provenance files.

## Try with invented data

Run from the worktree with the project dependencies installed. The Electron test launches the hidden source build with a disposable home and profile. Give it a fresh mode-0700 temporary directory.

```sh
SLIDEWELL_FINDER_SCRATCH="$(mktemp -d /tmp/swf.XXXXXX)" npm run test:air-finder
```

With the existing personal Air SSH route available, add `SLIDEWELL_FINDER_TEST_AIR=1` to the command. The test holds a temporary reverse loopback forward for one Air-side HTTP check and reports query time, first preview time and bytes. It uses the existing SSH configuration and stops forwarding when that command exits.

## Run the headless browser journey on the Studio

Push the branch being tested, then run from its worktree on the laptop. This journey uses the invented HTTP fixture on loopback. It exercises search, preview, similarity, download, provenance, narrow layout and offline handling in Playwright Chromium.

Before dispatch, check that the Chromium, Chromium Headless Shell and FFmpeg revisions for the lockfile's Playwright version are staged in the Studio's `~/.local/state/agent-run/remote/cache/ms-playwright` or `~/actions-runner/_shared/ms-playwright` cache. Each revision directory needs an `INSTALLATION_COMPLETE` marker. The Studio runner can try to download missing browsers before it runs the test. If the revisions are missing, run `npm run test:air-finder-dom` on the laptop through `agent-run` with its existing Playwright browser and a short `TMPDIR`.

```sh
~/gitrepos/_MACHINECONFIG/agent-run/remote-test "$(git rev-parse --show-toplevel)" --timeout 1800 -- sh -c '
  TMPDIR="$(mktemp -d /tmp/swt.XXXXXX)" || exit 1
  export TMPDIR
  npm run test:air-finder-dom
  status=$?
  rm -rf "$TMPDIR"
  exit "$status"
'
```

`npm run test:air-finder-dom` sets `SLIDEWELL_FINDER_DOM=1`. Check the output for `test/air-finder-dom.test.ts` with one passed test. A skipped test leaves the browser journey unverified.

## Host configuration after review

SlideWell listens on a Unix socket in a mode-0700 directory owned by the SlideWell account. It has no TCP listener on the Pro. Use existing owner-authenticated SSH over Tailscale. SSH authenticates the connection to the Pro and opens a loopback port on the Air for the duration of that session.

While that port is open, any process on the Air can reach the finder through it, including processes running under other local accounts. The finder does not ask for an application token or identify the browser user. Its HTTP header checks enforce the expected loopback host and browser origin. Use the forward only while you are comfortable giving local processes on the Air access to the allowlisted items, and close the SSH session when you finish. The private HTTPS Serve route described in the plan still needs same-user application authorisation and a separately authorised activation.

On the Pro, prepare a mode-0600 JSON file using this shape. The IDs below are invented. Use the app's configured archive and well roots. List only individually approved personal IDs. The well's source-identity backfill and review database must be readable before it exposes any well image.

```json
{
  "libraryId": "personal-library",
  "socketPath": "/tmp/swf.EXAMPLE/finder.sock",
  "browserPort": 8870,
  "presentations": ["fixture-deck-1"],
  "wellImages": ["a10000000001"],
  "meaningVerified": false
}
```

Launch the reviewed source build with `--air-finder-config=/absolute/path/to/private-config.json`. Use `meaningVerified: true` only after checking source/runtime parity, model readiness and known matches against the approved library. A running build with a changed archive or well root refuses further data requests until it is restarted.

On the Air, using the existing SSH alias for the Pro and the chosen socket path:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8870:/tmp/swf.EXAMPLE/finder.sock macbook-pro
```

Open `http://127.0.0.1:8870/`. Select Words or Meaning, search, then select a result to inspect its source. More like this uses the selected item's stored vector. Download saves the full-size raster rendition once verified. Save provenance saves the source identity, revision, catalogue generation and SHA-256 as a JSON sidecar with the same name. A stopped host or stopped SSH session ends full-library search. Refresh the search if a result expires.

## Boundaries

Only slide renders and SlideWell-owned screenshot images from the allowlist are eligible. The finder omits vault assets, other libraries, and triage items. It checks review state and the rendition revision again when serving bytes. Preview images are 480 px at most. Full-size transfers are capped at 20 MiB and limited to PNG, JPEG and WebP. Cache packs, TalkWeaver insertion, Cloudflare and the live Serve route remain later work.
