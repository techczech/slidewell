# 04 — Refuse an unverified finder download

**What to build.** Extend the existing real-service browser journey to simulate a mismatched digest on a rendition response. Confirm the person sees the failure, no download is offered to the browser and no provenance sidecar appears. Repeat the existing successful download for the same selection.

**Defect and evidence.** The browser confirms the downloaded bytes and provenance on the happy path. It would still do so if the browser’s digest comparison stopped rejecting a mismatched response.

**Feature / journey.** Air finder. Download an original from the host and save its provenance only once the browser has verified the transfer.

**Design.** Use Playwright’s response interception for a single response in the existing synthetic browser journey.

**Blocked by.** None.

**Seams under test.** The browser, the actual finder page and the real local fixture service. Leave all files owned by draft PR 32 outside the diff.

- [ ] The failure is visible, no download is emitted and the sidecar stays hidden.
- [ ] The unchanged positive path still saves the original bytes and a matching provenance sidecar.
- [ ] The journey passes through Studio remote-test.

**Status.** Ready.
