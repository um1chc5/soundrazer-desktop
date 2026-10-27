import {$} from './core.js';
import {t, onLangChange} from './i18n.js';

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
  $('theme-toggle').title = $('theme-toggle').ariaLabel = next === 'light' ? t('theme.toDark') : t('theme.toLight');
};
$('theme-toggle').title = $('theme-toggle').ariaLabel = document.documentElement.dataset.theme === 'light' ? t('theme.toDark') : t('theme.toLight');
onLangChange(() => { $('theme-toggle').title = $('theme-toggle').ariaLabel = document.documentElement.dataset.theme === 'light' ? t('theme.toDark') : t('theme.toLight'); });

}
