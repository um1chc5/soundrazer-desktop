import {$, el, jobRunning, notice} from '../core.js';
import {store, nav} from '../store.js';
import {coverImage} from '../covers.js';
/* ---------- library ---------- */
export function renderLibrary() {
  $('library-folder').textContent = store.state.root || 'no folder';
  if (store.view !== 'library') return;
  const list = $('library'); list.replaceChildren();
  const query = $('search').value.toLowerCase();
  const projects = store.state.projects.filter(p => `${p.title} ${p.artist} ${p.album}`.toLowerCase().includes(query));
  for (const project of projects) {
    const card = el('button', 'song-card');
    const art = el('span', 'card-art');
    art.style.setProperty('--h', [...project.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7));
    art.append(el('span', 'card-initial', (project.title || '?').trim().charAt(0).toUpperCase()));
    coverImage(art, project);
    const job = store.state.job;
    let badge;
    if (job && job.project === project.id && jobRunning()) badge = el('span', 'badge badge-live', `Processing ${Math.floor(job.progress || 0)}%`);
    else if (project.stems.length) badge = el('span', 'badge badge-ok', `${project.stems.length} stems`);
    else badge = el('span', 'badge', 'Not separated');
    const text = el('span', 'card-text');
    text.append(el('strong', '', project.title), el('small', '', project.artist || 'Unknown artist'));
    card.append(art, text, badge);
    card.onclick = () => nav.selectProject(project.id);
    list.append(card);
  }
  if (!projects.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', query ? 'No matching songs' : 'No songs yet'),
      el('p', '', query ? 'Try a different search.' : 'Separate your first song and it will appear here.'));
    if (!query) { const go = el('button', 'btn btn-primary btn-sm', 'Separate a song'); go.onclick = () => nav.show('new'); empty.append(go); }
    list.append(empty);
  }
}
$('search').oninput = renderLibrary;
$('refresh').onclick = () => nav.refresh().catch(e => notice(e.message, 'error'));

