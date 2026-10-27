# 06 — Close behavior and interrupted jobs

Status: Todo

What this covers: what happens when the window is closed while a job runs, why the
result is currently lost, and the planned warning + cleanup. Includes an explicit
decision *not* to implement resume.

## Current behavior (bug)

Closing the window **silently destroys the running job** and leaves debris.

1. **Nothing cancels or waits on close.** There is no `on_closing` / `on_closed`
   handler anywhere. `webview.start()` returns, `main()` falls off the end, and the
   process exits. Both the server thread and the job worker thread are
   `daemon=True`, so they are killed immediately.
2. **The child survives briefly, then freezes.** The job runs as
   `subprocess.Popen(..., start_new_session=True)`, so it is in its own process group
   and survives the parent's death. But the parent reads its output via
   `for line in process.stdout`. When the window closes that reader dies; once the
   pipe buffer fills (~64 KB) the child blocks forever on `write()`.
3. **The result is discarded even if it finished.** Stems are written to a temporary
   directory and only promoted to `stems/` by code that runs *after* `process.wait()`,
   inside the already-dead worker thread.

**Reproduced** by mirroring the exact shape (daemon worker thread,
`start_new_session=True`, stdout to a pipe):

```
--- status right after parent exit ---  alive at step 19
--- is the child still alive? ---      CHILD ALIVE
--- status 5s later ---                alive at step 19   <- frozen on the write
```

The child freezes at the pipe, exactly as predicted.

**Job state is in-memory only** — `self.job` is never persisted to disk. On restart
there is no record the job existed; it vanishes without any message.

### Observable consequence

An interrupted run leaves an orphaned staging directory inside the project:

```
~/Music/SoundRazer Desktop/Landscape (...)/.separation-mq5d5qc3/
```

Found on a real machine (Oct 26), containing an empty `stems/`. Note the project's
real `stems/` directory is timestamped 16 minutes later, so the run was repeated
afterwards. These directories are **never cleaned up**.

## Decision: warn on close — do not implement resume

**Chosen: warn the user and cancel cleanly.** Resume was considered and rejected.

Why not resume:

- `apply_model` **does** process in segments (`segment`, `offset`, `TensorChunk`,
  chunking with overlaps), so partial-work machinery exists — but it is internal to
  the model call and exposes no checkpoint.
- Implementing resume means persisting intermediate stem tensors, tracking segment
  offsets, and restoring them — a new feature *inside a third-party library's
  inference loop*, not something the app can bolt on.
- **It barely helps the common case.** Closing 10 minutes into a 12-minute run loses
  10 minutes; resuming saves ~2. The real fix is preventing the loss, not recovering
  it.

## Planned change

In priority order. Items 1–3 are the whole fix; item 4 is optional polish.

1. **Warn before closing while a job runs** — "A split is running. Closing will
   cancel it." Block the close until the user confirms.
2. **Cancel cleanly on close** — reuse the existing `cancel()` path (`os.killpg` with
   `SIGTERM`, escalating to `SIGKILL` after a 5 s timeout on POSIX; `terminate()` /
   `kill()` on Windows) so no orphaned child is left frozen on a dead pipe.
3. **Sweep stale staging directories on startup** — remove `.separation-*`,
   `.youtube-*`, `.import-*`, `.exports-*`, `.guitar-split-*`, `.stems-*`, and
   `.model-download-*` directories older than a threshold (e.g. 24 h) inside the
   projects root. Only ever remove directories matching these prefixes, and never
   follow symlinks.
4. **Optional:** persist minimal job state (id, project, status, started) so an
   interrupted job can be reported on next launch ("Your last split was interrupted").

## Remaining work

- [ ] Add the confirm-on-close dialog (pywebview `on_closing`), gated on
      `library.running()`.
- [ ] Call `library.cancel()` from the close path and wait for the worker to exit
      (bounded timeout) before destroying the window.
- [ ] Implement the stale-staging-directory sweep at startup; log what it removes.
- [ ] Verify no orphaned child process survives a close during an active separation.
- [ ] Decide whether queued-but-not-started jobs (see
      [05 — Job queue](05-job-queue.md)) are cancelled or retained on close.
- [ ] Optional: persist and surface an "interrupted last run" notice.

## Constraints

- Do not remove the staging directories on *every* exit; only sweep ones that are
  stale, so a crash during a legitimate run is still diagnosable.
- The sweep must be conservative: match known prefixes only, skip symlinks, and never
  delete anything outside the projects root.
- Keep the existing `cancel()` semantics; it is the only reliable way to kill the
  child process group.

## Related

- [05 — Job queue](05-job-queue.md) — what happens to queued jobs on close.
- [01 — App specification](01-app.md) — job lifecycle and staging directories.
- [07 — Disk usage and cache](07-disk-usage.md) — the full inventory of what the app
  writes.
