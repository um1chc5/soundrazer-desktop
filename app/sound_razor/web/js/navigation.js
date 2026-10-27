import {$, notice, api, jobRunning, activeProject, setClockSkew} from './core.js';
import {store, nav} from './store.js';
import {clearAudio} from './audio.js';
import {renderNew, continuePending} from './views/new.js';
import {renderLibrary} from './views/library.js';
import {renderSong} from './views/song.js';
import {renderSetup, renderSetupView, renderSetupBanner} from './views/setup.js';
import {t, onLangChange} from './i18n.js';
function clearSongTrim() {
  store.songTrimEditor?.destroy();
  store.songTrimEditor = null;
  store.songTrimRange = null;
  store.songTrimKey = '';
  $('song-trim-chip').replaceChildren();
  $('song-trim-chip').hidden = true;
}
/* ---------- views ---------- */
export function show(name) {
  if (store.state.setup?.required && !store.setupDeclined && name !== 'setup') name = 'setup';
  store.view = name;
  for (const v of ['new', 'library', 'song', 'setup']) $(`view-${v}`).hidden = v !== name;
  $('tab-new').setAttribute('aria-selected', String(name === 'new'));
  $('tab-library').setAttribute('aria-selected', String(name === 'library' || name === 'song'));
  if (name !== 'song') { store.selected = null; store.audioSignature = ''; clearSongTrim(); clearAudio(); }
  render();
}
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
  if (store.state.setup?.required && !store.setupDeclined) { show('setup'); return; }
  show(tab.dataset.view);
});
$('back').onclick = () => show('library');
export function selectProject(id) {
  if (store.state.setup?.required && !store.setupDeclined) { notice(t('setup.completeFirst'), 'error'); show('setup'); return; }
  if (store.selected === id && store.view === 'song') return;
  clearSongTrim();
  store.selected = id; store.resepOpen = false; store.view = 'song';
  for (const v of ['new', 'library', 'song']) $(`view-${v}`).hidden = v !== 'song';
  $('tab-new').setAttribute('aria-selected', 'false'); $('tab-library').setAttribute('aria-selected', 'true');
  $('song-stems').dataset.preset = '';
  render();
}

export function render() {
  // Route to setup for real (toggling which view is actually visible) rather than just
  // setting the `view` variable: that was the bug — it fooled later checks in this same
  // function (like the banner's `view !== 'setup'`) into thinking the user was already
  // looking at the setup screen, while the DOM still showed the normal "Separate" view
  // underneath, with no banner either, on top of a plain page load not calling show()
  // (and so never running this gate at all) — so first-run setup never actually appeared.
  if (store.state.setup?.required && !store.setupDeclined && store.view !== 'setup') { show('setup'); return; }
  renderChrome(); renderNew(); renderLibrary(); renderSong(); renderSetup(); renderSetupView(); renderSetupBanner();
}
export function renderChrome() {
  $('project-count').textContent = store.state.projects.length;
  const job = store.state.job, pill = $('job-pill');
  pill.hidden = !jobRunning();
  if (jobRunning()) {
    const what = job.kind === 'youtube' ? t('nav.downloading') : job.kind === 'setup' ? t('nav.settingUp') : job.kind === 'export' ? t('nav.exporting') : job.guitar_split ? t('nav.splittingGuitar') : t('nav.separating');
    $('job-pill-text').textContent = t('nav.jobPillText', {what, pct: Math.floor(job.progress || 0)});
  }
}
$('job-pill').onclick = () => { const job = store.state.job; if (job?.project) selectProject(job.project); else show('new'); };

export async function refresh() {
  const next = await api('/api/state');
  setClockSkew(next.now - Date.now() / 1000);
  const rootChanged = store.state.root !== next.root;
  Object.assign(store.state, next);
  if (store.view === 'song' && (rootChanged || !activeProject())) { show(rootChanged ? 'new' : 'library'); return; }
  continuePending();
  announce();
  render();
}
export function announce() {
  const job = store.state.job;
  if (!job || job.kind === 'youtube' || store.announced === job.id) return;
  if (job.status === 'succeeded') {
    store.announced = job.id;
    if (job.kind === 'setup') {
      notice(t('setup.complete'), 'success');
      store.setupJobAnnounced = job.id;
      show('new');
      return;
    }
    if (job.kind === 'export') {
      const labels = {flac: 'FLAC', mp3: 'MP3', opus: 'Opus', m4a: 'M4A', wav16: 'WAV', aiff: 'AIFF'};
      notice(t('nav.exportedNotice', {count: job.stems.length, formats: (job.formats || []).map(f => labels[f] || f).join(', ')}), 'success');
      return;
    }
    const p = store.state.projects.find(x => x.id === job.project);
    notice(t('nav.songReadyNotice', {title: p?.title || t('nav.defaultSongTitle'), count: job.stems.length}), 'success');
  }
}


export function initNavigation() {
  Object.assign(nav, {show, selectProject, refresh, render});
  onLangChange(render);
}
