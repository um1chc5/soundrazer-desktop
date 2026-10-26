export const store = {
  state: {root: null, default_root: null, projects: [], job: null, now: 0, setup: null},
  view: 'new', selected: null, audioSignature: '', loading: 0, controller: null,
  busy: false, editing: null, deleting: null, browseParent: '', sourceMode: 'file',
  chosenFile: null, pending: null, resepOpen: false, announced: null,
  setupDeclined: false, setupYoutube: false, setupJobAnnounced: null, setupRunningStages: [],
  lookupSelections: {edit: null}, lookupEpoch: {edit: 0}, coverImages: new Map(),
};
export const nav = {show() {}, selectProject() {}, refresh() {}, render() {}};
