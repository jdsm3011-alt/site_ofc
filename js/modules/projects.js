/* === MÓDULO: PROJETOS LOCAIS === */
/* Local project CRUD, save/open/delete, project status UI,
   auto-save, save current project, clear/restore state,
   serialize/restore layer schemas, start project modal */
/* Origem: 05-app-main.js linhas 508-1155 */
(function(){
/* ============================================================
   PROJETOS LOCAIS (guardados na aplicação, neste dispositivo)
   ============================================================ */
const LOCAL_PROJECTS_KEY = 'engenh-local-projects';
const ACTIVE_PROJECT_KEY = 'engenh-active-project-name'; // guarda qual o projeto ativo, como rede de segurança
let localProjectState = { name: null, active: false };
let startProjectChoice = null; // 'novo' | 'sem'

// marca que há alterações nas geometrias ainda não guardadas no projeto local;
// usado para avisar o utilizador antes de sair/fechar/recomeçar
let projectDirty = false;
function markProjectDirty(){
  projectDirty = true;
  persistCurrentWorkspaceState();
  if(autoSaveEnabled) pulseSaveIcon(); // feedback imediato: "alteração registada, será guardada"
}

function getLocalProjects(){
  try{
    return JSON.parse(localStorage.getItem(LOCAL_PROJECTS_KEY)) || {};
  }catch(err){
    console.warn('Não foi possível ler os projetos locais guardados.', err);
    return {};
  }
}

function saveLocalProjects(projects){
  try{
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
  }catch(err){
    console.warn('Não foi possível guardar os projetos locais.', err);
    showAppAlert('Não foi possível guardar o projeto localmente (armazenamento cheio ou indisponível).', {error: true});
  }
}

function updateProjectStatusUI(){
  const badge = document.getElementById('project-status-badge');
  const badgeText = document.getElementById('project-status-badge-text');
  const onlineLabel = teamState.connected && teamState.name ? `Nuvem: ${teamState.name}` : '';
  const localLabel = localProjectState.active && localProjectState.name ? `Projeto: ${localProjectState.name}` : '';
  const label = onlineLabel || localLabel;
  if(label){
    badge.style.display = 'inline-flex';
    badgeText.textContent = label;
  } else {
    badge.style.display = 'none';
    badgeText.textContent = '';
  }
  const saveBtn = document.getElementById('btn-save-project');
  if(saveBtn){
    saveBtn.title = (localProjectState.active && localProjectState.name)
      ? `Guardar em "${localProjectState.name}"`
      : 'Guardar projeto';
  }
}

function clearLocalProjectState(){
  localProjectState.name = null;
  localProjectState.active = false;
  try{ localStorage.removeItem(ACTIVE_PROJECT_KEY); }catch(err){ /* ignora */ }
  updateProjectStatusUI();
}

function clearMapLayerState(){
  if(drawnGroup) drawnGroup.clearLayers();
  if(measuresGroup) measuresGroup.clearLayers();
  featuresData.clear();
  layers.length = 0;
  layerVisible.clear();
  layerOrder.length = 0;
  symbologyLayerId = null;
  config.shapeName = null;
  config.mode = null;
  config.attributes = [];
  config.geometryType = null;
  config.colorAttr = null;
  config.baseColor = null;
  config.opacity = null;
  config.symbology = defaultSymbology();
  layerPanes.forEach((paneName, id)=>{
    const pane = map && map.getPane(paneName);
    if(pane) pane.remove();
  });
  layerPanes.clear();
  activeLayerId = ++layerCounter;
  layerVisible.set(activeLayerId, true);
  layerOrder = [activeLayerId];
  if(typeof clearRasterLayerState === 'function') clearRasterLayerState();
}

function serializeLayerSchemasForGeoJSON(){
  const allLayerIds = layers.map(l=>l.id).concat(config.geometryType ? [activeLayerId] : []);
  return allLayerIds.map(id=>{
    const schema = getLayerSchema(id);
    if(!schema) return null;
    return {
      id,
      name: schema.name,
      geometryType: schema.geometryType,
      mode: schema.mode,
      attributes: Array.isArray(schema.attributes) ? schema.attributes.map(a=>({...a})) : [],
      colorAttr: schema.colorAttr || null,
      baseColor: schema.baseColor || null,
      opacity: schema.opacity,
      strokeColor: schema.strokeColor || null,
      strokeWidth: schema.strokeWidth != null ? schema.strokeWidth : null,
      pointSize: schema.pointSize != null ? schema.pointSize : null,
      symbology: cloneSymbology(schema.symbology),
      visible: layerVisible.get(id) !== false
    };
  }).filter(Boolean);
}

function restoreLayerSchemasFromGeoJSON(geojson){
  const schemas = Array.isArray(geojson && geojson.__layers) ? geojson.__layers : [];
  if(!schemas.length) return false;

  layers.length = 0;
  layerVisible.clear();
  layerOrder.length = 0;

  const importedIds = [];
  schemas.forEach(meta=>{
    const id = Number(meta.id);
    if(!Number.isFinite(id)) return;
    importedIds.push(id);

    layers.push({
      id,
      name: meta.name || null,
      geometryType: meta.geometryType || null,
      mode: meta.mode || 'atributos',
      attributes: Array.isArray(meta.attributes) ? meta.attributes.map(a=>({...a})) : [],
      colorAttr: meta.colorAttr || null,
      baseColor: meta.baseColor || null,
      opacity: meta.opacity,
      strokeColor: meta.strokeColor || null,
      strokeWidth: meta.strokeWidth != null ? meta.strokeWidth : null,
      pointSize: meta.pointSize != null ? meta.pointSize : null,
      symbology: cloneSymbology(meta.symbology)
    });
    layerVisible.set(id, meta.visible !== false);
  });

  if(!importedIds.length) return false;

  layerCounter = Math.max(layerCounter, ...importedIds);
  const preferredActive = Number(geojson.__activeLayerId);
  activeLayerId = importedIds.includes(preferredActive) ? preferredActive : importedIds[0];
  layerOrder = importedIds.slice();

  const activeMeta = schemas.find(meta=>Number(meta.id)===activeLayerId) || schemas[0];
  config.shapeName = activeMeta && activeMeta.name ? activeMeta.name : null;
  config.mode = activeMeta && activeMeta.mode ? activeMeta.mode : 'atributos';
  config.attributes = Array.isArray(activeMeta && activeMeta.attributes) ? activeMeta.attributes.map(a=>({...a})) : [];
  config.geometryType = activeMeta && activeMeta.geometryType ? activeMeta.geometryType : null;
  config.colorAttr = activeMeta && activeMeta.colorAttr ? activeMeta.colorAttr : null;
  config.baseColor = activeMeta && activeMeta.baseColor ? activeMeta.baseColor : null;
  config.opacity = activeMeta && activeMeta.opacity != null ? activeMeta.opacity : null;
  config.strokeColor = activeMeta && activeMeta.strokeColor || null;
  config.strokeWidth = activeMeta && activeMeta.strokeWidth != null ? activeMeta.strokeWidth : null;
  config.pointSize = activeMeta && activeMeta.pointSize != null ? activeMeta.pointSize : null;
  config.symbology = cloneSymbology(activeMeta && activeMeta.symbology);

  return true;
}

function inferLayerAttributesFromProps(layerId, props){
  const source = props && typeof props === 'object' ? props : {};
  const keys = Object.keys(source).filter(k=>k && !k.startsWith('__'));
  if(!keys.length) return;

  const schema = getLayerSchema(layerId);
  if(!schema) return;

  const hasExistingAttrs = Array.isArray(schema.attributes) && schema.attributes.length > 0;
  if(hasExistingAttrs) return;

  const attrs = keys.map(name=>({name, type:'texto'}));
  if(layerId === activeLayerId){
    config.attributes = attrs;
    if(!config.mode) config.mode = 'atributos';
  } else {
    const layerMeta = layers.find(l=>l.id === layerId);
    if(layerMeta){
      layerMeta.attributes = attrs;
      if(!layerMeta.mode) layerMeta.mode = 'atributos';
    }
  }
}

function ensureActiveLayerForImportedProject(){
  if(config.geometryType || featuresData.size === 0) return;
  const firstEntry = featuresData.values().next().value;
  if(!firstEntry) return;
  config.geometryType = firstEntry.geomType;
  config.shapeName = 'Camada importada';
  config.mode = 'atributos';
  config.attributes = [];
  config.colorAttr = null;
  config.baseColor = null;
  config.opacity = null;
  config.strokeColor = null;
  config.strokeWidth = null;
  config.pointSize = null;
  config.symbology = defaultSymbology();
}

function finalizeLoadedProjectState(){
  if(map && map.pm){
    applyGeometryConfig();
    refreshLayerEditability();
  }
  refreshFeatList();
  if(document.getElementById('layers-list')) renderLayersPanel();
}

/* ---------- modal de escolha ao iniciar ---------- */
document.getElementById('btn-start-project').addEventListener('click', ()=>{
  hideStartProjectWarning();
  document.getElementById('start-project-overlay').classList.remove('hidden');
});

function hideStartProjectWarning(){
  const warning = document.getElementById('start-project-warning');
  warning.classList.add('hidden');
  warning.textContent = '';
}

document.querySelectorAll('[data-start-choice]').forEach(card=>{
  card.addEventListener('click', ()=>{
    document.querySelectorAll('[data-start-choice]').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    startProjectChoice = card.dataset.startChoice;
    hideStartProjectWarning();

    const nameRow = document.getElementById('start-project-name-row');
    const nameError = document.getElementById('start-project-name-error');
    nameError.style.display = 'none';
    if(startProjectChoice === 'novo'){
      nameRow.classList.remove('hidden');
      document.getElementById('start-project-name').focus();
    } else {
      nameRow.classList.add('hidden');
    }
    validateStartProjectContinue();
  });
});

document.getElementById('start-project-name').addEventListener('input', validateStartProjectContinue);

function validateStartProjectContinue(){
  const btn = document.getElementById('start-project-continue');
  if(startProjectChoice === 'sem' || startProjectChoice === 'continuar'){ btn.disabled = false; return; }
  if(startProjectChoice === 'novo'){
    btn.disabled = document.getElementById('start-project-name').value.trim().length === 0;
    return;
  }
  btn.disabled = true;
}

document.getElementById('start-project-continue').addEventListener('click', ()=>{
  if(startProjectChoice === 'continuar'){
    const projects = getLocalProjects();
    if(Object.keys(projects).length === 0){
      const warning = document.getElementById('start-project-warning');
      warning.textContent = 'Ainda não tens nenhum projeto guardado neste dispositivo. Cria um projeto novo ou trabalha sem gravar.';
      warning.classList.remove('hidden');
      return; // fica no mesmo modal, não avança
    }
    // equivale a abrir diretamente o painel de "Projetos guardados"
    document.getElementById('start-project-overlay').classList.add('hidden');
    proceedToMap();
    renderLocalProjectsList();
    document.getElementById('local-projects-overlay').classList.remove('hidden');
    return;
  }

  if(startProjectChoice === 'novo'){
    const rawName = document.getElementById('start-project-name').value.trim();
    if(!rawName) return;

    const projects = getLocalProjects();
    if(!projects[rawName]){
      projects[rawName] = { name: rawName, updatedAt: Date.now(), config: null, geojson: {type:'FeatureCollection', features:[]} };
      saveLocalProjects(projects);
    }
    localProjectState.name = rawName;
    localProjectState.active = true;
    try{ localStorage.setItem(ACTIVE_PROJECT_KEY, rawName); }catch(err){ /* ignora */ }
  } else {
    localProjectState.name = null;
    localProjectState.active = false;
    try{ localStorage.removeItem(ACTIVE_PROJECT_KEY); }catch(err){ /* ignora */ }
  }

  updateProjectStatusUI();
  document.getElementById('start-project-overlay').classList.add('hidden');
  proceedToMap();
});

/* ---------- guardar projeto ---------- */
// devolve true se guardou com sucesso, false se o utilizador cancelou (ex: não deu nome)
// opts.silent=true -> usado pelo guardar automático: nunca pede nome e não mostra o toast normal
function saveCurrentProject(opts){
  opts = opts || {};
  if(!localProjectState.active || !localProjectState.name){
    // rede de segurança: se por algum motivo o estado em memória se perdeu mas
    // sabemos qual foi o último projeto aberto (e ele ainda existe), recupera-o
    // em vez de assumir que não há nenhum projeto e pedir para criar um novo.
    try{
      const lastActive = localStorage.getItem(ACTIVE_PROJECT_KEY);
      if(lastActive){
        const existing = getLocalProjects();
        if(existing[lastActive]){
          localProjectState.name = lastActive;
          localProjectState.active = true;
          updateProjectStatusUI();
        }
      }
    }catch(err){ /* ignora */ }
  }

  if(!localProjectState.active || !localProjectState.name){
    if(opts.silent) return false; // nada para guardar automaticamente ainda
    const name = prompt('Ainda não tens um projeto ativo. Dá um nome para guardares o trabalho:');
    if(!name || !name.trim()) return false;
    localProjectState.name = name.trim();
    localProjectState.active = true;
    updateProjectStatusUI();
  }

  const projects = getLocalProjects();
  const allLayerIds = layers.map(l=>l.id).concat(config.geometryType ? [activeLayerId] : []);
  const layersMeta = allLayerIds.map(id=>{
    const schema = getLayerSchema(id);
    return {
      id,
      name: schema.name,
      geometryType: schema.geometryType,
      mode: schema.mode,
      attributes: schema.attributes,
      colorAttr: schema.colorAttr,
      baseColor: schema.baseColor,
      opacity: schema.opacity,
      strokeColor: schema.strokeColor,
      strokeWidth: schema.strokeWidth,
      pointSize: schema.pointSize,
      symbology: cloneSymbology(schema.symbology),
      visible: layerVisible.get(id) !== false
    };
  });
  projects[localProjectState.name] = {
    name: localProjectState.name,
    updatedAt: Date.now(),
    layers: layersMeta,
    activeLayerId: activeLayerId,
    layerCounter: layerCounter,
    layerOrder: layerOrder.slice(),
    geojson: buildGeoJSON(false, true),
    rasterLayers: serializeRasterLayersForProject()
  };
  saveLocalProjects(projects);
  projectDirty = false;
  persistCurrentWorkspaceState();
  if(!opts.silent){
    showTeamToast(`Projeto "${localProjectState.name}" guardado.`);
  }
  return true;
}
document.getElementById('btn-save-project').addEventListener('click', saveCurrentProject);

function disableAutoSave(){
  if(!autoSaveEnabled) return;
  autoSaveEnabled = false;
  const btn = document.getElementById('btn-save-project');
  if(btn) btn.classList.remove('autosave-on');
  if(autoSaveInterval){ clearInterval(autoSaveInterval); autoSaveInterval = null; }
}

/* ---------- guardar automático: segurar o botão de guardar 3s ativa-o ---------- */
let autoSaveEnabled = false;
let autoSaveInterval = null;
let saveHoldTimer = null;

function showAutosaveToast(message){
  showNotification(message, {type:'info', timeout: 3200});
}

function pulseSaveIcon(){
  const btn = document.getElementById('btn-save-project');
  if(!btn) return;
  btn.classList.remove('autosave-pulse');
  void btn.offsetWidth; // reinicia a animação mesmo em disparos consecutivos
  btn.classList.add('autosave-pulse');
  setTimeout(()=>btn.classList.remove('autosave-pulse'), 1000);
}

function enableAutoSave(){
  if(autoSaveEnabled) return;
  autoSaveEnabled = true;
  settings.autoSaveEnabled = true;
  saveSettings();
  const btn = document.getElementById('btn-save-project');
  if(btn) btn.classList.add('autosave-on');
  showAutosaveToast('A guardar automaticamente…');
  if(autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(()=>{
    if(!projectDirty) return; // nada mudou desde o último guardado, não faz nada
    const saved = saveCurrentProject({ silent:true });
    if(saved) pulseSaveIcon();
  }, settings.autoSaveIntervalMs || 20000);
}

/* ---------- sugestão de guardar automático após 3 gravações manuais ----------
   Ao 3º clique no botão Guardar (sem já ter o auto-save ativo), pergunta-se ao
   utilizador se quer ativá-lo. Se disser "Não", a pergunta não volta a aparecer
   (fica gravado no localStorage deste dispositivo). */
let manualSaveClickCount = 0;
const AUTOSAVE_SUGGEST_DECLINED_KEY = 'engenh-autosave-suggest-declined';

document.getElementById('btn-save-project').addEventListener('click', ()=>{
  if(autoSaveEnabled) return;
  if(localStorage.getItem(AUTOSAVE_SUGGEST_DECLINED_KEY) === '1') return;
  manualSaveClickCount++;
  if(manualSaveClickCount >= 3){
    document.getElementById('autosave-suggest-overlay').classList.remove('hidden');
  }
});

document.getElementById('autosave-suggest-yes').addEventListener('click', ()=>{
  document.getElementById('autosave-suggest-overlay').classList.add('hidden');
  enableAutoSave();
});

document.getElementById('autosave-suggest-no').addEventListener('click', ()=>{
  try{ localStorage.setItem(AUTOSAVE_SUGGEST_DECLINED_KEY, '1'); }catch(err){ /* ignora */ }
  document.getElementById('autosave-suggest-overlay').classList.add('hidden');
});

(function setupSaveButtonHold(){
  const btn = document.getElementById('btn-save-project');
  if(!btn) return;

  function startHold(){
    if(autoSaveEnabled) return; // já ativo, não precisa de segurar outra vez
    clearTimeout(saveHoldTimer);
    btn.classList.add('holding-save');
    saveHoldTimer = setTimeout(()=>{
      btn.classList.remove('holding-save');
      enableAutoSave();
    }, 3000);
  }
  function cancelHold(){
    clearTimeout(saveHoldTimer);
    btn.classList.remove('holding-save');
  }

  btn.addEventListener('mousedown', startHold);
  btn.addEventListener('touchstart', startHold, { passive:true });
  ['mouseup','mouseleave','touchend','touchcancel'].forEach(evt=>{
    btn.addEventListener(evt, cancelHold);
  });
})();

/* ---------- consultar / abrir / eliminar projetos guardados ---------- */
document.getElementById('btn-open-local-projects').addEventListener('click', ()=>{
  renderLocalProjectsList();
  document.getElementById('local-projects-overlay').classList.remove('hidden');
});
document.getElementById('local-projects-close').addEventListener('click', ()=>{
  document.getElementById('local-projects-overlay').classList.add('hidden');
});

function renderLocalProjectsList(){
  const container = document.getElementById('local-projects-list');
  const projects = getLocalProjects();
  const names = Object.keys(projects).sort((a,b)=> (projects[b].updatedAt||0) - (projects[a].updatedAt||0));

  if(names.length === 0){
    container.innerHTML = '<p class="sub">Ainda não guardaste nenhum projeto neste dispositivo.</p>';
    return;
  }

  container.innerHTML = names.map(name=>{
    const p = projects[name];
    const count = (p.geojson && p.geojson.features) ? p.geojson.features.length : 0;
    const date = p.updatedAt ? new Date(p.updatedAt).toLocaleString('pt-PT') : '—';
    const isActive = localProjectState.active && localProjectState.name === name;
    return `
      <div class="local-project-row">
        <div class="info">
          <b>${escapeHtml(name)}${isActive ? ' <span style="color:var(--green);">(ativo)</span>' : ''}</b>
          <span>${count} geometria(s) · guardado em ${date}</span>
        </div>
        <div class="actions">
          <button type="button" class="btn" data-open-local="${escapeHtml(name)}">Abrir</button>
          <button type="button" class="btn warn" data-delete-local="${escapeHtml(name)}" title="Eliminar">🗑</button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-open-local]').forEach(btn=>{
    btn.addEventListener('click', ()=> openLocalProject(btn.dataset.openLocal));
  });
  container.querySelectorAll('[data-delete-local]').forEach(btn=>{
    btn.addEventListener('click', ()=> deleteLocalProject(btn.dataset.deleteLocal));
  });
}

function openLocalProject(name, options = {}){
  const projects = getLocalProjects();
  const p = projects[name];
  if(!p) return;
  const suppressAlert = Boolean(options.suppressRestoreErrorAlert || suppressProjectRestoreErrorAlert);

  if(featuresData.size > 0 && !requestConfirmation('Abrir este projeto vai substituir as geometrias atuais no mapa. Continuar?')) return;

  try{
    clearMapLayerState();
  }catch(err){
    console.error('Erro ao limpar o estado anterior antes de abrir o projeto.', err);
  }

  // Tudo o que se segue lida com dados que podem estar em formatos antigos/incompletos
  // (ficheiros guardados antes de alguma alteração ao esquema). Isola-se num try/catch
  // para que um erro a interpretar geometrias antigas nunca impeça o passo seguinte
  // (marcar este projeto como "ativo") — é isso que garante que o botão "Guardar"
  // continua a saber em que projeto gravar, mesmo que algo aqui corra mal.
  try{
    if(p.layers && Array.isArray(p.layers) && p.layers.length){
      // formato novo: guarda todas as camadas (não só a última a ser editada)
      layerCounter = Number.isFinite(p.layerCounter) ? p.layerCounter : Math.max(...p.layers.map(l=>l.id), 0);
      activeLayerId = p.layers.some(l=>l.id === p.activeLayerId) ? p.activeLayerId : p.layers[p.layers.length-1].id;

      p.layers.forEach(l=>{
        layerVisible.set(l.id, l.visible !== false);
        if(l.id !== activeLayerId){
          layers.push({id:l.id, name:l.name, geometryType:l.geometryType, mode:l.mode, attributes:l.attributes || [], colorAttr:l.colorAttr || null, baseColor:l.baseColor || null, opacity: (l.opacity != null ? l.opacity : null), strokeColor: l.strokeColor || null, strokeWidth: l.strokeWidth != null ? l.strokeWidth : null, pointSize: l.pointSize != null ? l.pointSize : null, symbology: cloneSymbology(l.symbology)});
        }
      });

      const activeMeta = p.layers.find(l=>l.id === activeLayerId);
      config.mode = activeMeta ? (activeMeta.mode || null) : null;
      config.attributes = activeMeta ? (activeMeta.attributes || []) : [];
      config.geometryType = activeMeta ? (activeMeta.geometryType || null) : null;
      config.shapeName = activeMeta ? (activeMeta.name || null) : null;
      config.colorAttr = activeMeta ? (activeMeta.colorAttr || null) : null;
      config.baseColor = activeMeta ? (activeMeta.baseColor || null) : null;
      config.opacity = activeMeta && activeMeta.opacity != null ? activeMeta.opacity : null;
      config.strokeColor = activeMeta && activeMeta.strokeColor || null;
      config.strokeWidth = activeMeta && activeMeta.strokeWidth != null ? activeMeta.strokeWidth : null;
      config.pointSize = activeMeta && activeMeta.pointSize != null ? activeMeta.pointSize : null;
      config.symbology = cloneSymbology(activeMeta && activeMeta.symbology);

      // ordem de empilhamento no mapa: usa a guardada no projeto (se existir e continuar
      // válida), preenchendo com quaisquer camadas em falta para não desaparecerem do topo.
      const knownIds = p.layers.map(l=>l.id);
      if(Array.isArray(p.layerOrder) && p.layerOrder.length){
        layerOrder = p.layerOrder.filter(id=>knownIds.includes(id));
        knownIds.forEach(id=>{ if(!layerOrder.includes(id)) layerOrder.unshift(id); });
      } else {
        layerOrder = knownIds.slice();
      }

      if(p.geojson && p.geojson.features && p.geojson.features.length){
        importGeoJSONFeatures(p.geojson, (rawProps)=>{
          const lid = Number(rawProps.__layerId);
          return Number.isFinite(lid) ? lid : activeLayerId;
        });
        // esconde de novo as geometrias das camadas que estavam marcadas como ocultas
        featuresData.forEach(entry=>{
          if(layerVisible.get(entry.layerId) === false) drawnGroup.removeLayer(entry.layer);
        });
      } else {
        refreshFeatList();
      }
    } else {
      // formato antigo (projetos guardados antes de existir suporte a várias camadas)
      activeLayerId = ++layerCounter;
      layerVisible.set(activeLayerId, true);
      layerOrder = [activeLayerId];

      if(p.config){
        config.mode = p.config.mode || null;
        config.attributes = p.config.attributes || [];
        config.geometryType = p.config.geometryType || null;
        config.shapeName = p.config.shapeName || null;
        config.colorAttr = p.config.colorAttr || null;
        config.baseColor = p.config.baseColor || null;
        config.opacity = p.config.opacity != null ? p.config.opacity : null;
        config.strokeColor = p.config.strokeColor || null;
        config.strokeWidth = p.config.strokeWidth != null ? p.config.strokeWidth : null;
        config.pointSize = p.config.pointSize != null ? p.config.pointSize : null;
        config.symbology = cloneSymbology(p.config.symbology);
      }

      if(p.geojson && p.geojson.features && p.geojson.features.length){
        importGeoJSONFeatures(p.geojson);
      } else {
        refreshFeatList();
      }
    }
  }catch(err){
    console.error('Erro ao carregar geometrias do projeto guardado:', err);
    clearMapLayerState();
    activeLayerId = ++layerCounter;
    layerVisible.set(activeLayerId, true);
    layerOrder = [activeLayerId];
    config.mode = null;
    config.attributes = [];
    config.geometryType = null;
    config.shapeName = null;
    config.colorAttr = null;
    config.baseColor = null;
  config.opacity = null;
  config.strokeColor = null;
  config.strokeWidth = null;
  config.pointSize = null;
  config.symbology = defaultSymbology();
    if(!suppressAlert){
      showAppAlert('Não foi possível restaurar este projeto corretamente. O estado foi limpo e ficou pronto para começar de novo.', {error: true});
    }
  }

  applyLayerZOrder();
  finalizeLoadedProjectState();
  restoreRasterLayersFromProject(p.rasterLayers);

  localProjectState.name = name;
  localProjectState.active = true;
  projectDirty = false;
  try{ localStorage.setItem(ACTIVE_PROJECT_KEY, name); }catch(err){ /* ignora */ }

  if(document.getElementById('landing-banner') && !document.getElementById('landing-banner').classList.contains('hidden')){
    document.getElementById('landing-banner').classList.add('hidden');
  }

  if(config.geometryType){
    applyGeometryConfig();
    setupSummary();
  }

  updateProjectStatusUI();
  document.getElementById('local-projects-overlay').classList.add('hidden');
  showTeamToast(`Projeto "${name}" aberto.`);
  refreshLayerEditability();
}

function deleteLocalProject(name){
  if(!requestConfirmation(`Eliminar o projeto "${name}" guardado neste dispositivo? Esta ação não pode ser desfeita.`)) return;
  const projects = getLocalProjects();
  delete projects[name];
  saveLocalProjects(projects);
  if(localProjectState.name === name){
    localProjectState.name = null;
    localProjectState.active = false;
    try{ localStorage.removeItem(ACTIVE_PROJECT_KEY); }catch(err){ /* ignora */ }
    updateProjectStatusUI();
  }
  renderLocalProjectsList();
}

/* --- Expõe no window para05-app-main.js e outros módulos --- */
window.getLocalProjects = getLocalProjects;
window.saveLocalProjects = saveLocalProjects;
window.openLocalProject = openLocalProject;
window.deleteLocalProject = deleteLocalProject;
window.renderLocalProjectsList = renderLocalProjectsList;
window.updateProjectStatusUI = updateProjectStatusUI;
window.clearLocalProjectState = clearLocalProjectState;
window.clearMapLayerState = clearMapLayerState;
window.saveCurrentProject = saveCurrentProject;
window.markProjectDirty = markProjectDirty;
window.enableAutoSave = enableAutoSave;
window.disableAutoSave = disableAutoSave;
window.serializeLayerSchemasForGeoJSON = serializeLayerSchemasForGeoJSON;
window.restoreLayerSchemasFromGeoJSON = restoreLayerSchemasFromGeoJSON;
window.inferLayerAttributesFromProps = inferLayerAttributesFromProps;
window.ensureActiveLayerForImportedProject = ensureActiveLayerForImportedProject;
window.finalizeLoadedProjectState = finalizeLoadedProjectState;
window.validateStartProjectContinue = validateStartProjectContinue;
window.hideStartProjectWarning = hideStartProjectWarning;
window.showAutosaveToast = showAutosaveToast;
window.pulseSaveIcon = pulseSaveIcon;

Object.defineProperty(window, 'localProjectState', {
  get: function(){ return localProjectState; },
  set: function(v){ localProjectState = v; },
  configurable: true
});
Object.defineProperty(window, 'startProjectChoice', {
  get: function(){ return startProjectChoice; },
  set: function(v){ startProjectChoice = v; },
  configurable: true
});
Object.defineProperty(window, 'projectDirty', {
  get: function(){ return projectDirty; },
  set: function(v){ projectDirty = v; },
  configurable: true
});
Object.defineProperty(window, 'autoSaveEnabled', {
  get: function(){ return autoSaveEnabled; },
  set: function(v){ autoSaveEnabled = v; },
  configurable: true
});
Object.defineProperty(window, 'autoSaveInterval', {
  get: function(){ return autoSaveInterval; },
  set: function(v){ autoSaveInterval = v; },
  configurable: true
});

})();
