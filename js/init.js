/* === INIT SEQUENCE === */
/* Sequência de arranque da aplicação.
   Extraída de 05-app-main.js linhas 3036-3041.
   Este ficheiro deve ser o ÚLTIMO a ser carregado após todos os módulos. */
(function(){
  loadSettings();
  initMap();
  initializeWorkspaces();
  if(settings.autoSaveEnabled) enableAutoSave();
  maybeRestoreLastProjectOnStartup();
  initTeamUI();
})();
