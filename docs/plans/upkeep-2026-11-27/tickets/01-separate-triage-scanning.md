# 01 — Separate Triage scanning from decisions and import

**What to build.** Move shared Triage schema and path helpers in one commit. Move source scanning, including its existing serial queue and placeholder reconciliation, in the next. Preserve the existing Triage exports so the watcher, Review and import callers keep their interfaces.

**Defect and evidence.** Triage has over 900 lines. The cloud-placeholder fix added another path through scan matching, file verification and a transactional update. A scan change currently requires reading past unrelated listing, decision, Review and promotion code. The scanner and those callers share one schema.

**Feature / journey.** `capture-inbox`. A staged or excluded capture keeps its decision when it becomes available or its folder moves.

**Design.** Presentation-system ADR-0029. Preserve the existing schema, queue, callback order, event timing and on-disk writes.

**Blocked by.** None.

**Seams under test.** Existing Triage scan, Review and import APIs. Hidden Electron Triage and capture-folder recovery with generated fixtures.

- [ ] The moved functions and types retain their bodies and declarations apart from imports and exports.
- [ ] Both TypeScript projects, build and the complete Studio Vitest suite pass before and after. Repeat the hidden Triage and capture-folder journeys.
- [ ] No existing Air finder file, preload, UI, schema or production behaviour changes.

**Status.** Ready.
