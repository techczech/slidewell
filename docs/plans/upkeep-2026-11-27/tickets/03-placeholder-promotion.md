# 03 — Follow a staged placeholder into the well

**What to build.** Add one integration test that scans a sparse image, stages it, hydrates it without changing its recorded size or mtime, rescans and imports it. Use the real Triage and well stores with an invented image.

**Defect and evidence.** The three placeholder scan routes prove decision-key retention and the recorded content hash. They stub well ingestion, so they cannot catch a promotion that copies the bytes but loses the retained decision key or its association with the new well copy.

**Feature / journey.** `capture-inbox`. Stage a capture before it downloads and later find the imported copy in the well.

**Design.** Existing Triage ownership and content-identity contracts in presentation-system ADR-0029 and ADR-0026.

**Blocked by.** None.

**Seams under test.** Real scanner, import and well read path with a synthetic source and OCR fixture.

- [ ] Before hydration the capture stays staged and import skips it. After hydration the same decision becomes included and points to the verified stored copy.
- [ ] The original bytes stay present and a second import creates no duplicate.

**Status.** Ready.
