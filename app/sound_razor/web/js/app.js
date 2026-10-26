// Importing feature modules installs their DOM handlers; theme.js applies the saved theme first.
import {initThemeToggle} from './theme.js';
import {initNavigation} from './navigation.js';
import {initTitlebar} from './window.js';
import './transport.js';
import './dialogs.js';
import './folders.js';
import './lookup.js';
import {nav} from './store.js';
import {jobRunning, notice} from './core.js';
import {animate} from './audio.js';

// Late-bind the hooks only after every module has evaluated, then initialize the
// remaining page chrome before the initial state poll starts.
initNavigation();
initTitlebar();
initThemeToggle();

async function poll() {
  try { await nav.refresh(); } catch (error) { notice(`Connection problem: ${error.message}`, 'error'); }
  setTimeout(poll, jobRunning() ? 1000 : 2500);
}
poll(); animate();
