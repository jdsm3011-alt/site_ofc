/* === INIT SEQUENCE === */
/* Sequência de arranque da aplicação.
   Extraída de 05-app-main.js linhas 3036-3041.
   Este ficheiro deve ser o ÚLTIMO a ser carregado após todos os módulos. */
(function(){
  console.debug('[init] init.js loaded');
  loadSettings();
  initMap();
  console.debug('[init] calling LiveFlights.init(map)', map);
  if (window.LiveFlights && typeof window.LiveFlights.init === 'function') {
    window.LiveFlights.init(map);
  } else {
    console.error('[init] LiveFlights is not available at startup');
  }
  if (window.LiveLayers && typeof window.LiveLayers.init === 'function') {
    window.LiveLayers.init(map);
  }
  initializeWorkspaces();
  if(settings.autoSaveEnabled) enableAutoSave();
  maybeRestoreLastProjectOnStartup();
  initTeamUI();
})();
