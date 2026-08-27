var SETTINGS_STORAGE_KEY = 'engenh-settings';
var DEFAULT_SETTINGS = {
  autoSaveEnabled: false,
  autoSaveIntervalMs: 20000,
  showMapGrid: false,
  showCursorCoordinates: true,
  showInterfaceHints: true,
  confirmDeletes: true,
  enableSnapping: true,
  snapTolerance: 18,
  distanceUnits: 'metric',
  restoreLastProject: false,
  themeMode: 'light',
  iconSize: 'normal'
};
var settings = {...DEFAULT_SETTINGS};

/* ============================================================
   TEMA CLARO/ESCURO
   ============================================================ */
function applyTheme(themeMode){
  const resolved = themeMode === 'dark' ? 'dark' : 'light';
  settings.themeMode = resolved;
  if(resolved === 'dark'){
    document.documentElement.setAttribute('data-theme','dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('engenh-theme', resolved);
}

(function(){
  const saved = localStorage.getItem('engenh-theme');
  const initialMode = (saved === 'dark' || saved === 'light') ? saved : 'light';
  settings.themeMode = initialMode;
  applyTheme(initialMode);

  document.getElementById('theme-toggle').addEventListener('click', ()=>{
    const nextMode = settings.themeMode === 'dark' ? 'light' : 'dark';
    applyTheme(nextMode);
    if(typeof renderSettingsMenu === 'function') renderSettingsMenu();
  });
})();
