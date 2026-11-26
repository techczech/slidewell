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

## Host configuration after review

The endpoint is a Unix socket in a mode-0700 directory owned by the SlideWell account. Its HTTP content has no direct TCP listener. Use existing owner-authenticated SSH over Tailscale. The SSH command creates a browser-only loopback address on the Air for the duration of the session. The private HTTPS Serve route described in the plan still needs same-user application authorisation and a separately authorised activation.

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
