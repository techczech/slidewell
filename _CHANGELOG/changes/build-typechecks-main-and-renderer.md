---
title: Build checks cover the main process and renderer
id: build-typechecks-main-and-renderer
date: 2026-10-17
type: change
status: draft
tags: [build, typescript, verification]
---

# Build checks cover the main process and renderer

The root TypeScript configuration has an empty file list and project references.
Running `tsc --noEmit` against it succeeded without checking either application
project. Build and distribution commands therefore missed application type errors.

The typecheck command now checks the main/preload and renderer configurations
explicitly, with emission and composite output disabled. Build, pack and DMG/ZIP
distribution all use that check. Screenshot ingestion explicitly accepts the
Buffer type returned by Sharp as well as the original file buffer; runtime
behaviour is unchanged.

Validation: both project checks and the production bundle passed. The full suite
passed 1,100 tests with one skipped. Temporary incorrect assignments in each
project were rejected by their respective check and then removed. No dependency,
lockfile, installed application, signing identity or personal archive changed.
