import {SETUP_STEPS, YOUTUBE_STEPS, GUITAR_STEPS, SEPARATION_STEPS, EXPORT_STEPS, SETUP_STAGE_LABEL, SETUP_PHASE_TITLE, SETUP_PHASE_SUB} from './constants.js';
import {$, el, api, notice, serverNow, duration} from './core.js';
import {store, nav} from './store.js';
import {t, onLangChange} from './i18n.js';
/* ---------- progress view ---------- */
export function buildProgress(panel) {
  panel.innerHTML = `
    <div class="pv-ring" aria-hidden="true">
      <svg viewBox="0 0 120 120"><defs><linearGradient id="${panel.id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#ff5c6c"/></linearGradient></defs>
        <circle class="pv-track" cx="60" cy="60" r="52"/><circle class="pv-bar" cx="60" cy="60" r="52" stroke="url(#${panel.id}-g)"/><circle class="pv-spin" cx="60" cy="60" r="52"/></svg>
      <div class="pv-pct"><span class="pv-num">0</span><small>%</small></div>
    </div>
    <div class="pv-body">
      <div class="pv-top"><div><h2 class="pv-title"></h2><p class="pv-sub"></p></div><button type="button" class="btn btn-ghost btn-sm pv-cancel"></button></div>
      <div class="pv-stats">
        <div><span class="eyebrow pv-eyebrow-left"></span><strong class="pv-eta">—</strong></div>
        <div><span class="eyebrow pv-eyebrow-elapsed"></span><strong class="pv-elapsed">0s</strong></div>
        <div><span class="eyebrow pv-eyebrow-stems"></span><strong class="pv-stems">—</strong></div>
      </div>
      <ol class="pv-steps"></ol>
      <div class="pv-linebar"><i></i></div>
      <details class="log-details"><summary class="pv-log-summary"></summary><pre class="log-output pv-log"></pre></details>
    </div>`;
  panel.querySelector('.pv-cancel').onclick = async event => {
    event.currentTarget.disabled = true;
    try { await api('/api/cancel', {}); await nav.refresh(); } catch (error) { notice(error.message, 'error'); }
  };
  applyProgressChrome(panel);
}
function applyProgressChrome(panel) {
  panel.querySelector('.pv-cancel').textContent = t('progress.cancel');
  panel.querySelector('.pv-eyebrow-left').textContent = t('progress.timeLeft');
  panel.querySelector('.pv-eyebrow-elapsed').textContent = t('progress.elapsed');
  panel.querySelector('.pv-eyebrow-stems').textContent = t('progress.stemsLabel');
  panel.querySelector('.pv-log-summary').textContent = t('progress.processLog');
}
buildProgress($('job-panel'));
buildProgress($('yt-panel'));
onLangChange(() => { for (const panel of [$('job-panel'), $('yt-panel')]) applyProgressChrome(panel); });
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
    const stage = job.stage; const stageLabel = stage ? t(SETUP_STAGE_LABEL[stage] || '') : '';
    const phaseTitles = {
      prepare: t(SETUP_PHASE_TITLE.prepare), finalize: t(SETUP_PHASE_TITLE.finalize),
      download: stage ? t('setup.phase.downloadingStage', {stage: stageLabel}) : t('setup.phase.downloading'),
      install: stage ? t('setup.phase.installingStage', {stage: stageLabel}) : t('setup.phase.installing'),
    };
    const phaseSubs = {prepare: t(SETUP_PHASE_SUB.prepare), download: t(SETUP_PHASE_SUB.download), install: t(SETUP_PHASE_SUB.install), finalize: t(SETUP_PHASE_SUB.finalize)};
    title = job.status === 'cancelling' ? t('progress.stopping') : running ? phaseTitles[phase] || t('progress.working') : (job.status === 'succeeded' ? t('setup.phase.completeTitle') : t('setup.phase.failedTitle'));
    sub = running ? phaseSubs[phase] || '' : job.error || (job.status === 'succeeded' ? t('setup.phase.readyNowSub') : '');
  } else if (exportJob) {
    const titles = {prepare: t('export.phase.prepare.title'), export: t('export.phase.export.title'), finalize: t('export.phase.finalize.title')};
    const ended = {succeeded: t('export.phase.complete'), failed: t('export.phase.failed'), cancelled: t('progress.cancelled')};
    title = job.status === 'cancelling' ? t('progress.stopping') : running ? titles[phase] || t('progress.working') : ended[job.status];
    sub = running ? t('export.phase.workingSub') : job.error || (job.status === 'succeeded' ? t('export.phase.readySub') : '');
  } else {
    const titles = {prepare: job.guitar_split ? t('sep.phase.prepareGuitar') : t('sep.phase.prepareNormal'), load: job.phase === 'download' ? t('sep.phase.downloadModel') : t('sep.phase.loadModel'),
      download: t('sep.phase.downloadYoutube'), separate: job.guitar_split ? t('sep.phase.separateGuitar') : t('sep.phase.separateNormal'), finalize: youtube ? t('sep.phase.finalizeYoutube') : t('sep.phase.finalizeNormal')};
    const subs = {prepare: t('sep.sub.prepare'), load: job.phase === 'download' ? t('sep.sub.loadDownloading') : t('sep.sub.load'),
      download: t('sep.sub.download'), separate: t('sep.sub.separate'), finalize: t('sep.sub.finalize')};
    const ended = {succeeded: youtube ? t('sep.ended.downloadComplete') : t('sep.ended.separationComplete'), failed: youtube ? t('sep.ended.downloadFailed') : t('sep.ended.separationFailed'), cancelled: t('progress.cancelled')};
    title = job.status === 'cancelling' ? t('progress.stopping') : running ? titles[phase] || t('progress.working') : ended[job.status];
    sub = running ? subs[phase] || '' : job.error || (job.status === 'succeeded' ? t('sep.readySub') : '');
  }
  panel.querySelector('.pv-title').textContent = title;
  panel.querySelector('.pv-sub').textContent = sub;
  const cancel = panel.querySelector('.pv-cancel');
  cancel.hidden = !running; cancel.disabled = job.status === 'cancelling';
  panel.querySelector('.pv-stems').textContent = setup || youtube ? '—' : (job.stems || []).length;
  const list = panel.querySelector('.pv-steps'); list.replaceChildren();
  const current = phase === 'done' ? steps.length : Math.max(0, steps.findIndex(([key]) => key === phase));
  steps.forEach(([key, label], index) => {
    const item = el('li', index < current || phase === 'done' ? 'done' : index === current && running ? 'active' : '', t(label));
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
    eta = left > 1 ? `~${duration(left)}` : t('progress.etaFewSeconds');
  } else if (running) eta = t('progress.etaEstimating');
  else if (job.status === 'succeeded') eta = t('progress.etaDone');
  panel.querySelector('.pv-eta').textContent = eta;
}
setInterval(() => {
  const job = store.state.job; if (!job) return;
  for (const panel of [$('job-panel'), $('yt-panel')]) if (!panel.hidden) renderTimers(panel, job);
}, 500);

