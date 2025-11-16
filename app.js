// app.js - Theme broadcast + offline "autocomplete on Tab" and settings helpers.
//
// Responsibilities:
//  - Apply saved theme on load and update the <meta name="theme-color">.
//  - Listen for theme changes via BroadcastChannel and service-worker messages and apply them live.
//  - Offer a small API for the settings page to set theme and broadcast changes.
//  - Keep the offline autocomplete-on-Tab implementation for the editor.

// ---------- Theme handling & cross-window live updates ----------
const THEME_KEY = 'or_theme';
const AUTOKEY = 'or_autocomplete_tab';
const BC_NAME = 'or-theme';

// Apply theme to document
function updateThemeMetaForMode(mode){
  const themeColorMeta = document.getElementById('themeColorMeta');
  if(!themeColorMeta) return;
  if(mode === 'dark'){ themeColorMeta.setAttribute('content', '#0f151a'); }
  else { themeColorMeta.setAttribute('content', '#ffffff'); }
}
function applyThemeValue(t){
  let mode = t;
  if(!t) t = localStorage.getItem(THEME_KEY) || 'system';
  if(t === 'system'){ mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  document.body.classList.remove('light','dark');
  document.body.classList.add(mode);
  updateThemeMetaForMode(mode);
}

// Broadcast changes to other contexts (BroadcastChannel + serviceWorker)
function broadcastThemeChange(themeValue){
  // BroadcastChannel first (preferred, fast)
  try{
    if('BroadcastChannel' in self){
      const bc = new BroadcastChannel(BC_NAME);
      bc.postMessage({ type: 'theme-change', theme: themeValue });
      // close quickly - recipients will still get it
      bc.close();
    }
  }catch(e){
    // ignore
  }

  // Also post message to ServiceWorker to let it forward to clients if needed
  if(navigator.serviceWorker && navigator.serviceWorker.controller){
    try{
      navigator.serviceWorker.controller.postMessage({ type: 'theme-change', theme: themeValue });
    }catch(e){}
  }

  // Also set localStorage (ensures storage events for other tabs that don't support BroadcastChannel)
  try { localStorage.setItem(THEME_KEY, themeValue); } catch(e){}
}

// Listen for incoming theme messages
function setupThemeListeners(){
  // BroadcastChannel listener (persistent on this page)
  if('BroadcastChannel' in self){
    try{
      const bc = new BroadcastChannel(BC_NAME);
      bc.onmessage = (ev) => {
        const d = ev.data || {};
        if(d && d.type === 'theme-change') applyThemeValue(d.theme);
      };
    }catch(e){}
  }

  // Service worker messages (SW can forward theme-change to clients)
  if(navigator.serviceWorker){
    navigator.serviceWorker.addEventListener && navigator.serviceWorker.addEventListener('message', (ev) => {
      const d = ev.data || {};
      if(d && d.type === 'theme-change') applyThemeValue(d.theme);
    });
  }

  // localStorage fallback for tabs (storage event)
  window.addEventListener('storage', (e) => {
    if(e.key === THEME_KEY && e.newValue){
      applyThemeValue(e.newValue);
    }
  });

  // If system preference changes and user selected "system", update active theme
  if(window.matchMedia){
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (ev) => {
      const cur = localStorage.getItem(THEME_KEY) || 'system';
      if(cur === 'system') applyThemeValue('system');
    });
  }
}

// Small API for settings page and others
function getThemeSetting(){ return localStorage.getItem(THEME_KEY) || 'system'; }
function setThemeSetting(v){
  localStorage.setItem(THEME_KEY, v);
  applyThemeValue(v);
  broadcastThemeChange(v);
}

// Initialize theme on load
document.addEventListener('DOMContentLoaded', ()=>{
  applyThemeValue(getThemeSetting());
  setupThemeListeners();
});

// ---------- Autocomplete-on-Tab (offline) ----------
function isAutocompleteEnabled(){
  const v = localStorage.getItem(AUTOKEY);
  if(v === null) return true;
  return v !== 'false';
}
function setAutocompleteEnabled(enabled){
  localStorage.setItem(AUTOKEY, enabled ? 'true' : 'false');
  try{ window.dispatchEvent(new CustomEvent('or:autocompleteChanged', {detail:{enabled}})); }catch(e){}
}

/* Build dictionary from notes */
function buildDictionarySync(){
  const raw = localStorage.getItem('or_notes');
  let map = {};
  try{ map = raw ? JSON.parse(raw) : {}; }catch(e){ map = {}; }
  const set = new Set();
  Object.values(map).flat().forEach(arr=>{
    (arr || []).forEach(n=>{
      if(!n) return;
      const text = (n.title||'') + ' ' + (n.text||'');
      const words = text.match(/[A-Za-z0-9_\-]{3,}/g);
      if(words) words.forEach(w => set.add(w));
    });
  });
  return set;
}

/* Find completion for prefix */
function findCompletion(prefix, dictSet){
  if(!prefix || prefix.length < 1) return null;
  const pref = prefix;
  const candidates = [];
  dictSet.forEach(w => {
    if(w.length <= pref.length) return;
    if(w.startsWith(pref)) candidates.push(w);
  });
  if(candidates.length === 0){
    const lower = pref.toLowerCase();
    dictSet.forEach(w => {
      if(w.length <= pref.length) return;
      if(w.toLowerCase().startsWith(lower)) candidates.push(w);
    });
  }
  if(candidates.length === 0) return null;
  candidates.sort((a,b) => (a.length - b.length) || a.localeCompare(b));
  return candidates[0];
}

function replaceRangeInInput(el, start, end, text, newSelectionOffset = 0){
  const val = el.value;
  const before = val.slice(0, start);
  const after = val.slice(end);
  el.value = before + text + after;
  const caret = before.length + text.length + newSelectionOffset;
  el.setSelectionRange(caret, caret);
  el.focus();
}

function attachAutocompleteToTextarea(textarea){
  if(!textarea) return;
  let dict = buildDictionarySync();

  window.addEventListener('storage', (e)=>{
    if(e.key === 'or_notes') dict = buildDictionarySync();
  });

  window.addEventListener('or:notesChanged', ()=> dict = buildDictionarySync());
  window.addEventListener('or:autocompleteChanged', ()=>{/* no-op */});

  const refreshDictFromCurrent = () => {
    const currWords = (textarea.value || '').match(/[A-Za-z0-9_\-]{3,}/g) || [];
    currWords.forEach(w => dict.add(w));
  };

  textarea.addEventListener('input', refreshDictFromCurrent);

  textarea.addEventListener('keydown', (ev) => {
    if(ev.key !== 'Tab') return;
    const enabled = isAutocompleteEnabled();
    if(!enabled) return;
    ev.preventDefault();

    const ta = textarea;
    const pos = ta.selectionStart;
    const val = ta.value;
    const left = val.slice(0, pos);
    const match = left.match(/([A-Za-z0-9_\-]{1,})$/);
    const prefix = match ? match[1] : '';

    if(!prefix){
      replaceRangeInInput(ta, pos, pos, '\t', 0);
      return;
    }

    const completion = findCompletion(prefix, dict);
    if(completion){
      replaceRangeInInput(ta, pos - prefix.length, pos, completion, 0);
      return;
    }
    replaceRangeInInput(ta, pos, pos, '\t', 0);
  });
}

// Attach to noteBody if present on load
document.addEventListener('DOMContentLoaded', ()=>{
  const noteTA = document.getElementById('noteBody');
  if(noteTA) attachAutocompleteToTextarea(noteTA);
});

// ---------- Expose API ----------
window.ORApp = {
  getThemeSetting,
  setThemeSetting,
  isAutocompleteEnabled,
  setAutocompleteEnabled,
  buildDictionarySync,
  findCompletion
};

// If service worker receives a message it will forward to clients; the SW code also does that.
// app.js listens to SW messages above via navigator.serviceWorker.addEventListener.