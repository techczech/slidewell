# 04 — config.json is written safely and an unreadable one is never overwritten

**What to build:** Every write of `userData/config.json` goes through one function that writes a temp file in the same folder, fsyncs and renames it over the old one. If the current `config.json` exists but cannot be parsed, SlideWell does not write over it: it copies it aside once as `config.json.unreadable-<timestamp>`, logs one line, and says in Settings that its saved state could not be read.

**Defect and evidence:** `src/main/index.ts`: `rawConfig()` returns `{}` when `JSON.parse` fails; `writeRawConfig(patch)` and `writeConfig` then write `{...rawConfig(), ...patch}` with a plain `writeFileSync(configPath(), …)` (truncate then write). `config.json` holds the safeStorage ciphertext of the OpenAI, Anthropic and R2 keys, the recorded agreements to send screenshots (`optedInAt`, `anthropicOptedInAt`), the sorter's learning and last-run state, capture sources and folder roots, and it is written often (sorter runs, learning, period, capture sources, window bounds on close). One torn write — power loss, a kill during quit, two processes (the app and `npm run settings` CLI migration) — leaves invalid JSON; the next write of any single field then replaces the whole file with that field alone, silently dropping keys, agreements and folder settings. `src/main/settings-migration.ts` already uses temp-and-rename for its own writes; `config.json` itself does not.

**Feature / journey:** Settings (keys as connected/missing slots, cloud agreement), Triage capture sources, sorter state.
**Design:** none; the shared settings store (`@app-patterns/settings`) is not changed.
**Blocked by:** 01.
**Seams under test:** the extracted config-file module (read, write, patch) with a temp folder.

**Real-path test that proves it:** unit test on the extracted module: (a) a write is all-or-nothing — kill simulated by making rename fail leaves the old file byte-identical and no temp; (b) with an invalid `config.json`, `patch({windowBounds})` refuses, the invalid file is preserved byte-for-byte and copied aside once; (c) a valid file patched keeps every other field, including `r2` ciphertext fields. Then `npm run test:settings` once through `agent-run`.

- [ ] One module owns reading and writing `config.json`; `index.ts` calls it.
- [ ] No code path writes `config.json` after failing to parse it.
- [ ] The CLI migration and the app never interleave a partial file (rename is the only way the file changes).
- [ ] Settings shows a plain sentence when saved state could not be read.

**May touch:** `src/main/index.ts` (config functions only), a new `src/main/config-file.ts`, `src/main/settings-migration.ts` only to call the shared write, tests.
**Must not touch:** the settings store package, key-store encryption, consent rules in `src/main/sorter/cloud/`.
**Boundary:** write path (keys, consent records) → **Opus review**.
**Status:** ready
