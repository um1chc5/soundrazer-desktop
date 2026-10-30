# Unweave specifications

Unweave is a local desktop stem separator with a Python backend and vanilla ES-module web UI; it requires no account and collects no telemetry. The specifications below describe the current app and planned work while keeping canonical audio and user projects local.

## Ordered specification and status board

| # | Spec | Status | Summary / what remains |
|---:|---|---|---|
| 01 | [App specification](01-app.md) | Done | Describes current behavior and architecture, implemented project fields, and the current layout after the module refactor. |
| 02 | [Pre-separation trim](02-pre-separation-trim.md) | Done | Overall and guitar-section trim, project-timeline offsets, offset-aware playback, trim editors, and CLI/API support are implemented. |
| 03 | [Output formats](03-output-formats.md) | Done | Export job, six-format FFmpeg matrix, staging, manifest, reveal route, dialog, and progress are implemented. Canonical stored stems are FLAC (lossless, ~40–50% smaller than WAV). |
| 04 | [First-run setup](04-first-run-setup.md) | Doing | In-app checklist, per-stage progress, optional YouTube toggle, and setup gating exist. Installer/bootstrap consent and the full “setup as the main UI” visual merge remain. |
| 05 | [Job queue and concurrency](05-job-queue.md) | Done (Phase 1) | Jobs are enqueued and run one at a time instead of rejected; `/api/state` returns a job list. Phase 2 (configurable concurrency cap) remains optional. |
| 06 | [Close behavior](06-close-behavior.md) | Done (Phase 1) | Confirm-on-close dialog, clean cancel with orphan prevention, and stale-staging-directory sweep at startup. Resume rejected; optional job-state persistence remains. |
| 07 | [Disk usage and cache](07-disk-usage.md) | Done (Phase 1) | Canonical stems switched from WAV to FLAC (~40–50% smaller, lossless); stale-staging-directory sweep at startup. Uninstall model-cache prompt, disk precheck, cleanup UI remain. |
| 08 | [Performance and hidden optimizations](08-performance.md) | Done (Items 1–2) | CPU-derived thread count replaces hardcoded 4 threads in both RoFormer and Demucs/MDX paths; separator writes directly into project staging, eliminating one redundant full stem-set copy per job (~485 MB saved). Remaining: benchmarking, Windows Defender measurement. |
| — | Web module/CSS refactor | Done | ES modules are under `web/js/`; six CSS files are under `web/css/`; static serving uses generic safe handling. |
| — | Python package refactor | Done | Split into `audio/`, `projects/`, and `webui/` is complete; package-layout smoke tests pass. |

### How to read status

The status board is the single source of truth: **Done** means the described behavior/refactor is complete, **Doing** means work is underway with remaining items called out, and **Todo** means specified but not implemented. Individual feature specs include implementation checklists; those checklists do not override this board.

## Read in order

1. [01 — App specification](01-app.md)
2. [02 — Pre-separation trim](02-pre-separation-trim.md)
3. [03 — Output formats](03-output-formats.md)
4. [04 — First-run setup](04-first-run-setup.md)
5. [05 — Job queue and concurrency](05-job-queue.md)
6. [06 — Close behavior](06-close-behavior.md)
7. [07 — Disk usage and cache](07-disk-usage.md)
8. [08 — Performance and hidden optimizations](08-performance.md)

See the [docs index](../README.md) for architecture, project overview, and desktop packaging documentation.
