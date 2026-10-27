# 05 — Job queue and concurrency

Status: Todo

What this covers: why only one job runs at a time, what the real limit is, and the
planned change from *rejecting* concurrent requests to *queueing* them (with an
optional, configurable concurrency cap).

## Current behavior

Exactly one job exists at a time. Every entry point opens with the same guard and
**rejects** a second request outright — it is not queued:

```python
if self.running() or self.worker is not None and self.worker.is_alive():
    raise ValueError("Another download or separation is already running.")
```

That guard appears in four places in [`webui/library.py`](../../app/sound_razor/webui/library.py):
`start()` (separation), `import_youtube()`, `start_setup()`, and `start_export()`.

The limit is a consequence of the data model, not a resource check. `Library` holds
three **scalars** — `self.job`, `self.process`, `self.worker` — plus one shared
`self.logs` deque. `/api/state` returns `"job": job`, a single object, and the
frontend reads `store.state.job` in six places (`progress.js`, `library.js`,
`new.js`, `setup.js`, `song.js`, and the setup view).

There is **no** hardware detection anywhere: no `cpu_count`, no memory probe, no
`Semaphore`, no `Queue`, no `max_workers`, no `concurrent.futures`. The only
threading-adjacent calls are `torch.set_num_threads(4)` inside guitar split (bounding
*one* job's own threads) and `torch.cuda.is_available()` (device selection).

## Why the limit exists (and is defensible)

Each job shells out to a **fresh `sound_razor` subprocess**, so per-process costs are
paid per job. Measured import cost on a clean interpreter:

| Stage | Cumulative RSS |
|---|---:|
| baseline Python | 10 MB |
| + `numpy` | 26 MB |
| + `torch` (import only) | 501 MB |
| + `audio_separator` import | **589 MB** |

On top of that: `htdemucs_6s` weights (~55 MB) plus activation memory that scales
with audio length — realistically **1.5–2.5 GB resident per job**.

- **RAM is the binding constraint, not CPU.** On a 12-core / 31 GB machine, 3–4 jobs
  fit. On the 8 GB Windows target in the README, **2 is already risky**.
- **CPU argues the same way.** A Demucs run already saturates the cores, so parallel
  jobs split the same throughput — both finish later and both ETAs become wrong.
- **GPU changes the answer.** A 12 GB card can genuinely run 2–3 concurrently, which
  is why the cap should be configurable rather than hardcoded.

## Planned change

Two phases. Phase 1 alone removes most of the friction and keeps the resource profile
identical.

### Phase 1 — Queue (recommended first)

Replace rejection with a FIFO queue that runs **one job at a time**.

- `self.job` / `self.process` / `self.worker` become a list of job records (or a
  `queue.Queue` of pending work plus a single active record).
- A single worker thread drains the queue sequentially, so peak memory and CPU are
  unchanged from today.
- `/api/state` returns `"jobs": [...]` plus the active job id.
- The frontend renders a list: pending items show position and "Waiting…", the active
  item shows the existing progress bar. Replace the six `store.state.job` reads.
- Cancelling a *pending* item just removes it from the queue; cancelling the active
  item uses the existing `cancel()` path.
- Keep per-job `logs` — move from one shared deque to per-job buffers so progress
  lines stay attributable.

### Phase 2 — Configurable concurrency cap (optional, later)

- Add a `max_concurrent_jobs` setting (default **1**).
- Derive a *suggested* default: `1` on CPU, `2–3` when `torch.cuda.is_available()`,
  and never more than `max(1, available_ram_gb // 3)`.
- Surface it in the UI as an advanced setting with an explicit warning that each job
  needs ~1.5–2.5 GB.

## Remaining work

- [ ] Decide queue depth limit (or make it unbounded).
- [ ] Convert `job`/`process`/`worker`/`logs` from scalars to collections.
- [ ] Change `/api/state` to return a job list; keep a `job` field for one release as
      a compatibility shim if needed.
- [ ] Update the six frontend `store.state.job` call sites to render a list.
- [ ] Decide what happens to queued jobs when the window closes (see
      [06 — Close behavior](06-close-behavior.md)).
- [ ] Optional Phase 2: `max_concurrent_jobs` setting with a derived default.
- [ ] Test: queue three separations, cancel the middle one, confirm ordering holds and
      the active job is unaffected.

## Constraints

- Do not raise concurrency without a cap; an uncapped queue with parallel execution
  would exhaust RAM on the 8 GB target machine.
- Keep `cancel()`'s process-group semantics (`os.killpg` on POSIX, `terminate()` on
  Windows) — it is the only thing that reliably kills the child and its workers.
- Do not block the HTTP request thread while waiting for a queue slot; the request
  should return immediately with a job id.

## Related

- [01 — App specification](01-app.md) — job/state model and the progress UI.
- [04 — First-run setup](04-first-run-setup.md) — setup runs as a job too, so it is
  subject to the same queue.
- [06 — Close behavior](06-close-behavior.md) — interaction with queued jobs.
