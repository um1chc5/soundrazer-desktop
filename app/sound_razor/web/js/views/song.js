import {$, activeProject, jobRunning, api, notice, projectUrl} from '../core.js';
import {store, nav} from '../store.js';
import {renderProgress} from '../progress.js';
import {pickerValue, pickerValid} from '../picker.js';
import {loadAudio} from '../audio.js';
import {coverImage} from '../covers.js';
/* ---------- song view ---------- */
export function renderSong() {
  const project = activeProject();
  if (store.view !== 'song' || !project) return;
  $('title').textContent = project.title;
  coverImage(document.querySelector('.record-art'), project);
  $('artist').textContent = project.artist || 'Unknown artist';
  $('album').textContent = [project.album, project.year].filter(Boolean).join(' · ');
  $('source-name').textContent = project.original || 'No original file';
  $('project-warning').textContent = project.warnings.join(' ');
  $('project-warning').hidden = !project.warnings.length;
  const job = store.state.job;
  const belongs = job && job.project === store.selected && job.kind !== 'youtube';
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
  $('resep-panel').hidden = busyHere || (hasStems && !store.resepOpen);
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
  const signature = JSON.stringify([store.state.root, project.id, project.stems, project.original]);
  if (signature !== store.audioSignature && !busyHere) {
    store.audioSignature = signature;
    loadAudio(project).catch(error => { if (error.name !== 'AbortError') notice(error.message, 'error'); });
  }
}
$('resep-open').onclick = () => { store.resepOpen = true; renderSong(); $('resep-panel').scrollIntoView({behavior: 'smooth', block: 'nearest'}); };
$('resep-close').onclick = () => { store.resepOpen = false; renderSong(); };
$('separate').onclick = async () => {
  if (!store.selected) return; $('separate').disabled = true;
  try { await api(`${projectUrl(store.selected)}/separate`, {root: store.state.root, ...pickerValue($('song-stems'))}); store.resepOpen = false; await nav.refresh(); }
  catch (error) { notice(error.message, 'error'); renderSong(); }
};
$('reveal').onclick = () => api(`${projectUrl(store.selected)}/reveal`, {root: store.state.root}).catch(e => notice(e.message, 'error'));

