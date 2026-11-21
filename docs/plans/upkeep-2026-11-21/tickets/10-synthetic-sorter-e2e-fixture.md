---
title: Synthetic fixture for SlideWell sorter E2E
register: FOR AGENTS
---

# 10 — Exercise the sorter against made-up screenshots

**What to build.** Give `npm run test:sorter` a reproducible well and Triage fixture with invented screenshot pixels, capture metadata and labels. The current historical training fixture points to real screenshot paths. Generate every source image and store inside the fixture root so the test runs without access to the owner’s inbox or well.

**Feature / journey.** Train the screenshot sorter on labelled examples, then sort undecided screenshots and inspect its proposals.

**Priority.** Low. This is test infrastructure.

**Blocked by.** 05, runnable and isolated end-to-end specs.

**Seams under test.** Fixture generation, the existing sorter E2E spec and its disposable Electron profile. If the spec requires the model, use the approved model cache and report a missing prerequisite explicitly.

- [ ] The fixture has enough independent keep and throwaway groups to exercise training and the held-out checks, plus undecided screenshots for a sort.
- [ ] All referenced source files and databases resolve within the generated fixture. No real screenshot, app title, well, configuration or label enters the fixture.
- [ ] The existing sorter assertions run in hidden Electron through the shared runner, and the spec reports a final `RESULT` line.

**Status.** Planned follow-up.
