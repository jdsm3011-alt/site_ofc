/* === MÓDULO: SETTINGS === */
/* Cloud sync state, load/save settings, settings menu UI,
   cloud menu UI (render, open, close, toggle) */
/* Origem: 05-app-main.js linhas 506-1162 */
(function(){

/* ---------- cloud sync state ---------- */
function setCloudSyncState(mode, plan = null){
  cloudSyncMode = mode;
  cloudSyncPlan = plan;
  updateOnlineSyncButtonVisibility();
}

function clearCloudSyncState(){
  cloudSyncMode = null;
  cloudSyncPlan = null;
  updateOnlineSyncButtonVisibility();
}

function updateOnlineSyncButtonVisibility(){
  const syncButton = document.getElementById('btn-sync-online');
  const saveButton = document.getElementById('btn-save-project');
  if(!syncButton || !saveButton) return;
  const active = Boolean(teamState.connected && cloudSyncMode);
  const syncing = Boolean(teamState.connected && teamState.status === 'syncing');
  syncButton.classList.toggle('hidden', !active);
  syncButton.classList.toggle('is-active', active);
  syncButton.classList.toggle('is-syncing', syncing);
  saveButton.classList.toggle('hidden', active);
  syncButton.setAttribute('aria-busy', syncing ? 'true' : 'false');
}

let cloudDeleteInProgress = false;
let settingsMenuDirty = false;

/* ---------- load/save settings ---------- */
function loadSettings(){
  try{
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
    if(saved && typeof saved === 'object'){
      settings = {...DEFAULT_SETTINGS, ...saved};
    }
  }catch(err){
    console.warn('Não foi possível ler as definições guardadas.', err);
  }
  settings.autoSaveEnabled = Boolean(settings.autoSaveEnabled);
  settings.showMapGrid = Boolean(settings.showMapGrid);
  settings.showCursorCoordinates = settings.showCursorCoordinates !== false;
  settings.showInterfaceHints = settings.showInterfaceHints !== false;
  settings.confirmDeletes = settings.confirmDeletes !== false;
  settings.enableSnapping = settings.enableSnapping !== false;
  settings.snapTolerance = Number(settings.snapTolerance) || 18;
  settings.autoSaveIntervalMs = Number(settings.autoSaveIntervalMs) || 20000;
  settings.distanceUnits = settings.distanceUnits === 'imperial' ? 'imperial' : 'metric';
  settings.restoreLastProject = false;
  settings.themeMode = settings.themeMode === 'dark' ? 'dark' : 'light';
  settings.iconSize = ['small','large'].includes(settings.iconSize) ? settings.iconSize : 'normal';
  applyTheme(settings.themeMode);
  applyIconSize(settings.iconSize);
}

function saveSettings(){
  try{ localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); }catch(err){ console.warn('Não foi possível guardar as definições.', err); }
}

function applyIconSize(size){
  const root = document.documentElement;
  const resolved = size === 'large' ? '20px' : (size === 'small' ? '13px' : '16px');
  root.style.setProperty('--app-icon-size', resolved);
  settings.iconSize = size;
}

function updateMapGridVisibility(){
  if(!map) return;
  if(settings.showMapGrid){
    if(!mapGridLayer){
      mapGridLayer = L.layerGroup(buildMapGridLines());
    }
    if(!map.hasLayer(mapGridLayer)) map.addLayer(mapGridLayer);
  } else if(mapGridLayer && map.hasLayer(mapGridLayer)){
    map.removeLayer(mapGridLayer);
  }
}

function applySettingsToEditing(){
  if(!map || !map.pm) return;
  map.pm.setGlobalOptions({
    markerStyle: { icon: dataGisMarkerIcon(DEFAULT_COLOR) },
    snappable: settings.enableSnapping,
    snapDistance: settings.snapTolerance,
    snapSegment: true,
    templineStyle: false,
    hintlineStyle: false
  });
}

function maybeRestoreLastProjectOnStartup(){
  if(!settings.restoreLastProject) return;
  try{
    const savedName = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if(!savedName) return;
    const projects = getLocalProjects();
    if(projects[savedName]) {
      suppressProjectRestoreErrorAlert = true;
      openLocalProject(savedName, {suppressRestoreErrorAlert:true});
    }
  }catch(err){
    console.warn('Não foi possível restaurar o último projeto no arranque.', err);
  } finally {
    suppressProjectRestoreErrorAlert = false;
  }
}

/* ---------- settings menu UI ---------- */
function renderSettingsMenu(){
  const body = document.getElementById('settings-floating-body');
  if(!body) return;
  const currentTheme = settings.themeMode === 'dark' ? 'dark' : 'light';
  const currentSyncLabel = teamState.connected ? `${teamState.name || 'Projeto online'} · ${teamState.status === 'syncing' ? 'a sincronizar' : 'pronto'}` : 'Sem projeto online ativo';
  body.innerHTML = `
    <div class="settings-panel-surface">
      <div class="settings-section">
        <div class="settings-section-title">Geral</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Guardar automático</strong>
            <small>Guarda as alterações quando houver trabalho novo sem precisar de clicar no botão.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.autoSaveEnabled ? 'is-on' : ''}" data-setting-toggle="autoSaveEnabled" aria-label="Alternar guardar automático"></button>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Intervalo de guardado</strong>
            <small>Define com que frequência o projeto é guardado automaticamente.</small>
          </div>
          <div class="settings-option-control">
            <select class="settings-select" data-setting-select="autoSaveIntervalMs">
              <option value="15000" ${settings.autoSaveIntervalMs === 15000 ? 'selected' : ''}>15 s</option>
              <option value="30000" ${settings.autoSaveIntervalMs === 30000 ? 'selected' : ''}>30 s</option>
              <option value="60000" ${settings.autoSaveIntervalMs === 60000 ? 'selected' : ''}>1 min</option>
            </select>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Restaurar último projeto ao iniciar</strong>
            <small>Se houver um projeto guardado, é reaberto automaticamente ao entrar na aplicação.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.restoreLastProject ? 'is-on' : ''}" data-setting-toggle="restoreLastProject" aria-label="Alternar restaurar último projeto"></button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Mapa</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Mostrar grelha no mapa</strong>
            <small>Ajuda a perceber melhor a orientação espacial durante a digitalização.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.showMapGrid ? 'is-on' : ''}" data-setting-toggle="showMapGrid" aria-label="Alternar grelha"></button>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Mostrar coordenadas do cursor</strong>
            <small>Mostra as coordenadas do ponto sob o cursor na barra inferior.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.showCursorCoordinates ? 'is-on' : ''}" data-setting-toggle="showCursorCoordinates" aria-label="Alternar coordenadas do cursor"></button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Edição</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Snapping por defeito</strong>
            <small>Ativa o íman de desenho para colar a vértices e segmentos existentes.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.enableSnapping ? 'is-on' : ''}" data-setting-toggle="enableSnapping" aria-label="Alternar snapping"></button>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Tolerância de snapping</strong>
            <small>Raio em píxeis dentro do qual o íman reage ao cursor.</small>
          </div>
          <div class="settings-option-control">
            <select class="settings-select" data-setting-select="snapTolerance">
              <option value="10" ${settings.snapTolerance === 10 ? 'selected' : ''}>10 px</option>
              <option value="18" ${settings.snapTolerance === 18 ? 'selected' : ''}>18 px</option>
              <option value="24" ${settings.snapTolerance === 24 ? 'selected' : ''}>24 px</option>
            </select>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Confirmações antes de eliminar</strong>
            <small>Mostra avisos antes de apagar uma camada, um projeto ou uma geometria.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.confirmDeletes ? 'is-on' : ''}" data-setting-toggle="confirmDeletes" aria-label="Alternar confirmações"></button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Interface</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Tema</strong>
            <small>Escolhe a aparência da aplicação.</small>
          </div>
          <div class="settings-option-control">
            <div class="settings-segmented">
              <button type="button" class="${currentTheme === 'light' ? 'is-active' : ''}" data-theme-mode="light">Claro</button>
              <button type="button" class="${currentTheme === 'dark' ? 'is-active' : ''}" data-theme-mode="dark">Escuro</button>
            </div>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Tamanho dos ícones</strong>
            <small>Ajusta a densidade visual dos botões do cabeçalho.</small>
          </div>
          <div class="settings-option-control">
            <div class="settings-segmented">
              <button type="button" class="${settings.iconSize === 'small' ? 'is-active' : ''}" data-icon-size="small">Pequeno</button>
              <button type="button" class="${settings.iconSize === 'normal' ? 'is-active' : ''}" data-icon-size="normal">Normal</button>
              <button type="button" class="${settings.iconSize === 'large' ? 'is-active' : ''}" data-icon-size="large">Grande</button>
            </div>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Dicas da interface</strong>
            <small>Mostra mensagens contextuais quando mudas de basemap ou de ferramenta.</small>
          </div>
          <div class="settings-option-control">
            <button type="button" class="settings-switch ${settings.showInterfaceHints ? 'is-on' : ''}" data-setting-toggle="showInterfaceHints" aria-label="Alternar dicas"></button>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Camadas e projeto</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Unidades de distância</strong>
            <small>Usa métrico ou imperial nas medições da régua.</small>
          </div>
          <div class="settings-option-control">
            <div class="settings-segmented">
              <button type="button" class="${settings.distanceUnits === 'metric' ? 'is-active' : ''}" data-distance-units="metric">Métrico</button>
              <button type="button" class="${settings.distanceUnits === 'imperial' ? 'is-active' : ''}" data-distance-units="imperial">Imperial</button>
            </div>
          </div>
        </div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Sincronização online</strong>
            <small>${currentSyncLabel}</small>
          </div>
          <div class="settings-option-control"><span class="settings-pill is-live">Ativo</span></div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Desempenho</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Modo performance</strong>
            <small>Reduz atualizações visuais em projetos muito grandes. Disponível em breve.</small>
          </div>
          <div class="settings-option-control"><span class="settings-pill">Em breve</span></div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Experimental</div>
        <div class="settings-option">
          <div class="settings-option-label">
            <strong>Sobreposições e erros topológicos</strong>
            <small>Realça problemas de sobreposição entre geometrias. Disponível em breve.</small>
          </div>
          <div class="settings-option-control"><span class="settings-pill">Em breve</span></div>
        </div>
      </div>

      <div class="settings-footer">
        <button type="button" class="btn primary settings-save-btn" id="settings-save-btn">Guardar</button>
      </div>
    </div>
  `;
  body.querySelectorAll('[data-setting-toggle]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.getAttribute('data-setting-toggle');
      settings[key] = !settings[key];
      settingsMenuDirty = true;
      saveSettings();
      if(key === 'autoSaveEnabled'){
        if(settings.autoSaveEnabled){ enableAutoSave(); } else { disableAutoSave(); }
      }
      if(key === 'showMapGrid'){ updateMapGridVisibility(); }
      if(key === 'enableSnapping'){ applySettingsToEditing(); }
      if(key === 'showCursorCoordinates'){ if(!settings.showCursorCoordinates) { coordValueEl.innerHTML = '—'; } }
      renderSettingsMenu();
    });
  });
  body.querySelectorAll('[data-setting-select]').forEach(select=>{
    select.addEventListener('change', ()=>{
      const key = select.getAttribute('data-setting-select');
      const value = select.value;
      settings[key] = key === 'autoSaveIntervalMs' ? Number(value) : Number(value);
      settingsMenuDirty = true;
      saveSettings();
      if(key === 'autoSaveIntervalMs' && settings.autoSaveEnabled){ enableAutoSave(); }
      if(key === 'snapTolerance'){ applySettingsToEditing(); }
      renderSettingsMenu();
    });
  });
  body.querySelectorAll('[data-theme-mode]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      applyTheme(btn.getAttribute('data-theme-mode'));
      settings.themeMode = settings.themeMode === 'dark' ? 'dark' : 'light';
      settingsMenuDirty = true;
      saveSettings();
      renderSettingsMenu();
    });
  });
  body.querySelectorAll('[data-icon-size]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const size = btn.getAttribute('data-icon-size');
      settings.iconSize = size;
      settingsMenuDirty = true;
      applyIconSize(size);
      saveSettings();
      renderSettingsMenu();
    });
  });
  body.querySelectorAll('[data-distance-units]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      settings.distanceUnits = btn.getAttribute('data-distance-units');
      settingsMenuDirty = true;
      saveSettings();
      renderSettingsMenu();
    });
  });
  const saveBtn = document.getElementById('settings-save-btn');
  saveBtn?.addEventListener('click', ()=>{
    saveSettings();
    settingsMenuDirty = false;
    closeSettingsMenu(true);
    showTeamToast('Definições guardadas.');
  });
}

function setupSettingsMenuWheelLock(){
  const menu = document.getElementById('settings-floating-menu');
  const body = document.getElementById('settings-floating-body');
  if(!menu || !body || menu.__wheelLockAttached) return;
  const handleWheel = (event)=>{
    const deltaY = event.deltaY || 0;
    const atTop = body.scrollTop <= 0;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    const shouldScroll = deltaY > 0 ? !atBottom : !atTop;
    if(shouldScroll || body.scrollHeight > body.clientHeight){
      event.preventDefault();
      event.stopPropagation();
      body.scrollTop += deltaY;
    } else {
      event.stopPropagation();
    }
  };
  menu.addEventListener('wheel', handleWheel, {passive:false});
  body.addEventListener('wheel', handleWheel, {passive:false});
  menu.__wheelLockAttached = true;
}

function openSettingsMenu(){
  settingsMenuDirty = false;
  const menu = document.getElementById('settings-floating-menu');
  if(menu){
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden','false');
  }
  setupSettingsMenuWheelLock();
  renderSettingsMenu();
}

function closeSettingsMenu(force = false){
  const menu = document.getElementById('settings-floating-menu');
  if(!menu) return;
  if(settingsMenuDirty && !force){
    showTeamToast('Guarda as alterações para fechar as definições.');
    return;
  }
  menu.classList.add('hidden');
  menu.setAttribute('aria-hidden','true');
  settingsMenuDirty = false;
}

function toggleSettingsMenu(forceOpen = null){
  const menu = document.getElementById('settings-floating-menu');
  if(!menu) return;
  const shouldOpen = forceOpen ?? menu.classList.contains('hidden');
  if(shouldOpen){ openSettingsMenu(); } else { closeSettingsMenu(); }
}

document.getElementById('settings-menu-close')?.addEventListener('click', ()=> closeSettingsMenu());
document.addEventListener('click', (event)=>{
  const menu = document.getElementById('settings-floating-menu');
  const settingsBtn = document.getElementById('btn-cloud-settings');
  if(!menu || menu.classList.contains('hidden')) return;
  const path = event.composedPath ? event.composedPath() : [];
  const clickedInside = path.includes(menu) || (settingsBtn && path.includes(settingsBtn));
  if(!clickedInside){ closeSettingsMenu(); }
});

document.addEventListener('keydown', (event)=>{
  const menu = document.getElementById('settings-floating-menu');
  if(event.key === 'Escape' && menu && !menu.classList.contains('hidden')){
    event.preventDefault();
    closeSettingsMenu();
  }
});

/* ---------- cloud menu UI ---------- */
function renderCloudMenu(){
  const body = document.getElementById('team-sync-floating-body');
  if(!body) return;

  if(cloudMenuView === 'settings'){
    if(cloudDeleteInProgress){
      body.innerHTML = `
        <div class="cloud-panel-surface">
          <div class="cloud-panel-chip">A eliminar projeto</div>
          <div class="cloud-form-card" style="align-items:center; text-align:center;">
            <div class="cloud-delete-spinner"></div>
            <p class="cloud-helper" style="margin-top:6px;">A eliminar projeto da base de dados…</p>
          </div>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="cloud-panel-surface">
        <div class="cloud-panel-chip">Definições da nuvem</div>
        <p class="cloud-menu-hint">Gerir o projeto online ativo ou voltar ao menu principal.</p>
        ${teamState.connected ? `
          <div class="cloud-form-card">
            <div class="cloud-info-row">
              <span class="label">Projeto</span>
              <span class="value">${escapeHtml(teamState.name || '—')}</span>
            </div>
            <div class="cloud-field">
              <label for="cloud-delete-project-name">Nome do projeto</label>
              <input class="cloud-input" type="text" id="cloud-delete-project-name" value="${escapeHtml(teamState.name || '')}" autocomplete="off">
            </div>
            <div class="cloud-field">
              <label for="cloud-delete-project-password">Password</label>
              <input class="cloud-input" type="password" id="cloud-delete-project-password" autocomplete="new-password">
            </div>
            <button type="button" class="btn warn" id="cloud-delete-project-btn">Eliminar projeto</button>
          </div>
        ` : '<div class="cloud-form-card"><p class="cloud-helper">Nenhum projeto online está ativo neste momento.</p></div>'}
      </div>
      <div class="cloud-menu-actions">
        <button type="button" class="btn" id="cloud-menu-back">← Voltar</button>
      </div>
    `;
    document.getElementById('cloud-menu-back')?.addEventListener('click', ()=>{
      cloudMenuView = 'home';
      renderCloudMenu();
    });
    document.getElementById('cloud-delete-project-btn')?.addEventListener('click', async ()=>{
      const projectName = normalizeTeamProjectName(document.getElementById('cloud-delete-project-name')?.value || teamState.name);
      const password = document.getElementById('cloud-delete-project-password')?.value || '';
      if(!projectName || !password){ showAppAlert('Introduz o nome do projeto e a password para eliminar.', {error: true}); return; }
      if(!requestConfirmation(`Eliminar o projeto "${projectName}" da base de dados? Esta ação não pode ser desfeita.`)) return;
      cloudDeleteInProgress = true;
      renderCloudMenu();
      try{
        await deleteTeamProjectFromServer(projectName, password);
        clearTeamProject();
        clearCloudSyncState();
        cloudMenuView = 'home';
        updateTeamSyncSupportVisibility();
        updateProjectStatusUI();
        showTeamToast('Projeto eliminado da base de dados.');
        renderCloudMenu();
      }catch(err){
        console.error('Erro ao eliminar projeto online:', err);
        cloudDeleteInProgress = false;
        renderCloudMenu();
        showAppAlert('Não foi possível eliminar o projeto. Verifica o nome e a password.', {error: true});
      }
    });
    return;
  }

  if(teamState.connected){
    const usedLabel = teamState.usedBytes ? `${(teamState.usedBytes / 1024 / 1024).toFixed(1)} MB` : '—';
    const lastSyncLabel = teamState.lastSync ? new Date(teamState.lastSync).toLocaleString('pt-PT') : 'Nunca sincronizado';
    const statusLabel = teamState.status === 'syncing' ? 'a sincronizar…' : 'Pronto para sincronizar';
    const percent = Math.min(100, (teamState.usedBytes / teamState.sizeLimit) * 100);
    body.innerHTML = `
      <div class="cloud-panel-surface">
        <div class="cloud-panel-chip">Projeto online ativo</div>
        <div class="cloud-menu-status">${escapeHtml(teamState.name || 'Projeto online')}</div>
        <div class="cloud-form-card">
          <div class="cloud-info-row">
            <span class="label">Projeto</span>
            <span class="value">${escapeHtml(teamState.name || '—')}</span>
          </div>
          <div class="cloud-info-row">
            <span class="label">Estado</span>
            <span class="value">${statusLabel}</span>
          </div>
          <div class="cloud-info-row">
            <span class="label">Última sincronização</span>
            <span class="value">${lastSyncLabel}</span>
          </div>
          <div class="cloud-usage-card">
            <div class="cloud-usage-meta">
              <span>Espaço usado</span>
              <b>${usedLabel} / 200 MB</b>
            </div>
            <div class="team-progress-bar"><div class="team-progress-fill" style="width:${percent}%"></div></div>
          </div>
          <button type="button" class="btn warn" id="cloud-leave-project-btn">Sair do projeto</button>
        </div>
      </div>
    `;
    document.getElementById('cloud-leave-project-btn')?.addEventListener('click', ()=>{
      leaveTeamProject();
      renderCloudMenu();
    });
    return;
  }

  if(cloudMenuView === 'team'){
    body.innerHTML = `
      <div class="cloud-panel-surface">
        <div class="cloud-panel-chip">Carregar projeto da nuvem</div>
        <p class="cloud-menu-hint">Escolhe o projeto guardado na nuvem para retomar o trabalho ou gerir o acesso ao mesmo.</p>
        <div id="cloud-team-content"></div>
      </div>
      <div class="cloud-menu-actions">
        <button type="button" class="btn" id="cloud-menu-back">← Voltar</button>
      </div>
    `;
    document.getElementById('cloud-menu-back')?.addEventListener('click', ()=>{
      cloudMenuView = 'home';
      renderCloudMenu();
    });
    renderTeamCard('load');
    return;
  }

  if(cloudMenuView === 'personal'){
    body.innerHTML = `
      <div class="cloud-panel-surface">
        <div class="cloud-panel-chip">Criar projeto na nuvem</div>
        <p class="cloud-menu-hint">Define um nome e uma password para criar um projeto online e começar a sincronizar.</p>
        <div id="cloud-team-content"></div>
      </div>
      <div class="cloud-menu-actions">
        <button type="button" class="btn" id="cloud-menu-back">← Voltar</button>
      </div>
    `;
    document.getElementById('cloud-menu-back')?.addEventListener('click', ()=>{
      cloudMenuView = 'home';
      renderCloudMenu();
    });
    renderTeamCard('create');
    return;
  }

  const statusText = cloudSyncMode === 'team'
    ? 'Ligação ativa a projeto na nuvem.'
    : (cloudSyncMode === 'personal' ? 'Ligação ativa a projeto na nuvem.' : 'Escolhe o que queres fazer com os teus projetos na nuvem.');

  body.innerHTML = `
    <div class="cloud-menu-status">${statusText}</div>
    <button type="button" class="cloud-menu-card" id="cloud-menu-personal">
      <strong>Criar projeto na nuvem</strong>
      <small>Cria um novo projeto online com nome e password para começar a sincronizar.</small>
    </button>
    <button type="button" class="cloud-menu-card" id="cloud-menu-team">
      <strong>Carregar projeto da nuvem</strong>
      <small>Retoma um projeto já guardado na nuvem e continua a trabalhar a partir dele.</small>
    </button>
  `;
  document.getElementById('cloud-menu-personal')?.addEventListener('click', (event)=>{
    event.stopPropagation();
    cloudMenuView = 'personal';
    renderCloudMenu();
  });
  document.getElementById('cloud-menu-team')?.addEventListener('click', (event)=>{
    event.stopPropagation();
    cloudMenuView = 'team';
    renderCloudMenu();
    renderTeamCard();
  });
}

function openCloudMenu(){
  const menu = document.getElementById('team-sync-floating-menu');
  if(menu){
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    menu.onclick = (event)=> event.stopPropagation();
  }
  renderCloudMenu();
}

function closeCloudMenu(){
  const menu = document.getElementById('team-sync-floating-menu');
  if(menu){
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
  }
  cloudMenuView = 'home';
}

function toggleCloudMenu(forceOpen = null){
  const menu = document.getElementById('team-sync-floating-menu');
  if(!menu) return;
  const shouldOpen = forceOpen ?? menu.classList.contains('hidden');
  if(shouldOpen){
    dismissGearCoachmark();
    showTeamPanel();
    openCloudMenu();
  } else {
    closeCloudMenu();
  }
}

document.addEventListener('click', (event)=>{
  const menu = document.getElementById('team-sync-floating-menu');
  const openBtn = document.getElementById('open-wizard-btn');
  const settingsBtn = document.getElementById('btn-cloud-settings');
  if(!menu || menu.classList.contains('hidden')) return;
  const path = event.composedPath ? event.composedPath() : [];
  const clickedInside = path.includes(menu)
    || (openBtn && path.includes(openBtn))
    || (settingsBtn && path.includes(settingsBtn));
  if(!clickedInside){
    closeCloudMenu();
  }
});

document.addEventListener('keydown', (event)=>{
  const menu = document.getElementById('team-sync-floating-menu');
  if(event.key === 'Escape' && menu && !menu.classList.contains('hidden')){
    event.preventDefault();
    closeCloudMenu();
  }
});

/* expor funções usadas por outros módulos */
window.setCloudSyncState = setCloudSyncState;
window.clearCloudSyncState = clearCloudSyncState;
window.updateOnlineSyncButtonVisibility = updateOnlineSyncButtonVisibility;
window.loadSettings = loadSettings;
window.saveSettings = saveSettings;
window.applyIconSize = applyIconSize;
window.updateMapGridVisibility = updateMapGridVisibility;
window.applySettingsToEditing = applySettingsToEditing;
window.maybeRestoreLastProjectOnStartup = maybeRestoreLastProjectOnStartup;
window.renderSettingsMenu = renderSettingsMenu;
window.openSettingsMenu = openSettingsMenu;
window.closeSettingsMenu = closeSettingsMenu;
window.toggleSettingsMenu = toggleSettingsMenu;
window.renderCloudMenu = renderCloudMenu;
window.openCloudMenu = openCloudMenu;
window.closeCloudMenu = closeCloudMenu;
window.toggleCloudMenu = toggleCloudMenu;

})();
