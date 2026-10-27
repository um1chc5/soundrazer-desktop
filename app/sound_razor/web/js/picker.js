import {STEMS, DEFAULT_STEMS} from './constants.js';
import {$, el} from './core.js';
import {nav} from './store.js';
import {t, onLangChange} from './i18n.js';
/* ---------- stem picker ---------- */
export function buildPicker(container) {
  container.replaceChildren();
  const presets = el('div', 'preset-cards');
  for (const [value, title, sub] of [['custom', 'picker.customTitle', 'picker.customSub'], ['vocals', 'picker.vocalsPresetTitle', 'picker.vocalsPresetSub']]) {
    const label = el('label', 'preset-card');
    const input = el('input'); input.type = 'radio'; input.name = `${container.id}-preset`; input.value = value; input.checked = value === 'custom';
    label.append(input, el('strong', '', t(title)), el('small', '', t(sub)));
    presets.append(label);
  }
  const grid = el('fieldset', 'stem-grid');
  grid.append(el('legend', 'sr-only', t('picker.selectStemsLegend')));
  for (const [value, name, color] of STEMS) {
    const label = el('label', 'stem-option'); label.style.setProperty('--c', color);
    const input = el('input'); input.type = 'checkbox'; input.value = value; input.checked = DEFAULT_STEMS.includes(value);
    label.append(input, el('span', 'stem-dot'), el('span', 'stem-label', t(name)));
    grid.append(label);
  }
  const help = el('p', 'hint', t('picker.hint', {other: t('stem.other')}));
  container.append(presets, grid, help);
  container.onchange = () => { syncPicker(container); nav.render(); };
  syncPicker(container);
  onLangChange(() => translatePicker(container));
}
function translatePicker(container) {
  const presetDefs = [['custom', 'picker.customTitle', 'picker.customSub'], ['vocals', 'picker.vocalsPresetTitle', 'picker.vocalsPresetSub']];
  container.querySelectorAll('.preset-card').forEach((label, i) => {
    label.querySelector('strong').textContent = t(presetDefs[i][1]);
    label.querySelector('small').textContent = t(presetDefs[i][2]);
  });
  container.querySelector('.stem-grid legend').textContent = t('picker.selectStemsLegend');
  container.querySelectorAll('.stem-option').forEach((label, i) => { label.querySelector('.stem-label').textContent = t(STEMS[i][1]); });
  container.querySelector('.hint').textContent = t('picker.hint', {other: t('stem.other')});
}
export function syncPicker(container) {
  const custom = pickerValue(container).preset === 'custom';
  container.querySelector('.stem-grid').hidden = !custom;
  container.querySelector('.hint').hidden = !custom;
}
export function pickerValue(container) {
  return {preset: container.querySelector('input[type=radio]:checked').value,
    stems: [...container.querySelectorAll('.stem-grid input:checked')].map(input => input.value)};
}
export function pickerValid(container) {
  const value = pickerValue(container);
  return value.preset === 'vocals' || value.stems.length > 0;
}
buildPicker($('new-stems'));
buildPicker($('song-stems'));

