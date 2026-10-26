import {$} from './core.js';

function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('sound-razor-theme') || 'dark'; } catch (_) { /* private mode etc. */ }
  document.documentElement.dataset.theme = saved;
}
initTheme();

export function initThemeToggle() {
$('theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sound-razor-theme', next); } catch (_) { /* private mode etc. */ }
  $('theme-toggle').title = $('theme-toggle').ariaLabel = next === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
};
$('theme-toggle').title = $('theme-toggle').ariaLabel = document.documentElement.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';

}
