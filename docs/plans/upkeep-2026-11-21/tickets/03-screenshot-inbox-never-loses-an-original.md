# 03 — A half-written well copy can no longer cause the inbox original to be removed

**What to build:** Adding a screenshot or video to the well writes the stored copy to a temp file beside it, fsyncs, then renames it into place. An existing file at the destination counts as "already in the well" only if its content hashes to the id in its name; a damaged one is replaced. The inbox drain removes an inbox file only after the stored copy has been verified this way.

**Defect and evidence:** `src/main/well.ts` `ingestScreenshot`: `const created = !existsSync(dest)` then `writeFileSync(dest, buf)` straight to the final name. If that write fails part-way (disk full, app killed, Mac sleeps on battery) a truncated file stays at `dest` and the error goes to `drainInbox`, which leaves the inbox file for the next pass. On the next pass `existsSync(dest)` is true, so `created` is false, the row is upserted and `drainInbox` runs `rmSync(p, {force: true})` on the inbox original. The well then holds a truncated picture and the only complete copy is gone. `ingestVideo` has the same shape with `copyFileSync(srcPath, dest)`. The id in the file name is the first seven hex digits of the SHA-256 of the stored bytes, so the check is cheap and exact.

**Feature / journey:** "New screenshots reach Triage by themselves" and paste/drag into the well (`_DTC/slidewell/releases/0.4.0.md` `#capture-inbox`).
**Design:** ADR-0026 self-describing files `{slug}--{hash}.ext` (presentation-system); file names do not change.
**Blocked by:** 01.
**Seams under test:** `ingestScreenshot`, `ingestVideo` and `drainInbox` in `src/main/well.ts` with a temp well folder (sharp and OCR may be stubbed the way existing well tests do; check `test/` for the pattern before adding one).

**Real-path test that proves it:** in a temp well: put a truncated file at the destination name a screenshot would get, put the screenshot in `_inbox`, run `drainInbox`: the destination now hashes to its id, the inbox file is gone only after that. Second case: make the write fail (read-only `images/` folder): the inbox file remains and no partial file is left at the destination name. Same two cases for a video.

- [ ] No write to a final well name except by rename from a temp file in the same folder.
- [ ] A destination whose bytes do not hash to its id is never treated as present.
- [ ] Inbox originals are removed only after a verified stored copy exists.
- [ ] Temp files left by a crash are cleaned on the next drain (older than a minute).

**May touch:** `src/main/well.ts`, a new test file.
**Must not touch:** file naming, the `well.db` schema, Triage decision writes, Review.
**Boundary:** write path (the only copy of pasted or captured pictures) → **Opus review**.
**Status:** ready
