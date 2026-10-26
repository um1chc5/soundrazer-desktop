import {STEMS, DEFAULT_STEMS} from './constants.js';
import {$, el} from './core.js';
import {nav} from './store.js';
/* ---------- stem picker ---------- */
export function buildPicker(container) {
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
  container.onchange = () => { syncPicker(container); nav.render(); };
  syncPicker(container);
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

