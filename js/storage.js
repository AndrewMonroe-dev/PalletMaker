/* Persistence layer: everything lives in localStorage, keyed under one root object. */

const STORAGE_KEY = 'palletmaker_state_v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch (e) {
    console.error('Failed to load PalletMaker state, starting fresh.', e);
    return defaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function defaultState() {
  return {
    itemTypes: [],
    cases: [],
    projects: [],
    activeProjectId: null
  };
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
