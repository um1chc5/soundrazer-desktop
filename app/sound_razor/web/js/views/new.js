import {AUDIO_EXTENSIONS} from '../constants.js';
import {$, el, notice, stem, api, sep, projectUrl, jobRunning, token} from '../core.js';
import {store, nav} from '../store.js';
import {pickerValue, pickerValid} from '../picker.js';
import {renderProgress} from '../progress.js';
/* ---------- new separation ---------- */
export function setSource(mode) {
  store.sourceMode = mode;
  $('src-file').setAttribute('aria-selected', String(mode === 'file'));
  $('src-yt').setAttribute('aria-selected', String(mode === 'youtube'));
  $('pane-file').hidden = mode !== 'file'; $('pane-yt').hidden = mode !== 'youtube';
  renderNew();
}
$('src-file').onclick = () => setSource('file');
$('src-yt').onclick = () => setSource('youtube');
export function chooseFile(file) {
  if (!file) return;
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) { notice(`${file.name} is not a supported audio file.`, 'error'); return; }
  store.chosenFile = file; $('start-error').textContent = '';
  $('new-title').placeholder = stem(file.name).replaceAll('_', ' ');
  renderNew();
}
$('audio-file').onchange = () => chooseFile($('audio-file').files[0]);
$('file-clear').onclick = () => { store.chosenFile = null; $('audio-file').value = ''; $('new-title').placeholder = 'Uses the file name'; renderNew(); };
const zone = $('dropzone');
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragging'); chooseFile(e.dataTransfer.files[0]); });
$('youtube-url').oninput = () => renderNew();

export function renderNew() {
  $('dropzone').hidden = !!store.chosenFile; $('file-card').hidden = !store.chosenFile;
  if (store.chosenFile) {
    $('file-name').textContent = store.chosenFile.name;
    $('file-meta').textContent = `${(store.chosenFile.size / 1048576).toFixed(1)} MB · ${(store.chosenFile.name.split('.').pop() || '').toUpperCase()}`;
  }
  $('root-label').textContent = store.state.root || 'No folder selected';
  $('root-label').title = store.state.root || '';
  const isDefault = store.state.root && store.state.root === store.state.default_root;
  $('root-default').hidden = !isDefault;
  $('folder-default').hidden = !store.state.default_root || isDefault;
  const name = store.sourceMode === 'file' ? (store.chosenFile ? stem(store.chosenFile.name) : '<song name>') : '<video title>';
  $('output-preview').textContent = store.state.root ? `→ ${store.state.root}${sep()}${name}${sep()}stems` : '';
  const youtube = store.state.job?.kind === 'youtube' ? store.state.job : null;
  const showYt = !!youtube && (jobRunning() || (store.pending && store.pending.jobId === youtube.id) || youtube.status === 'failed' && store.pending?.failed === youtube.id);
  $('yt-panel').hidden = !showYt;
  if (showYt) renderProgress($('yt-panel'), youtube);
  const ready = store.sourceMode === 'file' ? !!store.chosenFile : /^https?:\/\/\S+/.test($('youtube-url').value.trim());
  $('start').disabled = !ready || !store.state.root || store.busy || !!jobRunning() || !pickerValid($('new-stems'));
  $('start').textContent = jobRunning() && !store.busy ? 'Another job is running…' : store.busy ? 'Starting…' : 'Start separation';
  $('folder-open').disabled = store.busy || !!jobRunning();
  $('folder-default').disabled = store.busy || !!jobRunning();
}
export function newFields() {
  return Object.fromEntries(['title', 'artist', 'album', 'year'].map(key => [key, $(`new-${key}`).value.trim()]));
}

export function upload(file, data) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({...data, filename: file.name, root: store.state.root});
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
  if (store.busy || jobRunning()) return;
  if (store.state.setup?.required) { notice('Complete the one-time setup first.', 'error'); return; }
  const choice = pickerValue($('new-stems'));
  store.busy = true; $('start-error').textContent = ''; renderNew();
  try {
    if (store.sourceMode === 'file') {
      $('upload-box').hidden = false; $('upload-progress').value = 0; $('upload-pct').textContent = '0%';
      const project = await upload(store.chosenFile, newFields());
      await api(`${projectUrl(project.id)}/separate`, {root: store.state.root, ...choice});
      store.chosenFile = null; $('audio-file').value = ''; for (const k of ['title', 'artist', 'album', 'year']) $(`new-${k}`).value = '';
      await nav.refresh(); nav.selectProject(project.id);
    } else {
      const job = await api('/api/import-youtube', {...newFields(), url: $('youtube-url').value.trim(), root: store.state.root});
      store.pending = {jobId: job.id, ...choice};
      await nav.refresh();
    }
  } catch (error) { $('start-error').textContent = error.message; }
  finally { store.busy = false; $('upload-box').hidden = true; renderNew(); }
};
export async function continuePending() {
  const job = store.state.job;
  if (!store.pending || !job || job.id !== store.pending.jobId) return;
  if (job.status === 'succeeded' && job.project) {
    const {preset, stems} = store.pending; store.pending = null;
    $('youtube-url').value = '';
    try { await api(`${projectUrl(job.project)}/separate`, {root: store.state.root, preset, stems}); await nav.refresh(); nav.selectProject(job.project); }
    catch (error) { notice(error.message, 'error'); await nav.refresh(); nav.selectProject(job.project); }
  } else if (['failed', 'cancelled'].includes(job.status)) {
    store.pending = {failed: job.id};
  }
}
