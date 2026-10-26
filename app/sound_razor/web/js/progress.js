import {SETUP_STEPS, YOUTUBE_STEPS, GUITAR_STEPS, SEPARATION_STEPS, EXPORT_STEPS, SETUP_STAGE_LABEL, SETUP_PHASE_TITLE, SETUP_PHASE_SUB} from './constants.js';
import {$, el, api, notice, serverNow, duration} from './core.js';
import {store, nav} from './store.js';
/* ---------- progress view ---------- */
export function buildProgress(panel) {
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
    try { await api('/api/cancel', {}); await nav.refresh(); } catch (error) { notice(error.message, 'error'); }
  };
}
buildProgress($('job-panel'));
buildProgress($('yt-panel'));
export const CIRCUMFERENCE = 2 * Math.PI * 52;

export function renderProgress(panel, job) {
  const youtube = job.kind === 'youtube';
  const setup = job.kind === 'setup';
  const exportJob = job.kind === 'export';
  const steps = setup ? SETUP_STEPS : youtube ? YOUTUBE_STEPS : exportJob ? EXPORT_STEPS : job.guitar_split ? GUITAR_STEPS : SEPARATION_STEPS;
  const running = ['running', 'cancelling'].includes(job.status);
  const phase = setup ? job.phase : job.status === 'succeeded' ? 'done' : job.phase === 'download' && !youtube ? 'load' : job.phase;
  const progress = job.status === 'succeeded' ? 100 : Math.max(0, Math.min(100, job.progress || 0));
  panel.dataset.status = job.status;
  panel.classList.toggle('busy', running && (setup ? true : youtube ? progress === 0 : phase !== 'separate' && phase !== 'export'));
  panel.querySelector('.pv-num').textContent = Math.floor(progress);
  panel.querySelector('.pv-bar').style.strokeDasharray = `${CIRCUMFERENCE}`;
  panel.querySelector('.pv-bar').style.strokeDashoffset = `${CIRCUMFERENCE * (1 - progress / 100)}`;
  panel.querySelector('.pv-linebar i').style.width = `${progress}%`;
  let title, sub;
  if (setup) {
    const stage = job.stage; const what = stage ? ` ${SETUP_STAGE_LABEL[stage] || ''}` : '';
    const phaseTitles = {...SETUP_PHASE_TITLE, download: `Downloading${what}`, install: `Installing${what}`};
    const phaseSubs = {...SETUP_PHASE_SUB};
    title = job.status === 'cancelling' ? 'Stopping…' : running ? phaseTitles[phase] || 'Working…' : (job.status === 'succeeded' ? 'Setup complete' : 'Setup failed');
    sub = running ? phaseSubs[phase] || '' : job.error || (job.status === 'succeeded' ? 'You can separate tracks now.' : '');
  } else if (exportJob) {
    const titles = {prepare: 'Preparing export', export: 'Converting stems', finalize: 'Writing exports'};
    const ended = {succeeded: 'Export complete', failed: 'Export failed', cancelled: 'Cancelled'};
    title = job.status === 'cancelling' ? 'Stopping…' : running ? titles[phase] || 'Working…' : ended[job.status];
    sub = running ? 'Lossless and lossy copies stay inside this project.' : job.error || (job.status === 'succeeded' ? 'Your exported copies are ready.' : '');
  } else {
    const titles = {prepare: job.guitar_split ? 'Loading the guitar model' : 'Preparing audio', load: job.phase === 'download' ? 'Downloading AI model' : 'Loading AI model',
      download: 'Downloading from YouTube', separate: job.guitar_split ? 'Splitting guitar into lead & rhythm' : 'Separating stems', finalize: youtube ? 'Creating project' : 'Saving stems'};
    const subs = {prepare: 'Converting to 44.1 kHz stereo WAV', load: job.phase === 'download' ? 'First run only, this can take a few minutes' : 'Getting the neural network ready',
      download: 'Fetching the best audio stream', separate: 'The AI model is working through your track', finalize: 'Almost done'};
    const ended = {succeeded: youtube ? 'Download complete' : 'Separation complete', failed: youtube ? 'Download failed' : 'Separation failed', cancelled: 'Cancelled'};
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
export function renderTimers(panel, job) {
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
  const job = store.state.job; if (!job) return;
  for (const panel of [$('job-panel'), $('yt-panel')]) if (!panel.hidden) renderTimers(panel, job);
}, 500);

