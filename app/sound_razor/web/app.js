import {StemPlayer} from './player.js';

// Applied first, before anything else in this module, so the chosen theme is set as
// early as possible (no inline <script> is allowed by this page's CSP, so this is the
// earliest point available — in practice indistinguishable from no flash at all for a
// same-machine local server).
function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('sound-razor-theme') || 'dark'; } catch (_) { /* private mode etc. */ }
  document.documentElement.dataset.theme = saved;
}
initTheme();

const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="sound-razor-token"]').content;
const player = new StemPlayer();
player.onError = error => notice(error.message);
const colors = ['#ff8a3d', '#5ec8ff', '#b48cff', '#4fe0a8', '#ffd166', '#ff6f91'];
const ORIGINAL_COLOR = '#9aa3b2';
const STEMS = [['vocals', 'Vocals', '#ff8a3d'], ['drums', 'Drums', '#5ec8ff'], ['bass', 'Bass', '#b48cff'],
  ['guitar', 'Guitar', '#4fe0a8'], ['piano', 'Piano', '#ffd166'], ['other', 'Other', '#ff6f91']];
const DEFAULT_STEMS = ['vocals', 'drums', 'bass', 'guitar'];
const AUDIO_EXTENSIONS = ['.wav', '.flac', '.mp3', '.opus', '.ogg', '.m4a', '.aac', '.aiff', '.aif'];
const SEPARATION_STEPS = [['prepare', 'Prepare audio'], ['load', 'Load AI model'], ['separate', 'Separate stems'], ['finalize', 'Save stems']];
const GUITAR_STEPS = [['prepare', 'Load model'], ['separate', 'Split guitar'], ['finalize', 'Save tracks']];
const YOUTUBE_STEPS = [['download', 'Download audio'], ['finalize', 'Create project']];
const SETUP_STEPS = [['prepare', 'Check setup'], ['download', 'Download components'], ['install', 'Install packages'], ['finalize', 'Finish']];
const SETUP_STAGE_LABEL = {ffmpeg: 'FFmpeg', separation: 'the separation engine', youtube: 'YouTube support'};
const SETUP_PHASE_TITLE = {prepare: 'Checking what’s needed', download: 'Downloading components', install: 'Installing packages', finalize: 'Finishing up'};
const SETUP_PHASE_SUB = {prepare: 'Verifying the runtime, FFmpeg and the separation engine.', download: 'Fetching the files above.', install: 'This can take several minutes.', finalize: 'Verifying everything works.'};

let state = {root: null, default_root: null, projects: [], job: null, now: 0, setup: null};
let clockSkew = 0;
let view = 'new';
let selected = null;
let audioSignature = '';
let loading = 0;
let controller = null;
let busy = false;
let editing = null;
let deleting = null;
let browseParent = '';
let sourceMode = 'file';
let chosenFile = null;
let pending = null;  // YouTube download that should be separated once it finishes
let resepOpen = false;
let announced = null;
let setupDeclined = false;
let setupYoutube = false;
let setupJobAnnounced = null;
const lookupSelections = {edit: null};
const lookupEpoch = {edit: 0};
const coverImages = new Map();

/* ---------- helpers ---------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
let noticeTimer = null;
function notice(message = '', kind = 'info') {
  clearTimeout(noticeTimer);
  $('notice').textContent = message; $('notice').hidden = !message; $('notice').dataset.kind = kind;
  if (message) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, kind === 'error' ? 9000 : 5000);
}
function time(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function duration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m < 60 ? `${m}m ${String(s).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function serverNow() { return Date.now() / 1000 + clockSkew; }
function sep() { return (state.root || '').includes('\\') ? '\\' : '/'; }
function stem(name) { return name.replace(/\.[^.]+$/, ''); }
async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {'X-sound-razor-Token': token, ...(data === undefined ? {} : {'Content-Type': 'application/json'})},
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
function activeProject() { return state.projects.find(p => p.id === selected); }
function jobRunning() { return state.job && ['running', 'cancelling'].includes(state.job.status); }
function projectUrl(id) { return `/api/projects/${encodeURIComponent(id)}`; }

async function coverImage(container, project) {
  const key = JSON.stringify([state.root, project.id, project.cover]);
  if (container.dataset.coverKey === key) return;
  container.dataset.coverKey = key;
  container.querySelector('img')?.remove(); container.classList.remove('has-cover');
  if (!project.cover) return;
  const root = state.root;
  if (!coverImages.has(key)) {
    coverImages.set(key, fetch(`${projectUrl(project.id)}/cover?${new URLSearchParams({root})}`, {headers: {'X-sound-razor-Token': token}})
      .then(r => { if (!r.ok) throw new Error('Cover unavailable'); return r.blob(); })
      .then(blob => URL.createObjectURL(blob)).catch(() => { coverImages.delete(key); return null; }));
    if (coverImages.size > 64) {
      const oldest = coverImages.keys().next().value;
      coverImages.get(oldest).then(url => { if (url) URL.revokeObjectURL(url); }); coverImages.delete(oldest);
    }
  }
  const url = await coverImages.get(key);
  if (!url || root !== state.root || container.dataset.coverKey !== key) return;
  const img = el('img'); img.alt = `${project.album || project.title} cover`; img.src = url;
  img.onerror = () => { img.remove(); container.classList.remove('has-cover'); };
  container.append(img); container.classList.add('has-cover');
}

/* ---------- views ---------- */
function show(name) {
  if (state.setup?.required && !setupDeclined && name !== 'setup') name = 'setup';
  view = name;
  for (const v of ['new', 'library', 'song', 'setup']) $(`view-${v}`).hidden = v !== name;
  $('tab-new').setAttribute('aria-selected', String(name === 'new'));
  $('tab-library').setAttribute('aria-selected', String(name === 'library' || name === 'song'));
  if (name !== 'song') { selected = null; audioSignature = ''; clearAudio(); }
  render();
}
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
  if (state.setup?.required && !setupDeclined) { show('setup'); return; }
  show(tab.dataset.view);
});
$('back').onclick = () => show('library');
function selectProject(id) {
  if (state.setup?.required && !setupDeclined) { notice('Complete the one-time setup first.', 'error'); show('setup'); return; }
  if (selected === id && view === 'song') return;
  selected = id; resepOpen = false; view = 'song';
  for (const v of ['new', 'library', 'song']) $(`view-${v}`).hidden = v !== 'song';
  $('tab-new').setAttribute('aria-selected', 'false'); $('tab-library').setAttribute('aria-selected', 'true');
  $('song-stems').dataset.preset = '';
  render();
}

function render() {
  // Route to setup for real (toggling which view is actually visible) rather than just
  // setting the `view` variable: that was the bug — it fooled later checks in this same
  // function (like the banner's `view !== 'setup'`) into thinking the user was already
  // looking at the setup screen, while the DOM still showed the normal "Separate" view
  // underneath, with no banner either, on top of a plain page load not calling show()
  // (and so never running this gate at all) — so first-run setup never actually appeared.
  if (state.setup?.required && !setupDeclined && view !== 'setup') { show('setup'); return; }
  renderChrome(); renderNew(); renderLibrary(); renderSong(); renderSetup(); renderSetupView(); renderSetupBanner();
}
function renderChrome() {
  $('project-count').textContent = state.projects.length;
  const job = state.job, pill = $('job-pill');
  pill.hidden = !jobRunning();
  if (jobRunning()) {
    const what = job.kind === 'youtube' ? 'Downloading' : job.kind === 'setup' ? 'Setting up' : job.guitar_split ? 'Splitting guitar' : 'Separating';
    $('job-pill-text').textContent = `${what} · ${Math.floor(job.progress || 0)}%`;
  }
}
$('job-pill').onclick = () => { const job = state.job; if (job?.project) selectProject(job.project); else show('new'); };

async function refresh() {
  const next = await api('/api/state');
  clockSkew = next.now - Date.now() / 1000;
  const rootChanged = state.root !== next.root;
  state = next;
  if (view === 'song' && (rootChanged || !activeProject())) { show(rootChanged ? 'new' : 'library'); return; }
  continuePending();
  announce();
  render();
}
function announce() {
  const job = state.job;
  if (!job || job.kind === 'youtube' || announced === job.id) return;
  if (job.status === 'succeeded') {
    announced = job.id;
    if (job.kind === 'setup') {
      notice('Setup complete — you’re ready to separate tracks.', 'success');
      setupJobAnnounced = job.id;
      show('new');
      return;
    }
    const p = state.projects.find(x => x.id === job.project);
    notice(`${p?.title || 'Song'} is ready: ${job.stems.length} stems saved.`, 'success');
  }
}

/* ---------- stem picker ---------- */
function buildPicker(container) {
  container.replaceChildren();
  const presets = el('div', 'preset-cards');
  for (const [value, title, sub] of [['custom', 'Instruments', 'Pick individual stems'], ['vocals', 'Vocals + Instrumental', 'Fast two-track split (karaoke)']]) {
    const label = el('label', 'preset-card');
    const input = el('input'); input.type = 'radio'; input.name = `${container.id}-preset`; input.value = value; input.checked = value === 'custom';
    label.append(input, el('strong', '', title), el('small', '', sub));
    presets.append(label);
  }
  const grid = el('fieldset', 'stem-grid');
  grid.append(el('legend', 'sr-only', 'Select stems'));
  for (const [value, name, color] of STEMS) {
    const label = el('label', 'stem-option'); label.style.setProperty('--c', color);
    const input = el('input'); input.type = 'checkbox'; input.value = value; input.checked = DEFAULT_STEMS.includes(value);
    label.append(input, el('span', 'stem-dot'), el('span', 'stem-label', name));
    grid.append(label);
  }
  const help = el('p', 'hint', 'Unselected instruments are dropped. Tick “Other” to keep everything left over in one track.');
  container.append(presets, grid, help);
  container.onchange = () => { syncPicker(container); render(); };
  syncPicker(container);
}
function syncPicker(container) {
  const custom = pickerValue(container).preset === 'custom';
  container.querySelector('.stem-grid').hidden = !custom;
  container.querySelector('.hint').hidden = !custom;
}
function pickerValue(container) {
  return {preset: container.querySelector('input[type=radio]:checked').value,
    stems: [...container.querySelectorAll('.stem-grid input:checked')].map(input => input.value)};
}
function pickerValid(container) {
  const value = pickerValue(container);
  return value.preset === 'vocals' || value.stems.length > 0;
}
buildPicker($('new-stems'));
buildPicker($('song-stems'));

/* ---------- progress view ---------- */
function buildProgress(panel) {
  panel.innerHTML = `
    <div class="pv-ring" aria-hidden="true">
      <svg viewBox="0 0 120 120"><defs><linearGradient id="${panel.id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#ff5c6c"/></linearGradient></defs>
        <circle class="pv-track" cx="60" cy="60" r="52"/><circle class="pv-bar" cx="60" cy="60" r="52" stroke="url(#${panel.id}-g)"/><circle class="pv-spin" cx="60" cy="60" r="52"/></svg>
      <div class="pv-pct"><span class="pv-num">0</span><small>%</small></div>
    </div>
    <div class="pv-body">
      <div class="pv-top"><div><h2 class="pv-title"></h2><p class="pv-sub"></p></div><button type="button" class="btn btn-ghost btn-sm pv-cancel">Cancel</button></div>
      <div class="pv-stats">
        <div><span class="eyebrow">Time left</span><strong class="pv-eta">—</strong></div>
        <div><span class="eyebrow">Elapsed</span><strong class="pv-elapsed">0s</strong></div>
        <div><span class="eyebrow">Stems</span><strong class="pv-stems">—</strong></div>
      </div>
      <ol class="pv-steps"></ol>
      <div class="pv-linebar"><i></i></div>
      <details class="log-details"><summary>Process log</summary><pre class="log-output pv-log"></pre></details>
    </div>`;
  panel.querySelector('.pv-cancel').onclick = async event => {
    event.currentTarget.disabled = true;
    try { await api('/api/cancel', {}); await refresh(); } catch (error) { notice(error.message, 'error'); }
  };
}
buildProgress($('job-panel'));
buildProgress($('yt-panel'));
const CIRCUMFERENCE = 2 * Math.PI * 52;

function renderProgress(panel, job) {
  const youtube = job.kind === 'youtube';
  const setup = job.kind === 'setup';
  const steps = setup ? SETUP_STEPS : youtube ? YOUTUBE_STEPS : job.guitar_split ? GUITAR_STEPS : SEPARATION_STEPS;
  const running = ['running', 'cancelling'].includes(job.status);
  const phase = setup ? job.phase : job.status === 'succeeded' ? 'done' : job.phase === 'download' && !youtube ? 'load' : job.phase;
  const progress = job.status === 'succeeded' ? 100 : Math.max(0, Math.min(100, job.progress || 0));
  panel.dataset.status = job.status;
  panel.classList.toggle('busy', running && (setup ? true : youtube ? progress === 0 : phase !== 'separate'));
  panel.querySelector('.pv-num').textContent = Math.floor(progress);
  panel.querySelector('.pv-bar').style.strokeDasharray = `${CIRCUMFERENCE}`;
  panel.querySelector('.pv-bar').style.strokeDashoffset = `${CIRCUMFERENCE * (1 - progress / 100)}`;
  panel.querySelector('.pv-linebar i').style.width = `${progress}%`;
  const titles = {prepare: job.guitar_split ? 'Loading the guitar model' : 'Preparing audio', load: job.phase === 'download' ? 'Downloading AI model' : 'Loading AI model',
    download: 'Downloading from YouTube', separate: job.guitar_split ? 'Splitting guitar into lead & rhythm' : 'Separating stems', finalize: youtube ? 'Creating project' : 'Saving stems'};
  const subs = {prepare: 'Converting to 44.1 kHz stereo WAV', load: job.phase === 'download' ? 'First run only, this can take a few minutes' : 'Getting the neural network ready',
    download: 'Fetching the best audio stream', separate: 'The AI model is working through your track', finalize: 'Almost done'};
  const ended = {succeeded: youtube ? 'Download complete' : 'Separation complete', failed: youtube ? 'Download failed' : 'Separation failed', cancelled: 'Cancelled'};
  let title, sub;
  if (setup) {
    const stage = job.stage; const what = stage ? ` ${SETUP_STAGE_LABEL[stage] || ''}` : '';
    const phaseTitles = {...SETUP_PHASE_TITLE, download: `Downloading${what}`, install: `Installing${what}`};
    const phaseSubs = {...SETUP_PHASE_SUB};
    title = job.status === 'cancelling' ? 'Stopping…' : running ? phaseTitles[phase] || 'Working…' : (job.status === 'succeeded' ? 'Setup complete' : 'Setup failed');
    sub = running ? phaseSubs[phase] || '' : job.error || (job.status === 'succeeded' ? 'You can separate tracks now.' : '');
  } else {
    const titles = {prepare: job.guitar_split ? 'Loading the guitar model' : 'Preparing audio', load: job.phase === 'download' ? 'Downloading AI model' : 'Loading AI model',
      download: 'Downloading from YouTube', separate: job.guitar_split ? 'Splitting guitar into lead & rhythm' : 'Separating stems', finalize: youtube ? 'Creating project' : 'Saving stems'};
    const subs = {prepare: 'Converting to 44.1 kHz stereo WAV', load: job.phase === 'download' ? 'First run only, this can take a few minutes' : 'Getting the neural network ready',
      download: 'Fetching the best audio stream', separate: 'The AI model is working through your track', finalize: 'Almost done'};
    title = job.status === 'cancelling' ? 'Stopping…' : running ? titles[phase] || 'Working…' : ended[job.status];
    sub = running ? subs[phase] || '' : job.error || (job.status === 'succeeded' ? 'Your stems are ready.' : '');
  }
  panel.querySelector('.pv-title').textContent = title;
  panel.querySelector('.pv-sub').textContent = sub;
  const cancel = panel.querySelector('.pv-cancel');
  cancel.hidden = !running; cancel.disabled = job.status === 'cancelling';
  panel.querySelector('.pv-stems').textContent = setup || youtube ? '—' : (job.stems || []).length;
  const list = panel.querySelector('.pv-steps'); list.replaceChildren();
  const current = phase === 'done' ? steps.length : Math.max(0, steps.findIndex(([key]) => key === phase));
  steps.forEach(([key, label], index) => {
    const item = el('li', index < current || phase === 'done' ? 'done' : index === current && running ? 'active' : '', label);
    if (index === current && !running && job.status !== 'succeeded') item.className = 'failed';
    list.append(item);
  });
  panel.querySelector('.pv-log').textContent = (job.logs || []).join('\n');
  renderTimers(panel, job);
}
function renderTimers(panel, job) {
  const now = serverNow();
  panel.querySelector('.pv-elapsed').textContent = duration((job.finished || now) - job.started);
  const running = ['running', 'cancelling'].includes(job.status);
  let eta = '—';
  if (running && job.eta != null) {
    const left = job.eta - (now - (job.eta_at || now));
    eta = left > 1 ? `~${duration(left)}` : 'a few seconds';
  } else if (running) eta = 'Estimating…';
  else if (job.status === 'succeeded') eta = 'Done';
  panel.querySelector('.pv-eta').textContent = eta;
}
setInterval(() => {
  const job = state.job; if (!job) return;
  for (const panel of [$('job-panel'), $('yt-panel')]) if (!panel.hidden) renderTimers(panel, job);
}, 500);

/* ---------- new separation ---------- */
function setSource(mode) {
  sourceMode = mode;
  $('src-file').setAttribute('aria-selected', String(mode === 'file'));
  $('src-yt').setAttribute('aria-selected', String(mode === 'youtube'));
  $('pane-file').hidden = mode !== 'file'; $('pane-yt').hidden = mode !== 'youtube';
  renderNew();
}
$('src-file').onclick = () => setSource('file');
$('src-yt').onclick = () => setSource('youtube');
function chooseFile(file) {
  if (!file) return;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) { notice(`${file.name} is not a supported audio file.`, 'error'); return; }
  chosenFile = file; $('start-error').textContent = '';
  $('new-title').placeholder = stem(file.name).replaceAll('_', ' ');
  renderNew();
}
$('audio-file').onchange = () => chooseFile($('audio-file').files[0]);
$('file-clear').onclick = () => { chosenFile = null; $('audio-file').value = ''; $('new-title').placeholder = 'Uses the file name'; renderNew(); };
const zone = $('dropzone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragging'); chooseFile(e.dataTransfer.files[0]); });
$('youtube-url').oninput = () => renderNew();

function renderNew() {
  $('dropzone').hidden = !!chosenFile; $('file-card').hidden = !chosenFile;
  if (chosenFile) {
    $('file-name').textContent = chosenFile.name;
    $('file-meta').textContent = `${(chosenFile.size / 1048576).toFixed(1)} MB · ${(chosenFile.name.split('.').pop() || '').toUpperCase()}`;
  }
  $('root-label').textContent = state.root || 'No folder selected';
  $('root-label').title = state.root || '';
  const isDefault = state.root && state.root === state.default_root;
  $('root-default').hidden = !isDefault;
  $('folder-default').hidden = !state.default_root || isDefault;
  const name = sourceMode === 'file' ? (chosenFile ? stem(chosenFile.name) : '<song name>') : '<video title>';
  $('output-preview').textContent = state.root ? `→ ${state.root}${sep()}${name}${sep()}stems` : '';
  const youtube = state.job?.kind === 'youtube' ? state.job : null;
  const showYt = !!youtube && (jobRunning() || (pending && pending.jobId === youtube.id) || youtube.status === 'failed' && pending?.failed === youtube.id);
  $('yt-panel').hidden = !showYt;
  if (showYt) renderProgress($('yt-panel'), youtube);
  const ready = sourceMode === 'file' ? !!chosenFile : /^https?:\/\/\S+/.test($('youtube-url').value.trim());
  $('start').disabled = !ready || !state.root || busy || !!jobRunning() || !pickerValid($('new-stems'));
  $('start').textContent = jobRunning() && !busy ? 'Another job is running…' : busy ? 'Starting…' : 'Start separation';
  $('folder-open').disabled = busy || !!jobRunning();
  $('folder-default').disabled = busy || !!jobRunning();
}
function newFields() {
  return Object.fromEntries(['title', 'artist', 'album', 'year'].map(key => [key, $(`new-${key}`).value.trim()]));
}

/* ---------- first-run setup ---------- */
// How much of the overall 0-100 progress each running stage gets, in the same order
// backend setup.py allocated bands (STAGE_ORDER, filtered to what was actually
// requested) — matches run_setup()'s `band = (100 - FINALIZE_BAND) // len(missing)`
// exactly, so a stage's own 0-100% can be derived client-side from the one shared
// job.progress number without the backend needing to report per-stage percentages.
const SETUP_FINALIZE_BAND = 10;
let setupRunningStages = [];  // the exact stage-id order sent to /api/setup/start

function stageProgress(stageId, job) {
  const index = setupRunningStages.indexOf(stageId);
  if (index === -1) return null;
  const band = Math.floor((100 - SETUP_FINALIZE_BAND) / Math.max(1, setupRunningStages.length));
  const start = index * band;
  if (job.progress >= start + band) return 100;
  if (job.progress <= start) return 0;
  return Math.round((job.progress - start) / band * 100);
}
function renderSetup() {
  const setup = state.setup; if (!setup) return;
  const list = $('setup-list'); list.replaceChildren();
  let total = 0;
  const job = state.job;
  const running = job && job.kind === 'setup' && ['running', 'cancelling'].includes(job.status);
  // setupRunningStages is normally set when the "Download & install" click fires, but a
  // page reload (or anything else landing here) while a setup job is already running
  // would otherwise leave every row unable to compute its share of progress — rebuild it
  // from the stages currently reported missing, same order, same filter the backend uses.
  if (running && !setupRunningStages.length) {
    // Best-effort reconstruction — the user's original optional-YouTube choice isn't
    // recoverable after a reload, so default to "most people leave it unchecked" (just
    // the required stages), but always include whichever stage the job reports as
    // currently active even if optional, since it's clearly part of this run.
    setupRunningStages = setup.stages.filter(s => s.missing && (s.required || s.id === job?.stage)).map(s => s.id);
  }
  for (const stage of setup.stages) {
    if (stage.missing) total += stage.size_mb;
    const row = el('label', 'setup-row');
    const input = el('input'); input.type = 'checkbox';
    input.disabled = stage.required || stage.done || running;
    input.checked = stage.required || stage.done;
    if (!stage.required && !stage.done) {
      input.checked = setupYoutube;
      input.onchange = () => { setupYoutube = input.checked; };
    }
    const pct = running ? stageProgress(stage.id, job) : null;
    const isDone = stage.done || pct === 100;
    const isActive = running && pct !== null && pct > 0 && pct < 100;
    const isQueued = running && pct === 0;
    let icon = '↓', cls = 'setup-status--missing';
    if (isDone) { icon = '✓'; cls = 'setup-status--done'; }
    else if (isActive || job?.stage === stage.id) { icon = `${pct ?? 0}%`; cls = 'setup-status--active'; }
    else if (isQueued) { icon = '⋯'; cls = 'setup-status--queued'; }
    row.classList.toggle('setup-row--active', isActive || (running && job?.stage === stage.id));
    row.classList.toggle('setup-row--done', isDone);
    const status = el('span', `setup-status ${cls}`, icon);
    row.append(input, status, el('span', 'setup-row-label', stage.label), el('span', 'setup-row-size', `~${stage.size_mb} MB`));
    if (isActive || (running && job?.stage === stage.id)) {
      const bar = el('div', 'setup-row-bar'); const fill = el('i'); fill.style.width = `${pct ?? 0}%`; bar.append(fill);
      row.append(bar);
    }
    list.append(row);
  }
  $('setup-total').textContent = running
    ? `Installing · ${Math.floor(job.progress)}% overall`
    : `Total: ~${total} MB · usually 3–8 min on a typical connection`;
  const requiredMissing = setup.stages.some(s => s.required && s.missing);
  $('setup-start').disabled = !requiredMissing || running;
  $('setup-start').hidden = running;
  $('setup-decline').hidden = running;
  $('setup-cancel').hidden = !running;
  $('setup-cancel').disabled = job?.status === 'cancelling';
}
function renderSetupBanner() {
  const banner = $('setup-banner');
  if (state.setup?.required && !setupDeclined && view !== 'setup') banner.hidden = false;
  else banner.hidden = true;
}
function renderSetupView() {
  const job = state.job;
  if (job && !['running', 'cancelling'].includes(job.status) && setupJobAnnounced !== job.id) {
    if (job.status === 'failed') { notice(job.error || 'Setup failed. Try again.', 'error'); setupJobAnnounced = job.id; }
    if (job.status === 'succeeded') { setupRunningStages = []; }
    setupJobAnnounced = job.id;
  }
}
$('setup-banner-open').onclick = () => show('setup');
$('setup-decline').onclick = () => { setupDeclined = true; render(); show('new'); };
$('setup-start').onclick = async () => {
  if (busy || jobRunning()) return;
  const stages = state.setup.stages.filter(s => s.missing && (s.required || s.id === 'youtube' && setupYoutube)).map(s => s.id);
  setupRunningStages = stages;  // same order/filter the backend uses for its progress bands
  $('setup-error').textContent = '';
  try {
    await api('/api/setup/start', {stages});
    await refresh();
  } catch (error) { setupRunningStages = []; $('setup-error').textContent = error.message; }
};
$('setup-cancel').onclick = () => api('/api/cancel', {}).then(refresh).catch(e => notice(e.message, 'error'));
function upload(file, data) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({...data, filename: file.name, root: state.root});
    xhr.open('POST', `/api/import?${query}`);
    xhr.setRequestHeader('X-sound-razor-Token', token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      $('upload-progress').value = pct; $('upload-pct').textContent = `${pct}%`;
    };
    xhr.onload = () => { try { const result = JSON.parse(xhr.responseText); xhr.status === 200 ? resolve(result) : reject(new Error(result.error)); } catch (_) { reject(new Error('Import failed. Check the server terminal.')); } };
    xhr.onerror = () => reject(new Error('Could not reach the local server.'));
    xhr.send(file);
  });
}
$('start').onclick = async () => {
  if (busy || jobRunning()) return;
  if (state.setup?.required) { notice('Complete the one-time setup first.', 'error'); return; }
  const choice = pickerValue($('new-stems'));
  busy = true; $('start-error').textContent = ''; renderNew();
  try {
    if (sourceMode === 'file') {
      $('upload-box').hidden = false; $('upload-progress').value = 0; $('upload-pct').textContent = '0%';
      const project = await upload(chosenFile, newFields());
      await api(`${projectUrl(project.id)}/separate`, {root: state.root, ...choice});
      chosenFile = null; $('audio-file').value = ''; for (const k of ['title', 'artist', 'album', 'year']) $(`new-${k}`).value = '';
      await refresh(); selectProject(project.id);
    } else {
      const job = await api('/api/import-youtube', {...newFields(), url: $('youtube-url').value.trim(), root: state.root});
      pending = {jobId: job.id, ...choice};
      await refresh();
    }
  } catch (error) { $('start-error').textContent = error.message; }
  finally { busy = false; $('upload-box').hidden = true; renderNew(); }
};
async function continuePending() {
  const job = state.job;
  if (!pending || !job || job.id !== pending.jobId) return;
  if (job.status === 'succeeded' && job.project) {
    const {preset, stems} = pending; pending = null;
    $('youtube-url').value = '';
    try { await api(`${projectUrl(job.project)}/separate`, {root: state.root, preset, stems}); await refresh(); selectProject(job.project); }
    catch (error) { notice(error.message, 'error'); await refresh(); selectProject(job.project); }
  } else if (['failed', 'cancelled'].includes(job.status)) {
    pending = {failed: job.id};
  }
}

/* ---------- output folder ---------- */
async function browse(path) {
  const data = await api(`/api/folders?path=${encodeURIComponent(path || '')}`);
  $('folder-path').value = data.path; browseParent = data.parent;
  $('folder-children').replaceChildren();
  for (const folder of data.folders) {
    const button = el('button', '', `▸  ${folder.name}`); button.type = 'button';
    button.onclick = () => browse(folder.path).catch(e => $('folder-error').textContent = e.message);
    $('folder-children').append(button);
  }
  if (!data.folders.length) $('folder-children').append(el('p', '', 'No subfolders. You can select this folder.'));
}
function openFolder() {
  $('folder-error').textContent = ''; $('create-folder').checked = false;
  $('folder-dialog').showModal();
  browse(state.root).catch(error => $('folder-error').textContent = error.message);
}
$('folder-open').onclick = openFolder;
$('library-folder').onclick = openFolder;
$('folder-default').onclick = async () => {
  try { await api('/api/library', {path: state.default_root, create: true}); await refresh(); notice('Saving to the default output folder.'); }
  catch (error) { notice(error.message, 'error'); }
};
$('browse-path').onclick = () => browse($('folder-path').value).catch(e => $('folder-error').textContent = e.message);
$('folder-up').onclick = () => browse(browseParent).catch(e => $('folder-error').textContent = e.message);
$('folder-form').onsubmit = async e => {
  e.preventDefault();
  try {
    await api('/api/library', {path: $('folder-path').value, create: $('create-folder').checked});
    $('folder-dialog').close(); await refresh();
  } catch (error) { $('folder-error').textContent = error.message; }
};
document.querySelectorAll('.close-dialog').forEach(button => button.onclick = () => { if (!busy) button.closest('dialog').close(); });

/* ---------- library ---------- */
function renderLibrary() {
  $('library-folder').textContent = state.root || 'no folder';
  if (view !== 'library') return;
  const list = $('library'); list.replaceChildren();
  const query = $('search').value.toLowerCase();
  const projects = state.projects.filter(p => `${p.title} ${p.artist} ${p.album}`.toLowerCase().includes(query));
  for (const project of projects) {
    const card = el('button', 'song-card');
    const art = el('span', 'card-art');
    art.style.setProperty('--h', [...project.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7));
    art.append(el('span', 'card-initial', (project.title || '?').trim().charAt(0).toUpperCase()));
    coverImage(art, project);
    const job = state.job;
    let badge;
    if (job && job.project === project.id && jobRunning()) badge = el('span', 'badge badge-live', `Processing ${Math.floor(job.progress || 0)}%`);
    else if (project.stems.length) badge = el('span', 'badge badge-ok', `${project.stems.length} stems`);
    else badge = el('span', 'badge', 'Not separated');
    const text = el('span', 'card-text');
    text.append(el('strong', '', project.title), el('small', '', project.artist || 'Unknown artist'));
    card.append(art, text, badge);
    card.onclick = () => selectProject(project.id);
    list.append(card);
  }
  if (!projects.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', query ? 'No matching songs' : 'No songs yet'),
      el('p', '', query ? 'Try a different search.' : 'Separate your first song and it will appear here.'));
    if (!query) { const go = el('button', 'btn btn-primary btn-sm', 'Separate a song'); go.onclick = () => show('new'); empty.append(go); }
    list.append(empty);
  }
}
$('search').oninput = renderLibrary;
$('refresh').onclick = () => refresh().catch(e => notice(e.message, 'error'));

/* ---------- song view ---------- */
function renderSong() {
  const project = activeProject();
  if (view !== 'song' || !project) return;
  $('title').textContent = project.title;
  coverImage(document.querySelector('.record-art'), project);
  $('artist').textContent = project.artist || 'Unknown artist';
  $('album').textContent = [project.album, project.year].filter(Boolean).join(' · ');
  $('source-name').textContent = project.original || 'No original file';
  $('project-warning').textContent = project.warnings.join(' ');
  $('project-warning').hidden = !project.warnings.length;
  const job = state.job;
  const belongs = job && job.project === selected && job.kind !== 'youtube';
  const busyHere = belongs && jobRunning();
  const showJob = belongs && (busyHere || ['failed', 'cancelled'].includes(job.status));
  $('job-panel').hidden = !showJob;
  if (showJob) renderProgress($('job-panel'), job);
  const hasStems = project.stems.length > 0;
  const showPlayer = (hasStems || !!project.original) && !busyHere;
  $('mixer').hidden = !showPlayer;
  $('transport').hidden = !showPlayer;
  document.querySelector('.mixer .panel-sub').textContent = hasStems
    ? 'Balance, mute and solo each stem — including the original, for comparison.'
    : 'Preview the original recording before choosing stems.';
  $('resep-panel').hidden = busyHere || (hasStems && !resepOpen);
  $('resep-close').hidden = !hasStems;
  $('resep-title').textContent = hasStems ? 'Separate again' : 'Separate this song';
  $('separation-description').textContent = hasStems
    ? 'A successful rerun replaces this song’s current stems.'
    : 'This song hasn’t been split yet. Choose stems and start.';
  $('separate').disabled = !project.original || !!jobRunning() || !pickerValid($('song-stems'));
  $('separate').textContent = jobRunning() && !busyHere ? 'Another job is running…' : hasStems ? 'Separate again' : 'Separate stems';
  $('delete-open').disabled = !!busyHere;
  $('resep-open').disabled = !!jobRunning();
  document.querySelectorAll('[data-split-guitar]').forEach(button => { button.disabled = !!jobRunning(); });
  const signature = JSON.stringify([state.root, project.id, project.stems, project.original]);
  if (signature !== audioSignature && !busyHere) {
    audioSignature = signature;
    loadAudio(project).catch(error => { if (error.name !== 'AbortError') notice(error.message, 'error'); });
  }
}
$('resep-open').onclick = () => { resepOpen = true; renderSong(); $('resep-panel').scrollIntoView({behavior: 'smooth', block: 'nearest'}); };
$('resep-close').onclick = () => { resepOpen = false; renderSong(); };
$('separate').onclick = async () => {
  if (!selected) return; $('separate').disabled = true;
  try { await api(`${projectUrl(selected)}/separate`, {root: state.root, ...pickerValue($('song-stems'))}); resepOpen = false; await refresh(); }
  catch (error) { notice(error.message, 'error'); renderSong(); }
};
$('reveal').onclick = () => api(`${projectUrl(selected)}/reveal`, {root: state.root}).catch(e => notice(e.message, 'error'));

function clearAudio() {
  controller?.abort(); loading++; player.clear();
  $('tracks').replaceChildren();
  $('audio-loading').hidden = true;
  for (const id of ['play', 'restart', 'seek', 'reset-mix', 'playback-speed', 'reset-speed']) $(id).disabled = true;
  $('seek').value = 0; $('seek').max = 1; $('elapsed').textContent = '0:00'; $('duration').textContent = '0:00';
}
function buildStemPills(items) {
  const pills = new Map();
  $('audio-loading-stems').replaceChildren(...items.map(item => {
    const pill = el('span', 'stem-pill', item.name);
    pills.set(item.file, pill);
    return pill;
  }));
  return pills;
}
function setLoadingProgress(label, fraction) {
  $('audio-loading-label').textContent = label;
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  $('audio-loading-pct').textContent = `${pct}%`;
  $('audio-loading-bar').value = pct;
}
// Reads the response as a stream instead of one arrayBuffer() call so loading can show
// real byte progress (stems run tens of MB each) rather than just "file i of n".
async function fetchWithProgress(url, signal, onBytes) {
  const response = await fetch(url, {headers: {'X-sound-razor-Token': token}, signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body) { onBytes(total, total); return new Uint8Array(await response.arrayBuffer()).buffer; }
  const reader = response.body.getReader();
  const chunks = []; let received = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value); received += value.length;
    onBytes(received, total);
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return buffer.buffer;
}
const ORIGINAL_FILE = '__original__';
function buildLoadItems(project, root) {
  const items = [];
  // Original plays alongside the separated stems (muted by default, for A/B — see
  // loadAudio) once they exist, and is the only track when they don't yet, so the song
  // can be previewed before choosing what to separate.
  if (project.original) {
    items.push({name: 'Original', file: ORIGINAL_FILE,
      url: `${projectUrl(project.id)}/original?${new URLSearchParams({root})}`});
  }
  for (const item of project.stems) {
    items.push({...item, url: `${projectUrl(project.id)}/audio/${encodeURIComponent(item.file)}?${new URLSearchParams({root})}`});
  }
  return items;
}
async function loadAudio(project) {
  clearAudio();
  const epoch = loading;
  const root = state.root;
  controller = new AbortController();
  const signal = controller.signal;
  const items = buildLoadItems(project, root);
  if (!items.length) { $('audio-status').textContent = ''; return; }
  const tracks = [];
  const pills = buildStemPills(items);
  const received = new Array(items.length).fill(0);
  const totals = new Array(items.length).fill(0);
  $('audio-loading').hidden = false;
  setLoadingProgress(`Loading ${items[0].name}…`, 0);
  try {
    for (const [i, item] of items.entries()) {
      pills.get(item.file)?.classList.add('loading');
      setLoadingProgress(`Loading ${item.name} · ${i + 1} of ${items.length}`,
        received.reduce((a, b) => a + b, 0) / (totals.reduce((a, b) => a + b, 0) || 1));
      const encoded = await fetchWithProgress(item.url, signal, (got, total) => {
        received[i] = got; totals[i] = total || Math.max(total, got);
        const knownTotal = totals.reduce((a, b) => a + b, 0);
        const fraction = knownTotal ? received.reduce((a, b) => a + b, 0) / knownTotal : i / items.length;
        setLoadingProgress(`Loading ${item.name} · ${i + 1} of ${items.length}`, fraction);
      }).catch(error => { throw new Error(`Could not load ${item.name}. Refresh the library and try again. (${error.message})`); });
      if (epoch !== loading) return;
      const buffer = await player.ensureContext().decodeAudioData(encoded);
      if (epoch !== loading) return;
      pills.get(item.file)?.classList.replace('loading', 'done');
      tracks.push({...item, buffer});
    }
    setLoadingProgress('Loaded', 1);
    player.setTracks(tracks);
    // Hear the separated result by default when there's one to hear; Original stays
    // available to solo for comparison. With no stems yet, Original is the only track
    // and plays normally.
    const hasStems = project.stems.length > 0;
    const original = player.tracks.find(t => t.file === ORIGINAL_FILE);
    if (original && hasStems) original.muted = true;
    $('seek').max = player.duration;
    $('duration').textContent = time(player.duration);
    for (const id of ['play', 'restart', 'seek', 'reset-mix', 'playback-speed', 'reset-speed']) $(id).disabled = false;
    const durations = tracks.map(t => t.buffer.duration);
    $('audio-status').textContent = hasStems && Math.max(...durations) - Math.min(...durations) > 0.25
      ? 'These stems have different durations. Shorter tracks will end first.' : '';
    renderTracks();
    $('audio-loading').hidden = true;
  } catch (error) {
    if (epoch !== loading || error.name === 'AbortError') return;
    $('audio-loading').hidden = true;
    $('audio-status').replaceChildren(el('span', '', `Audio could not load: ${error.message} `));
    const retry = el('button', 'text-button', 'Retry');
    retry.onclick = () => loadAudio(project);
    $('audio-status').append(retry);
  }
}
function drawWave(canvas, buffer, color) {
  const width = Math.max(150, canvas.clientWidth);
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale; canvas.height = 48 * scale;
  const context = canvas.getContext('2d'); context.scale(scale, scale);
  const data = buffer.getChannelData(0);
  const columns = Math.floor(width / 3);
  const stride = Math.max(1, Math.floor(data.length / columns));
  context.fillStyle = color;
  for (let i = 0; i < columns; i++) {
    let peak = 0;
    // Real samples, bounded work even on a full-length song.
    const skip = Math.max(1, Math.floor(stride / 64));
    for (let j = i * stride; j < Math.min((i + 1) * stride, data.length); j += skip) peak = Math.max(peak, Math.abs(data[j]));
    const height = Math.max(2, Math.min(46, peak * 60));
    context.fillRect(i * 3, (48 - height) / 2, 2, height);
  }
}
function renderTracks() {
  $('tracks').replaceChildren();
  for (const [index, track] of player.tracks.entries()) {
    const isOriginal = track.file === ORIGINAL_FILE;
    const color = isOriginal ? ORIGINAL_COLOR : (STEMS.find(([value]) => `${value}.wav` === track.file)?.[2] || colors[index % colors.length]);
    const row = el('div', isOriginal ? 'track track-original' : 'track'); row.style.setProperty('--track-color', color);
    const label = el('div'); label.append(el('div', 'track-name', track.name[0].toUpperCase() + track.name.slice(1)),
      el('div', 'track-detail', `${track.buffer.numberOfChannels === 1 ? 'MONO' : 'STEREO'} · ${time(track.buffer.duration)}`));
    if (track.file === 'guitar.wav') {
      const split = el('button', 'split-guitar');
      split.type = 'button'; split.title = 'Split into lead and rhythm';
      split.setAttribute('aria-label', 'Split into lead and rhythm');
      split.dataset.splitGuitar = ''; split.disabled = !!jobRunning();
      split.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h5c4 0 3-7 7-7h4M9 12c4 0 3 7 7 7h4M17 2l3 3-3 3M17 16l3 3-3 3"/></svg>';
      const projectId = selected;
      const projectRoot = state.root;
      split.onclick = async () => {
        split.disabled = true;
        try { await api(`${projectUrl(projectId)}/split-guitar`, {root: projectRoot}); notice(); await refresh(); }
        catch (error) { notice(error.message, 'error'); split.disabled = !!jobRunning(); }
      };
      label.querySelector('.track-name').append(split);
    }
    const wave = el('div', 'wave-wrap'); const canvas = el('canvas'); canvas.setAttribute('aria-hidden', 'true');
    wave.append(canvas, el('span', 'playhead'));
    wave.onclick = event => {
      if (!player.duration) return;
      const box = wave.getBoundingClientRect();
      player.seek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * player.duration).catch(e => notice(e.message, 'error'));
    };
    const controls = el('div', 'track-controls');
    for (const [key, text] of [['muted', 'M'], ['solo', 'S']]) {
      const button = el('button', '', text);
      button.setAttribute('aria-label', `${key === 'muted' ? 'Mute' : 'Solo'} ${track.name}`);
      button.setAttribute('aria-pressed', String(track[key]));
      button.onclick = () => { track[key] = !track[key]; player.updateMix(); syncTrackControls(); };
      button.dataset.control = key; controls.append(button);
    }
    const range = el('input'); range.type = 'range'; range.min = 0; range.max = 1; range.step = .01; range.value = track.volume;
    range.setAttribute('aria-label', `${track.name} volume`);
    const value = el('span', 'volume-value', `${Math.round(track.volume * 100)}%`);
    range.oninput = () => { track.volume = Number(range.value); value.textContent = `${Math.round(track.volume * 100)}%`; player.updateMix(); };
    controls.append(range, value); row.append(label, wave, controls); $('tracks').append(row);
    drawWave(canvas, track.buffer, color);
  }
  syncTrackControls();
}
function syncTrackControls() {
  [...$('tracks').children].forEach((row, i) => {
    const track = player.tracks[i];
    row.classList.toggle('muted', player.trackGain(track) === 0);
    row.querySelector('[data-control=muted]').setAttribute('aria-pressed', String(track.muted));
    row.querySelector('[data-control=solo]').setAttribute('aria-pressed', String(track.solo));
  });
}
function animate() {
  const position = player.position();
  $('elapsed').textContent = time(position);
  if (document.activeElement !== $('seek')) $('seek').value = position;
  $('play').dataset.state = player.starting ? 'starting' : player.playing ? 'playing' : 'paused';
  $('play').setAttribute('aria-label', player.starting ? 'Cancel playback start' : player.playing ? 'Pause' : 'Play');
  document.querySelectorAll('.playhead').forEach(p => p.style.left = `${player.duration ? position / player.duration * 100 : 0}%`);
  requestAnimationFrame(animate);
}

/* ---------- edit / delete ---------- */
function fields(prefix) {
  const data = Object.fromEntries(['title', 'artist', 'album', 'year'].map(key => [key, $(`${prefix}-${key}`).value]));
  if (lookupSelections[prefix]) data.lookup_token = lookupSelections[prefix];
  return data;
}
$('edit-open').onclick = () => {
  const p = activeProject(); if (!p) return; editing = {id: p.id, root: state.root};
  resetLookup('edit');
  for (const key of ['title', 'artist', 'album', 'year']) $(`edit-${key}`).value = p[key] || '';
  $('edit-error').textContent = ''; $('edit-dialog').showModal();
};
$('edit-form').onsubmit = async e => {
  e.preventDefault();
  if (!editing) return;
  const target = editing;
  try { await api(`${projectUrl(target.id)}/metadata`, {...fields('edit'), root: target.root}); $('edit-dialog').close(); await refresh(); }
  catch (error) { $('edit-error').textContent = error.message; }
};
$('delete-open').onclick = () => {
  const project = activeProject(); if (!project) return;
  deleting = {id: project.id, root: state.root};
  $('delete-name').textContent = project.title;
  $('delete-path').textContent = `${state.root}${sep()}${project.id}`;
  $('delete-error').textContent = ''; $('delete-dialog').showModal();
};
$('delete-form').onsubmit = async event => {
  event.preventDefault(); if (!deleting) return;
  const target = deleting; $('delete-submit').disabled = true;
  try {
    await api(`${projectUrl(target.id)}/delete`, {root: target.root});
    $('delete-dialog').close();
    if (selected === target.id && state.root === target.root) show('library');
    await refresh(); notice('Song deleted.');
  } catch (error) { $('delete-error').textContent = error.message; }
  finally { $('delete-submit').disabled = false; }
};

/* ---------- transport ---------- */
$('play').onclick = () => player.playing || player.starting ? player.pause() : player.play().catch(e => notice(e.message, 'error'));
$('restart').onclick = () => player.seek(0).catch(e => notice(e.message, 'error'));
$('seek').oninput = () => { $('elapsed').textContent = time(Number($('seek').value)); };
$('seek').onchange = () => player.seek(Number($('seek').value)).catch(e => notice(e.message, 'error'));
$('master-volume').oninput = () => player.setVolume(Number($('master-volume').value));
function showSpeed() {
  const percent = Number($('playback-speed').value);
  $('speed-value').textContent = `${percent}%`;
  $('playback-speed').setAttribute('aria-valuetext', `${percent} percent of original speed`);
}
$('playback-speed').oninput = showSpeed;
$('playback-speed').onchange = () => {
  showSpeed();
  player.setPlaybackRate(Number($('playback-speed').value) / 100).catch(e => notice(e.message, 'error'));
};
$('reset-speed').onclick = () => {
  $('playback-speed').value = 100; showSpeed();
  player.setPlaybackRate(1).catch(e => notice(e.message, 'error'));
};
$('reset-mix').onclick = () => { for (const t of player.tracks) { t.muted = false; t.solo = false; t.volume = 1; } player.updateMix(); renderTracks(); };
document.addEventListener('keydown', e => {
  if (view === 'song' && e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName) && !document.querySelector('dialog[open]')) {
    e.preventDefault(); $('play').click();
  }
});
window.addEventListener('resize', () => { if (player.tracks.length) { renderTracks(); syncTrackControls(); } });

/* ---------- Desktop window chrome (frameless pywebview only) ---------- */
// Routed through our own HTTP API (POST/GET /api/window/<action>), same as everything
// else in this app, rather than pywebview's JS bridge: window.pywebview never actually
// shows up on this page in practice, so that bridge can't be relied on for something
// this basic.
function windowAction(action, data) { return api(`/api/window/${action}`, data || {}).catch(error => notice(error.message, 'error')); }

// Drag-to-move and drag-to-resize both work the same way: on mousedown, grab the
// window's current bounds once; on every (rAF-throttled) mousemove after that, compute
// the new bounds from the cursor's screen-space delta and send them. This replaces the
// classic WM_SYSCOMMAND/HTCAPTION "hand the drag to the OS" trick, which doesn't work
// reliably through a Chromium-based webview (its own mouse capture gets in the way) —
// confirmed here: it simply never moved the window.
function trackDrag(downEvent, onFrame) {
  if (downEvent.button !== 0) return;
  downEvent.preventDefault();
  const startX = downEvent.screenX, startY = downEvent.screenY;
  let raf = null, pending = null;
  const flush = () => { raf = null; if (pending) { onFrame(pending); pending = null; } };
  const onMove = event => {
    pending = {dx: event.screenX - startX, dy: event.screenY - startY};
    if (raf === null) raf = requestAnimationFrame(flush);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (raf !== null) cancelAnimationFrame(raf);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

async function startWindowMove(downEvent) {
  const start = await windowAction('bounds');
  if (!start) return;
  trackDrag(downEvent, ({dx, dy}) => windowAction('move', {x: start.x + dx, y: start.y + dy}));
}

async function startWindowResize(downEvent, dir) {
  const start = await windowAction('bounds');
  if (!start) return;
  trackDrag(downEvent, ({dx, dy}) => {
    let width = start.width, height = start.height;
    if (dir.includes('e')) width += dx;
    if (dir.includes('w')) width -= dx;
    if (dir.includes('s')) height += dy;
    if (dir.includes('n')) height -= dy;
    windowAction('resize', {width, height, direction: dir});
  });
}

function initTitlebar() {
  // The desktop app loads this page with ?native=1 (see ui_entrypoint.py); that alone,
  // checked synchronously, decides whether this bar (and the resize edges) show at all.
  if (new URLSearchParams(location.search).get('native') !== '1') return;
  $('titlebar').hidden = false;
  $('resize-edges').hidden = false;
  document.body.classList.add('has-titlebar');

  const drag = document.querySelector('.titlebar-drag');
  drag.addEventListener('mousedown', event => startWindowMove(event));
  drag.addEventListener('dblclick', () => $('win-max').click());  // OS-standard convention

  document.querySelectorAll('.redge').forEach(edge => {
    edge.addEventListener('mousedown', event => startWindowResize(event, edge.dataset.dir));
  });

  $('win-min').onclick = () => windowAction('minimize');
  $('win-max').onclick = async () => {
    if ($('win-max').disabled) return;  // ignore a second click while one is in flight
    $('win-max').disabled = true;
    const result = await windowAction('toggle-maximize');
    const maximized = !!result?.maximized;
    $('win-max').classList.toggle('is-restore', maximized);
    $('win-max').title = $('win-max').ariaLabel = maximized ? 'Restore' : 'Maximize';
    $('win-max').disabled = false;
  };
  $('win-close').onclick = () => windowAction('close');
}
initTitlebar();

$('theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sound-razor-theme', next); } catch (_) { /* private mode etc. */ }
  $('theme-toggle').title = $('theme-toggle').ariaLabel = next === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
};
$('theme-toggle').title = $('theme-toggle').ariaLabel = document.documentElement.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';

async function poll() {
  try { await refresh(); } catch (error) { notice(`Connection problem: ${error.message}`, 'error'); }
  setTimeout(poll, jobRunning() ? 1000 : 2500);
}
poll(); animate();

/* ---------- MusicBrainz lookup (edit dialog) ---------- */
function resetLookup(prefix) {
  lookupEpoch[prefix]++;
  lookupSelections[prefix] = null;
  const panel = $(`${prefix}-lookup-results`);
  if (panel) { panel.replaceChildren(); panel.hidden = true; }
  const status = $(`${prefix}-lookup-status`);
  if (status) status.textContent = '';
  const button = $(`${prefix}-lookup`);
  if (button) button.disabled = false;
  $(`${prefix}-form`).querySelector('[type=submit]').disabled = false;
}

for (const prefix of ['edit']) {
  const form = $(`${prefix}-form`);
  const box = el('div', 'metadata-lookup');
  const find = el('button', 'secondary', 'Find details & cover'); find.type = 'button'; find.id = `${prefix}-lookup`;
  const help = el('p', 'lookup-help', 'Search by song title, artist and album. Only this text is sent to MusicBrainz. Review a match before saving.');
  const status = el('p', 'lookup-status'); status.id = `${prefix}-lookup-status`; status.setAttribute('role', 'status');
  const results = el('div', 'lookup-results'); results.id = `${prefix}-lookup-results`; results.hidden = true;
  box.append(find, help, status, results);
  form.insertBefore(box, form.querySelector('[type=submit]'));
  for (const key of ['title', 'artist', 'album']) $(`${prefix}-${key}`).addEventListener('input', () => resetLookup(prefix));
  form.closest('dialog').addEventListener('close', () => resetLookup(prefix));
  find.onclick = async () => {
    resetLookup(prefix);
    const epoch = ++lookupEpoch[prefix];
    find.disabled = true; status.textContent = 'Searching MusicBrainz…';
    try {
      const data = await api('/api/metadata/search', fields(prefix));
      if (epoch !== lookupEpoch[prefix]) return;
      status.textContent = data.matches.length ? 'Choose a match to fill the fields. You can edit them before saving.' : 'No matches. Check the title and artist, or try removing the album.';
      results.hidden = !data.matches.length;
      for (const match of data.matches) {
        const card = el('div', 'lookup-match');
        card.append(el('strong', '', `${match.title} — ${match.artist}`));
        card.append(el('p', '', [match.album, match.year, match.type, match.edition, match.recording_note].filter(Boolean).join(' · ')));
        const source = el('a', 'lookup-source', 'MusicBrainz');
        source.href = `https://musicbrainz.org/release/${encodeURIComponent(match.release_id)}`; source.target = '_blank'; source.rel = 'noopener noreferrer';
        const choose = el('button', 'text-button', 'Use this match'); choose.type = 'button';
        choose.onclick = async () => {
          const selectionEpoch = ++lookupEpoch[prefix];
          results.querySelectorAll('button').forEach(b => b.disabled = true);
          find.disabled = true; form.querySelector('[type=submit]').disabled = true;
          status.textContent = 'Fetching album cover…';
          try {
            const prepared = await api('/api/metadata/prepare', {token: match.token});
            if (selectionEpoch !== lookupEpoch[prefix]) return;
            for (const key of ['title', 'artist', 'album', 'year']) if (prepared.fields[key]) $(`${prefix}-${key}`).value = prepared.fields[key];
            lookupSelections[prefix] = prepared.token;
            results.replaceChildren(); results.hidden = false;
            results.append(el('p', '', `${match.album} selected. Save to keep these details${prepared.has_cover ? ' and cover' : ''}.`));
            if (prepared.has_cover) {
              const response = await fetch(`/api/metadata/cover/${prepared.token}`, {headers: {'X-sound-razor-Token': token}});
              if (!response.ok) throw new Error('Cover preview unavailable. You can still save the selected details.');
              const url = URL.createObjectURL(await response.blob());
              if (selectionEpoch !== lookupEpoch[prefix]) { URL.revokeObjectURL(url); return; }
              const img = el('img', 'lookup-cover'); img.alt = `${match.album} cover`;
              img.onload = img.onerror = () => URL.revokeObjectURL(url); img.src = url; results.prepend(img);
            }
            status.textContent = prepared.warning || 'Details ready to save.';
          } catch (error) {
            if (selectionEpoch === lookupEpoch[prefix]) status.textContent = error.message;
          } finally {
            if (selectionEpoch === lookupEpoch[prefix]) {
              find.disabled = false; form.querySelector('[type=submit]').disabled = false;
              results.querySelectorAll('button').forEach(b => b.disabled = false);
            }
          }
        };
        card.append(source, choose); results.append(card);
      }
    } catch (error) { if (epoch === lookupEpoch[prefix]) status.textContent = error.message; }
    finally { if (epoch === lookupEpoch[prefix]) find.disabled = false; }
  };
}
