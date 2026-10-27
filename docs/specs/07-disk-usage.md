# 07 — Disk usage, cache, and uninstall

Status: Doing

What this covers: everywhere the app writes to disk, what the realistic footprint is,
where the genuine disk-abuse risks are, and what the uninstallers do and do not
remove.

## Where everything lives

| Data | Windows | Linux | Removed on uninstall? |
|---|---|---|---|
| App code + embedded runtime | `%ProgramFiles64%\SoundRazer Desktop` | `~/.local/share/soundrazer` | **Yes** |
| Model cache | `%LOCALAPPDATA%\SoundRazer Desktop\models` | `~/.cache/soundrazer-desktop/models` | **No** |
| Config (`ui.json`) | `%LOCALAPPDATA%\SoundRazer Desktop\ui.json` | `~/.local/share/soundrazer-desktop/ui.json` | **No** |
| Projects (originals + stems + exports) | `Documents\SoundRazer Desktop` | `~/Music/SoundRazer Desktop` | **No** |
| Downloaded FFmpeg | `$INSTDIR` (beside the app) | `~/.local/share/soundrazer/app/` | Yes (Windows) |

Resolved in [`ui_entrypoint.py`](../../app/ui_entrypoint.py) (`writable_dirs()`) and
[`tools.py`](../../app/sound_razor/tools.py).

### Why models are not in the app folder

Deliberate, and the reason is documented in `ui_entrypoint.py`: writing to Program
Files needs admin rights that a plain double-click shortcut does not have, so config
and the multi-hundred-MB model cache go to per-user app data instead. The same
`writable_dirs()` handles the OneDrive-redirected Documents case via `known_folder()`.

## Measured footprint

Real numbers from a Linux install with four projects:

| Item | Size |
|---|---:|
| Model cache (`models/`) | **455 MB** |
| Projects (4 songs) | **1.3 GB** |
| — of which stems | ~1.1 GB |
| — of which originals | ~160 MB |
| Setup stack (torch, onnxruntime, librosa, yt-dlp) | ~1.3–1.8 GB |
| Embedded runtime (Windows) | ~38 MB |

Model cache contents, per file:

| File | Size | Loaded when |
|---|---:|---|
| `lead_rhythm_listra92.ckpt` | 337 MB | guitar split |
| `955717e8-8726e21a.th` (`htdemucs`) | 84 MB | 4-stem |
| `5c90dfd2-34c22ccb.th` (`htdemucs_6s`) | 55 MB | 6-stem (default) |

## The real risk: stem amplification, not cache

Cache is **bounded** — models are lazy, one-time, and finite (455 MB total, and the
app never re-downloads a validated file). The genuine growth is **projects**, because
canonical stems are stored as **44.1 kHz stereo 16-bit WAV = 10.1 MB per stem per
minute** — lossless, uncompressed.

Measured against a 3.7-minute song:

```
original.wav    21 MB
6 stems        187 MB      <- ~9x the original
```

A full 6-stem run on a 4-minute song is ~242 MB of stems. Worst case, a **guitar
split keeps everything**: the original guitar stem *plus* both halves:

```
guitar.wav      39.5 MB    <- kept, no longer needed once split
lead.wav        79.0 MB
rhythm.wav      79.0 MB
                          ~198 MB for one stem
```

So the ordering of concern is:

1. **Projects / stems** — unbounded, and grows ~9x per imported song. This is the only
   thing that meaningfully accumulates.
2. **Export copies** — every export writes *new* files into `exports/` and **nothing
   ever deletes old ones**. Re-exporting the same song in another format adds a full
   set; re-exporting the same format overwrites by filename. Repeatedly changing
   formats grows this without limit.
3. **Orphaned staging directories** — `.separation-*`, `.youtube-*`, `.import-*`,
   `.exports-*`, `.guitar-split-*`, `.stems-*`, `.model-download-*`. Normal runs clean
   these up (most use `TemporaryDirectory`), but an interrupted run leaves one behind
   and **nothing ever sweeps them**. See
   [06 — Close behavior](06-close-behavior.md).
4. **Upload buffer** — `/api/import` accepts up to **2 GB** per upload
   (`self.body_size(2 * 1024**3)`), streamed to a temp dir, then **copied** into the
   project via `import_project`. A single import therefore briefly needs ~2x the file
   size in free space.
5. **Cover images** — small, content-addressed (`cover-<sha256[:20]>`), and skipped
   when already present, so effectively bounded.

There is **no** disk-space precheck anywhere, and **no** cache size cap or eviction.
A user on a small SSD could fill the disk mid-separation with no warning; the failure
would surface as a confusing FFmpeg or model error rather than "out of space".

## Uninstall behavior

**Windows** (`installer/SoundRazer.nsis`, `Section "Uninstall"`) removes only:

- `$INSTDIR` contents (app, `sound_razor/`, `runtime/`, `launch.bat`, `ui_entrypoint.py`,
  docs, icon) and `$INSTDIR` itself
- Start Menu folder and the desktop shortcut
- The `HKLM` uninstall registry key

It **never touches** `%LOCALAPPDATA%\SoundRazer Desktop` (models + config) or
`Documents\SoundRazer Desktop` (projects). Consequence: uninstall then reinstall keeps
your ~455 MB of models and skips re-downloading. To fully clean up, the user must
delete `%LOCALAPPDATA%\SoundRazer Desktop` manually.

**Linux** (`installer/install-linux.sh --uninstall`) matches this exactly: it removes
the prefix, launcher, `.desktop` entry, and icon, and prints the three preserved paths
so the user knows what remains.

## Planned change

1. **Switch canonical stem storage from WAV to FLAC** (highest impact, see below).
2. **Offer to delete the model cache on uninstall.** Add an NSIS component/page:
   "Also delete downloaded models and settings? (~455 MB)" — default *off*, since
   keeping them makes reinstall cheaper. Mirror it as a `--purge` flag in the Linux
   script. This is the usual installer convention and closes the "uninstall didn't
   free the space I expected" gap.
3. **Prune the `guitar.wav` intermediate after a successful guitar split** — it is
   superseded by `lead.wav` + `rhythm.wav` and wastes ~39 MB per split. (Keep it on
   failure so the run stays diagnosable.)
4. **Add a disk-space precheck** before a job: estimate stems (~10 MB × minutes ×
   stems) plus the model download if uncached, and refuse with a clear message rather
   than failing mid-run.
5. **Sweep stale staging directories** at startup — shared with
   [06 — Close behavior](06-close-behavior.md).
6. **Surface sizes in the UI** — show per-project and total disk usage, and let the
   user delete `exports/` or whole projects. Today the only deletion is
   `library.delete()`, which removes an entire project.
7. **Document the 9x amplification** in the user-facing README, so expectations are
   set before someone imports a 200-song library.

### Canonical stems: WAV → FLAC

[03 — Output formats](03-output-formats.md) chose WAV as the canonical working
format and that reasoning still holds for *why not hand the separator MP3/FLAC
directly* (guitar split needs raw samples, `combine_other()` needs float headroom,
playback needs a decodable file). It does not rule out FLAC specifically: FLAC is
lossless (bit-exact round trip, `soundfile` decodes it natively) and compresses
PCM audio to roughly 50–60% of WAV size at compression level 5 (already used for
exports, see [03 §5](03-output-formats.md)).

Applying that to the canonical stems themselves — not just exports — stores the
same bits in less space, with no quality trade-off to expose in the UI:

- `combine_other()` keeps its float32 WAV intermediate for safe summing above
  0 dBFS; only the **final** stored stem is written as FLAC.
- `guitar_split.split_guitar()` decodes FLAC via `soundfile` instead of raw WAV —
  a format-string change, not a rewrite.
- Playback needs confirmation that the pywebview host decodes
  `audio/flac` in `<audio>` (expected on current WebView2/WebKit, verify before
  shipping).

Expected reduction: **~40–50% off stem storage on every project**, independent of
source quality — a studio-quality import and a YouTube import get the same
treatment today (`normalize()` forces everything to 44.1 kHz/16-bit stereo before
separation ever runs, see [pipeline.py:145](../../app/sound_razor/audio/pipeline.py)),
so the win is not source-specific and does not need a per-source toggle.

Not planned: exposing canonical bit depth/sample rate/format as a user setting.
FLAC is a strict improvement over WAV here (same data, smaller file), so there is
no real choice to surface. Format/bitrate choice stays where it already is — the
on-demand export flow in [03 — Output formats](03-output-formats.md).

## Remaining work

- [ ] Switch canonical stem storage from WAV to FLAC; update `combine_other()`,
      `guitar_split.py`, and the web player's audio routes accordingly.
- [ ] Confirm the pywebview host decodes FLAC in `<audio>` before shipping the
      above.
- [ ] Add the uninstall prompt for models/settings (NSIS) and `--purge` (Linux).
- [ ] Prune `guitar.wav` after a successful guitar split.
- [ ] Implement the disk-space precheck with a clear error message.
- [ ] Implement the stale-staging-directory sweep (shared with spec 06).
- [ ] Decide whether old exports should be replaced wholesale per export run.
- [ ] Add per-project / total size display and selective cleanup to the UI.
- [ ] Document stem-size amplification in the README.

## Constraints

- Do not move the model cache into `$INSTDIR`; the per-user location is a confirmed
  fix for the Program Files write-permission problem.
- Do not change `writable_dirs()` / `known_folder()`; the OneDrive-aware behavior is a
  confirmed fix.
- Any cleanup must be conservative: known prefixes only, never follow symlinks, never
  delete outside the projects root, and never delete data the user did not create
  through the app.

## Related

- [04 — First-run setup](04-first-run-setup.md) — what gets downloaded and when.
- [06 — Close behavior](06-close-behavior.md) — orphaned staging directories.
- [03 — Output formats](03-output-formats.md) — the export matrix that writes `exports/`.
