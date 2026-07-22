/* ============================================================
   ESTADO GLOBAL
   ============================================================ */
let config = {
  shapeName: null,      // nome dado à "shape"/camada (ex: "Estradas") — mostrado no painel
  mode: null,          // 'simples' | 'atributos'
  attributes: [],       // [{name, type:'texto'|'numero'|'categorico', classes:[{name,color}]}]
  geometryType: null,    // 'Point' | 'LineString' | 'Polygon'
  colorAttr: null,      // nome do atributo categórico atualmente usado para colorir a shape (legado)
  baseColor: null,      // cor única da camada, usada quando não há (ou não se está a usar) simbologia
  opacity: null,         // transparência do preenchimento (0-100); null = usa o valor por omissão
  symbology: null        // {mode:'simples'|'unicos'|'graduado', attr, method, classCount, breaks, uniqueValues} — ver defaultSymbology()
};

/* Suporte a múltiplas camadas simultâneas no painel:
   - "layers" guarda as camadas já fechadas (criadas antes da atual)
   - "activeLayerId" identifica a camada em que se está a desenhar agora (representada por "config")
   - "layerVisible" controla se cada camada (incl. a ativa) está visível no mapa */
let layerCounter = 0;
let activeLayerId = 0;
let symbologyLayerId = null;  // camada cujo painel de simbologia está aberto (null = fechado)
let layers = []; // [{id, name, geometryType, mode, attributes, colorAttr}]
let layerVisible = new Map([[0, true]]);

/* Ordem de empilhamento das camadas no mapa (índice 0 = topo/mais à frente,
   último índice = fundo/mais atrás). Controlada ao arrastar as linhas no painel. */
let layerOrder = [0];
let layerPanes = new Map(); // layerId -> nome do pane Leaflet dedicado a essa camada

let featureCounter = 0;
let featuresData = new Map(); // leafletLayerId -> {layer, props}
let drawnGroup;
let measuresGroup; // etiquetas com as medidas dos lados (modo "Medidas" por geometria)
let rulerGroup; // linha e etiquetas da ferramenta de régua (medição livre, não é uma geometria do projeto)
let map;
let activeBaseLayerKey = 'satelite';
let basemapLayers = null;

let workspaces = [];
let currentWorkspaceId = null;
let currentWorkspace = null;

let suppressProjectRestoreErrorAlert = false;
let pendingExitAction = null;

function createWorkspaceState(id, name){
  return {
    id,
    name,
    config: {
      shapeName: null,
      mode: null,
      attributes: [],
      geometryType: null,
      colorAttr: null,
      baseColor: null,
      opacity: null,
      symbology: defaultSymbology()
    },
    layerCounter: 0,
    activeLayerId: 0,
    symbologyLayerId: null,
    layers: [],
    layerVisible: new Map([[0, true]]),
    layerOrder: [0],
    layerPanes: new Map(),
    featureCounter: 0,
    featuresData: new Map(),
    drawnGroup: null,
    measuresGroup: null,
    rulerGroup: null,
    projectDirty: false,
    localProjectState: {name:null, active:false},
    mapView: { center: [20, 0], zoom: 2 },
    activeBaseLayerKey: 'satelite'
  };
}

function cloneAttributes(attributes){
  return Array.isArray(attributes) ? attributes.map(attr=>({
    ...attr,
    classes: Array.isArray(attr && attr.classes) ? attr.classes.map(cls=>({...cls})) : []
  })) : [];
}

function cloneConfig(source){
  return {
    shapeName: source && source.shapeName != null ? source.shapeName : null,
    mode: source && source.mode ? source.mode : null,
    attributes: cloneAttributes(source && source.attributes),
    geometryType: source && source.geometryType ? source.geometryType : null,
    colorAttr: source && source.colorAttr ? source.colorAttr : null,
    baseColor: source && source.baseColor ? source.baseColor : null,
    opacity: source && source.opacity != null ? source.opacity : null,
    symbology: cloneSymbology(source && source.symbology)
  };
}

function persistCurrentWorkspaceState(){
  if(!currentWorkspace) return;
  currentWorkspace.config = cloneConfig(config);
  currentWorkspace.layers = layers.map(layer=>({
    ...layer,
    attributes: cloneAttributes(layer && layer.attributes),
    symbology: cloneSymbology(layer && layer.symbology)
  }));
  currentWorkspace.layerCounter = layerCounter;
  currentWorkspace.activeLayerId = activeLayerId;
  currentWorkspace.symbologyLayerId = symbologyLayerId;
  currentWorkspace.layerVisible = new Map(layerVisible);
  currentWorkspace.layerOrder = layerOrder.slice();
  currentWorkspace.layerPanes = new Map(layerPanes);
  currentWorkspace.featureCounter = featureCounter;
  currentWorkspace.featuresData = featuresData;
  currentWorkspace.drawnGroup = drawnGroup;
  currentWorkspace.measuresGroup = measuresGroup;
  currentWorkspace.rulerGroup = rulerGroup;
  currentWorkspace.projectDirty = Boolean(projectDirty);
  currentWorkspace.localProjectState = { ...localProjectState };
  currentWorkspace.mapView = {
    center: map ? map.getCenter() : [20, 0],
    zoom: map ? map.getZoom() : 2
  };
  currentWorkspace.activeBaseLayerKey = activeBaseLayerKey;

  // GANCHO Layouts: se o módulo js/09-layouts.js estiver carregado, avisa-o
  // para resincronizar os frames que estejam a mostrar este workspace.
  if(typeof window.notifyLayoutsWorkspaceChanged === 'function'){
    window.notifyLayoutsWorkspaceChanged(currentWorkspace);
  }
}

function getWorkspaceById(id){ return workspaces.find(ws=>ws.id===id) || null; }
function getCurrentWorkspace(){ return currentWorkspace || null; }

function ensureWorkspaceMapGroups(workspace){
  if(!workspace) return;
  if(!workspace.drawnGroup) workspace.drawnGroup = L.featureGroup();
  if(!workspace.measuresGroup) workspace.measuresGroup = L.layerGroup();
  if(!workspace.rulerGroup) workspace.rulerGroup = L.layerGroup();
}

function ensureWorkspaceBasemap(key){
  if(!map || !basemapLayers) return;
  const target = basemapLayers[key];
  if(!target) return;
  Object.values(basemapLayers).forEach(layer=>{
    if(layer !== target && map.hasLayer(layer)) map.removeLayer(layer);
  });
  if(!map.hasLayer(target)) target.addTo(map);
  activeBaseLayerKey = key;
  document.querySelectorAll('#basemap-menu button[data-basemap]').forEach(btn=>{
    btn.classList.toggle('is-active', btn.dataset.basemap === activeBaseLayerKey);
  });
}

function applyWorkspaceState(workspace){
  if(!workspace) return;
  // GANCHO Layouts: se estivermos a ver uma página de Layout, fecha-a e volta
  // à vista normal de Workspace (no-op seguro se js/09-layouts.js não existir).
  if(typeof window.leaveLayoutView === 'function') window.leaveLayoutView();
  persistCurrentWorkspaceState();
  currentWorkspace = workspace;
  currentWorkspaceId = workspace.id;
  config = cloneConfig(workspace.config || {});
  layers = Array.isArray(workspace.layers) ? workspace.layers.map(layer=>({
    ...layer,
    attributes: cloneAttributes(layer && layer.attributes),
    symbology: cloneSymbology(layer && layer.symbology)
  })) : [];
  layerCounter = Number.isFinite(workspace.layerCounter) ? workspace.layerCounter : 0;
  activeLayerId = Number.isFinite(workspace.activeLayerId) ? workspace.activeLayerId : 0;
  symbologyLayerId = workspace.symbologyLayerId || null;
  layerVisible = workspace.layerVisible instanceof Map ? new Map(workspace.layerVisible) : new Map([[0, true]]);
  layerOrder = Array.isArray(workspace.layerOrder) ? workspace.layerOrder.slice() : [0];
  layerPanes = workspace.layerPanes instanceof Map ? new Map(workspace.layerPanes) : new Map();
  featureCounter = Number.isFinite(workspace.featureCounter) ? workspace.featureCounter : 0;
  featuresData = workspace.featuresData instanceof Map ? workspace.featuresData : new Map();
  projectDirty = Boolean(workspace.projectDirty);
  localProjectState = workspace.localProjectState ? { ...workspace.localProjectState } : { name:null, active:false };
  activeBaseLayerKey = workspace.activeBaseLayerKey || 'satelite';
  window.__activeBaseLayerKey = activeBaseLayerKey;
  if(map){
    if(drawnGroup && map.hasLayer(drawnGroup)) map.removeLayer(drawnGroup);
    if(measuresGroup && map.hasLayer(measuresGroup)) map.removeLayer(measuresGroup);
    if(rulerGroup && map.hasLayer(rulerGroup)) map.removeLayer(rulerGroup);
    ensureWorkspaceMapGroups(workspace);
    drawnGroup = workspace.drawnGroup;
    measuresGroup = workspace.measuresGroup;
    rulerGroup = workspace.rulerGroup;
    if(!map.hasLayer(drawnGroup)) map.addLayer(drawnGroup);
    if(!map.hasLayer(measuresGroup)) map.addLayer(measuresGroup);
    if(!map.hasLayer(rulerGroup)) map.addLayer(rulerGroup);
    if(workspace.mapView && workspace.mapView.center){
      map.setView(workspace.mapView.center, workspace.mapView.zoom || map.getZoom());
    }
  } else {
    drawnGroup = workspace.drawnGroup;
    measuresGroup = workspace.measuresGroup;
    rulerGroup = workspace.rulerGroup;
  }
  if(typeof __rehookStateConsistency === 'function') __rehookStateConsistency();
  ensureWorkspaceBasemap(activeBaseLayerKey || 'satelite');
  renderWorkspaceTabs();
  refreshLayerEditability();
  refreshFeatList();
  renderLayersPanel();
  updateProjectStatusUI();
}

function renderWorkspaceTabs(){
  const container = document.getElementById('workspace-tabs');
  if(!container) return;
  container.innerHTML = '';
  const canClose = workspaces.length > 1;
  workspaces.forEach(workspace=>{
    const inLayoutView = typeof window.isLayoutViewActive === 'function' && window.isLayoutViewActive();
    const tab = document.createElement('div');
    tab.className = 'workspace-tab' + (workspace.id === currentWorkspaceId && !inLayoutView ? ' is-active' : '');
    tab.dataset.workspaceId = workspace.id;
    tab.setAttribute('role', 'button');
    tab.tabIndex = 0;

    const label = document.createElement('span');
    label.className = 'workspace-tab-label';
    label.textContent = workspace.name || 'Mapa';
    tab.appendChild(label);

    if(canClose){
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'workspace-tab-close';
      closeBtn.title = 'Fechar mapa';
      closeBtn.setAttribute('aria-label', 'Fechar mapa');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        closeWorkspace(workspace.id);
      });
      tab.appendChild(closeBtn);
    }

    const activate = ()=>{
      const stillInLayout = typeof window.isLayoutViewActive === 'function' && window.isLayoutViewActive();
      if(workspace.id !== currentWorkspaceId || stillInLayout){ switchWorkspace(workspace.id); }
    };
    tab.addEventListener('click', activate);
    tab.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        activate();
      }
    });

    container.appendChild(tab);
  });

  // GANCHO Layouts: insere os separadores de Layout (se o módulo estiver carregado),
  // sempre antes do botão "+".
  if(typeof window.renderLayoutTabsInto === 'function'){
    window.renderLayoutTabsInto(container);
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'workspace-tab workspace-tab-add';
  addBtn.title = 'Adicionar mapa';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', ()=>{
    // GANCHO Layouts: se o módulo estiver carregado, o "+" abre o modal de escolha
    // ("Novo Workspace" / "Novo Layout") em vez de criar logo um workspace.
    if(typeof window.handleAddMapClick === 'function'){
      window.handleAddMapClick();
    } else {
      createAndActivateNewWorkspace();
    }
  });
  container.appendChild(addBtn);
}

function switchWorkspace(id){
  const inLayoutView = typeof window.isLayoutViewActive === 'function' && window.isLayoutViewActive();
  if(!id || (id === currentWorkspaceId && !inLayoutView)) return;
  const target = getWorkspaceById(id);
  if(!target) return;
  applyWorkspaceState(target);
}

/* Fecha (remove) um workspace: limpa as camadas/panes Leaflet associadas, retira-o
   do array e, se era o workspace ativo, troca para outro (o mais próximo na lista).
   Nunca permite fechar o último workspace restante — tem de existir sempre pelo
   menos um mapa aberto. */
function closeWorkspace(id){
  const target = getWorkspaceById(id);
  if(!target) return;

  if(workspaces.length <= 1){
    showAppAlert('Não é possível fechar o último mapa aberto.');
    return;
  }

  const label = target.name || 'este mapa';
  if(!requestConfirmation(`Fechar "${label}"? Todas as camadas e geometrias deste mapa serão eliminadas permanentemente.`)){
    return;
  }

  const isCurrent = target.id === currentWorkspaceId;
  const closingIndex = workspaces.indexOf(target);

  // remove do mapa os grupos Leaflet (desenhos, medidas, régua) deste workspace
  const groupsToClear = isCurrent
    ? [drawnGroup, measuresGroup, rulerGroup]
    : [target.drawnGroup, target.measuresGroup, target.rulerGroup];
  groupsToClear.forEach(group=>{
    if(group && map && map.hasLayer(group)) map.removeLayer(group);
  });

  // remove os panes dedicados às camadas deste workspace
  const panesToRemove = isCurrent
    ? layerPanes
    : (target.layerPanes instanceof Map ? target.layerPanes : new Map());
  panesToRemove.forEach(paneName=>{
    const pane = map && map.getPane(paneName);
    if(pane) pane.remove();
  });

  workspaces.splice(closingIndex, 1);

  if(isCurrent){
    // impede que applyWorkspaceState tente persistir estado no workspace descartado
    currentWorkspace = null;
    currentWorkspaceId = null;
    const nextIndex = Math.min(closingIndex, workspaces.length - 1);
    applyWorkspaceState(workspaces[nextIndex]);
  } else {
    renderWorkspaceTabs();
  }
}

function createAndActivateNewWorkspace(){
  const nextIndex = workspaces.length + 1;
  const workspace = createWorkspaceState(`workspace-${Date.now()}-${nextIndex}`, `Mapa ${nextIndex}`);
  workspace.activeBaseLayerKey = 'satelite';
  workspaces.push(workspace);
  applyWorkspaceState(workspace);
  ensureWorkspaceBasemap('satelite');

  const landingBanner = document.getElementById('landing-banner');
  if(landingBanner) landingBanner.classList.remove('hidden');

  const startOverlay = document.getElementById('start-project-overlay');
  if(startOverlay) startOverlay.classList.remove('hidden');

  const localProjectsOverlay = document.getElementById('local-projects-overlay');
  if(localProjectsOverlay) localProjectsOverlay.classList.add('hidden');

  const warning = document.getElementById('start-project-warning');
  if(warning){ warning.classList.add('hidden'); warning.textContent = ''; }

  startProjectChoice = null;
  const nameRow = document.getElementById('start-project-name-row');
  const nameError = document.getElementById('start-project-name-error');
  const continueBtn = document.getElementById('start-project-continue');
  if(nameRow) nameRow.classList.add('hidden');
  if(nameError) nameError.style.display = 'none';
  if(continueBtn) continueBtn.disabled = true;
  document.querySelectorAll('[data-start-choice]').forEach(card=>card.classList.remove('selected'));
  document.getElementById('start-project-name').value = '';

  if(map && map.invalidateSize){
    setTimeout(()=>map.invalidateSize(), 0);
  }
}

function initializeWorkspaces(){
  if(workspaces.length === 0){
    workspaces.push(createWorkspaceState('workspace-1', 'Mapa 1'));
  }
  if(!currentWorkspace){
    applyWorkspaceState(workspaces[0]);
  } else {
    renderWorkspaceTabs();
  }
}

const DEFAULT_COLOR = '#F5821F';
const DEFAULT_OPACITY = 35; // percentagem (0-100) usada quando a camada não tem opacidade definida
const TEAM_STORAGE_KEY = 'engenh-team-project';
let teamPanelVisible = false;
let cloudMenuView = 'home';
let cloudSyncMode = null;
let cloudSyncPlan = null;
let teamState = {
  savedSlug: '',
  savedName: '',
  slug: '',
  name: '',
  password: null,
  connected: false,
  lastSync: null,
  deletedFids: new Map(), // fid -> timestamp de eliminação (só nesta sessão)
  usedBytes: 0,
  sizeLimit: 200 * 1024 * 1024,
  status: 'idle'
};
const PALETTE = ['#F5821F','#C2703D','#6E726A','#234635','#E7A57A','#7FB894','#B5472B','#9B9E94'];

// ---------- limites de município (CAOP preview via GitHub) ----------
const MUNICIPIOS_GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/jdsm3011-alt/site_ofc/main/';
const MUNICIPIOS_INDEX = [{"m":"Albergaria-a-Velha","d":"Aveiro","p":"previews/Aveiro/Albergaria-a-Velha/caop_preview.geojson"},{"m":"Anadia","d":"Aveiro","p":"previews/Aveiro/Anadia/caop_preview.geojson"},{"m":"Arouca","d":"Aveiro","p":"previews/Aveiro/Arouca/caop_preview.geojson"},{"m":"Aveiro","d":"Aveiro","p":"previews/Aveiro/Aveiro/caop_preview.geojson"},{"m":"Castelo de Paiva","d":"Aveiro","p":"previews/Aveiro/Castelo_de_Paiva/caop_preview.geojson"},{"m":"Estarreja","d":"Aveiro","p":"previews/Aveiro/Estarreja/caop_preview.geojson"},{"m":"Mealhada","d":"Aveiro","p":"previews/Aveiro/Mealhada/caop_preview.geojson"},{"m":"Murtosa","d":"Aveiro","p":"previews/Aveiro/Murtosa/caop_preview.geojson"},{"m":"Oliveira de Azeméis","d":"Aveiro","p":"previews/Aveiro/Oliveira_de_Azeméis/caop_preview.geojson"},{"m":"Oliveira do Bairro","d":"Aveiro","p":"previews/Aveiro/Oliveira_do_Bairro/caop_preview.geojson"},{"m":"Ovar","d":"Aveiro","p":"previews/Aveiro/Ovar/caop_preview.geojson"},{"m":"Santa Maria da Feira","d":"Aveiro","p":"previews/Aveiro/Santa_Maria_da_Feira/caop_preview.geojson"},{"m":"Sever do Vouga","d":"Aveiro","p":"previews/Aveiro/Sever_do_Vouga/caop_preview.geojson"},{"m":"São João da Madeira","d":"Aveiro","p":"previews/Aveiro/São_João_da_Madeira/caop_preview.geojson"},{"m":"Vagos","d":"Aveiro","p":"previews/Aveiro/Vagos/caop_preview.geojson"},{"m":"Vale de Cambra","d":"Aveiro","p":"previews/Aveiro/Vale_de_Cambra/caop_preview.geojson"},{"m":"Águeda","d":"Aveiro","p":"previews/Aveiro/Águeda/caop_preview.geojson"},{"m":"Ílhavo","d":"Aveiro","p":"previews/Aveiro/Ílhavo/caop_preview.geojson"},{"m":"Aljustrel","d":"Beja","p":"previews/Beja/Aljustrel/caop_preview.geojson"},{"m":"Almodôvar","d":"Beja","p":"previews/Beja/Almodôvar/caop_preview.geojson"},{"m":"Alvito","d":"Beja","p":"previews/Beja/Alvito/caop_preview.geojson"},{"m":"Barrancos","d":"Beja","p":"previews/Beja/Barrancos/caop_preview.geojson"},{"m":"Beja","d":"Beja","p":"previews/Beja/Beja/caop_preview.geojson"},{"m":"Castro Verde","d":"Beja","p":"previews/Beja/Castro_Verde/caop_preview.geojson"},{"m":"Cuba","d":"Beja","p":"previews/Beja/Cuba/caop_preview.geojson"},{"m":"Ferreira do Alentejo","d":"Beja","p":"previews/Beja/Ferreira_do_Alentejo/caop_preview.geojson"},{"m":"Moura","d":"Beja","p":"previews/Beja/Moura/caop_preview.geojson"},{"m":"Mértola","d":"Beja","p":"previews/Beja/Mértola/caop_preview.geojson"},{"m":"Serpa","d":"Beja","p":"previews/Beja/Serpa/caop_preview.geojson"},{"m":"Vidigueira","d":"Beja","p":"previews/Beja/Vidigueira/caop_preview.geojson"},{"m":"Amares","d":"Braga","p":"previews/Braga/Amares/caop_preview.geojson"},{"m":"Barcelos","d":"Braga","p":"previews/Braga/Barcelos/caop_preview.geojson"},{"m":"Guimarães","d":"Braga","p":"previews/Braga/Guimarães/caop_preview.geojson"},{"m":"Braga","d":"Braga","p":"previews/Braga/Braga/caop_preview.geojson"},{"m":"Cabeceiras de Basto","d":"Braga","p":"previews/Braga/Cabeceiras_de_Basto/caop_preview.geojson"},{"m":"Celorico de Basto","d":"Braga","p":"previews/Braga/Celorico_de_Basto/caop_preview.geojson"},{"m":"Esposende","d":"Braga","p":"previews/Braga/Esposende/caop_preview.geojson"},{"m":"Fafe","d":"Braga","p":"previews/Braga/Fafe/caop_preview.geojson"},{"m":"Póvoa de Lanhoso","d":"Braga","p":"previews/Braga/Póvoa_de_Lanhoso/caop_preview.geojson"},{"m":"Terras de Bouro","d":"Braga","p":"previews/Braga/Terras_de_Bouro/caop_preview.geojson"},{"m":"Vieira do Minho","d":"Braga","p":"previews/Braga/Vieira_do_Minho/caop_preview.geojson"},{"m":"Vila Nova de Famalicão","d":"Braga","p":"previews/Braga/Vila_Nova_de_Famalicão/caop_preview.geojson"},{"m":"Vila Verde","d":"Braga","p":"previews/Braga/Vila_Verde/caop_preview.geojson"},{"m":"Vizela","d":"Braga","p":"previews/Braga/Vizela/caop_preview.geojson"},{"m":"Alfândega da Fé","d":"Bragança","p":"previews/Bragança/Alfândega_da_Fé/caop_preview.geojson"},{"m":"Bragança","d":"Bragança","p":"previews/Bragança/Bragança/caop_preview.geojson"},{"m":"Carrazeda de Ansiães","d":"Bragança","p":"previews/Bragança/Carrazeda_de_Ansiães/caop_preview.geojson"},{"m":"Freixo de Espada à Cinta","d":"Bragança","p":"previews/Bragança/Freixo_de_Espada_à_Cinta/caop_preview.geojson"},{"m":"Macedo de Cavaleiros","d":"Bragança","p":"previews/Bragança/Macedo_de_Cavaleiros/caop_preview.geojson"},{"m":"Miranda do Douro","d":"Bragança","p":"previews/Bragança/Miranda_do_Douro/caop_preview.geojson"},{"m":"Mirandela","d":"Bragança","p":"previews/Bragança/Mirandela/caop_preview.geojson"},{"m":"Mogadouro","d":"Bragança","p":"previews/Bragança/Mogadouro/caop_preview.geojson"},{"m":"Torre de Moncorvo","d":"Bragança","p":"previews/Bragança/Torre_de_Moncorvo/caop_preview.geojson"},{"m":"Vila Flor","d":"Bragança","p":"previews/Bragança/Vila_Flor/caop_preview.geojson"},{"m":"Vimioso","d":"Bragança","p":"previews/Bragança/Vimioso/caop_preview.geojson"},{"m":"Vinhais","d":"Bragança","p":"previews/Bragança/Vinhais/caop_preview.geojson"},{"m":"Belmonte","d":"Castelo Branco","p":"previews/Castelo_Branco/Belmonte/caop_preview.geojson"},{"m":"Castelo Branco","d":"Castelo Branco","p":"previews/Castelo_Branco/Castelo_Branco/caop_preview.geojson"},{"m":"Covilhã","d":"Castelo Branco","p":"previews/Castelo_Branco/Covilhã/caop_preview.geojson"},{"m":"Fundão","d":"Castelo Branco","p":"previews/Castelo_Branco/Fundão/caop_preview.geojson"},{"m":"Idanha-a-Nova","d":"Castelo Branco","p":"previews/Castelo_Branco/Idanha-a-Nova/caop_preview.geojson"},{"m":"Oleiros","d":"Castelo Branco","p":"previews/Castelo_Branco/Oleiros/caop_preview.geojson"},{"m":"Penamacor","d":"Castelo Branco","p":"previews/Castelo_Branco/Penamacor/caop_preview.geojson"},{"m":"Proença-a-Nova","d":"Castelo Branco","p":"previews/Castelo_Branco/Proença-a-Nova/caop_preview.geojson"},{"m":"Sertã","d":"Castelo Branco","p":"previews/Castelo_Branco/Sertã/caop_preview.geojson"},{"m":"Vila Velha de Ródão","d":"Castelo Branco","p":"previews/Castelo_Branco/Vila_Velha_de_Ródão/caop_preview.geojson"},{"m":"Vila de Rei","d":"Castelo Branco","p":"previews/Castelo_Branco/Vila_de_Rei/caop_preview.geojson"},{"m":"Arganil","d":"Coimbra","p":"previews/Coimbra/Arganil/caop_preview.geojson"},{"m":"Cantanhede","d":"Coimbra","p":"previews/Coimbra/Cantanhede/caop_preview.geojson"},{"m":"Coimbra","d":"Coimbra","p":"previews/Coimbra/Coimbra/caop_preview.geojson"},{"m":"Condeixa-a-Nova","d":"Coimbra","p":"previews/Coimbra/Condeixa-a-Nova/caop_preview.geojson"},{"m":"Figueira da Foz","d":"Coimbra","p":"previews/Coimbra/Figueira_da_Foz/caop_preview.geojson"},{"m":"Góis","d":"Coimbra","p":"previews/Coimbra/Góis/caop_preview.geojson"},{"m":"Lousã","d":"Coimbra","p":"previews/Coimbra/Lousã/caop_preview.geojson"},{"m":"Miranda do Corvo","d":"Coimbra","p":"previews/Coimbra/Miranda_do_Corvo/caop_preview.geojson"},{"m":"Montemor-o-Velho","d":"Coimbra","p":"previews/Coimbra/Montemor-o-Velho/caop_preview.geojson"},{"m":"Oliveira do Hospital","d":"Coimbra","p":"previews/Coimbra/Oliveira_do_Hospital/caop_preview.geojson"},{"m":"Pampilhosa da Serra","d":"Coimbra","p":"previews/Coimbra/Pampilhosa_da_Serra/caop_preview.geojson"},{"m":"Penacova","d":"Coimbra","p":"previews/Coimbra/Penacova/caop_preview.geojson"},{"m":"Penela","d":"Coimbra","p":"previews/Coimbra/Penela/caop_preview.geojson"},{"m":"Soure","d":"Coimbra","p":"previews/Coimbra/Soure/caop_preview.geojson"},{"m":"Tábua","d":"Coimbra","p":"previews/Coimbra/Tábua/caop_preview.geojson"},{"m":"Vila Nova de Poiares","d":"Coimbra","p":"previews/Coimbra/Vila_Nova_de_Poiares/caop_preview.geojson"},{"m":"Albufeira","d":"Faro","p":"previews/Faro/Albufeira/caop_preview.geojson"},{"m":"Alcoutim","d":"Faro","p":"previews/Faro/Alcoutim/caop_preview.geojson"},{"m":"Aljezur","d":"Faro","p":"previews/Faro/Aljezur/caop_preview.geojson"},{"m":"Castro Marim","d":"Faro","p":"previews/Faro/Castro_Marim/caop_preview.geojson"},{"m":"Faro","d":"Faro","p":"previews/Faro/Faro/caop_preview.geojson"},{"m":"Lagoa","d":"Faro","p":"previews/Faro/Lagoa/caop_preview.geojson"},{"m":"Loulé","d":"Faro","p":"previews/Faro/Loulé/caop_preview.geojson"},{"m":"Monchique","d":"Faro","p":"previews/Faro/Monchique/caop_preview.geojson"},{"m":"Olhão","d":"Faro","p":"previews/Faro/Olhão/caop_preview.geojson"},{"m":"Portimão","d":"Faro","p":"previews/Faro/Portimão/caop_preview.geojson"},{"m":"Silves","d":"Faro","p":"previews/Faro/Silves/caop_preview.geojson"},{"m":"São Brás de Alportel","d":"Faro","p":"previews/Faro/São_Brás_de_Alportel/caop_preview.geojson"},{"m":"Tavira","d":"Faro","p":"previews/Faro/Tavira/caop_preview.geojson"},{"m":"Vila Real de Santo António","d":"Faro","p":"previews/Faro/Vila_Real_de_Santo_António/caop_preview.geojson"},{"m":"Aguiar da Beira","d":"Guarda","p":"previews/Guarda/Aguiar_da_Beira/caop_preview.geojson"},{"m":"Almeida","d":"Guarda","p":"previews/Guarda/Almeida/caop_preview.geojson"},{"m":"Celorico da Beira","d":"Guarda","p":"previews/Guarda/Celorico_da_Beira/caop_preview.geojson"},{"m":"Fornos de Algodres","d":"Guarda","p":"previews/Guarda/Fornos_de_Algodres/caop_preview.geojson"},{"m":"Gouveia","d":"Guarda","p":"previews/Guarda/Gouveia/caop_preview.geojson"},{"m":"Guarda","d":"Guarda","p":"previews/Guarda/Guarda/caop_preview.geojson"},{"m":"Manteigas","d":"Guarda","p":"previews/Guarda/Manteigas/caop_preview.geojson"},{"m":"Mêda","d":"Guarda","p":"previews/Guarda/Mêda/caop_preview.geojson"},{"m":"Pinhel","d":"Guarda","p":"previews/Guarda/Pinhel/caop_preview.geojson"},{"m":"Sabugal","d":"Guarda","p":"previews/Guarda/Sabugal/caop_preview.geojson"},{"m":"Seia","d":"Guarda","p":"previews/Guarda/Seia/caop_preview.geojson"},{"m":"Trancoso","d":"Guarda","p":"previews/Guarda/Trancoso/caop_preview.geojson"},{"m":"Alcobaça","d":"Leiria","p":"previews/Leiria/Alcobaça/caop_preview.geojson"},{"m":"Alvaiázere","d":"Leiria","p":"previews/Leiria/Alvaiázere/caop_preview.geojson"},{"m":"Ansião","d":"Leiria","p":"previews/Leiria/Ansião/caop_preview.geojson"},{"m":"Batalha","d":"Leiria","p":"previews/Leiria/Batalha/caop_preview.geojson"},{"m":"Bombarral","d":"Leiria","p":"previews/Leiria/Bombarral/caop_preview.geojson"},{"m":"Castanheira de Pêra","d":"Leiria","p":"previews/Leiria/Castanheira_de_Pêra/caop_preview.geojson"},{"m":"Figueiró dos Vinhos","d":"Leiria","p":"previews/Leiria/Figueiró_dos_Vinhos/caop_preview.geojson"},{"m":"Leiria","d":"Leiria","p":"previews/Leiria/Leiria/caop_preview.geojson"},{"m":"Marinha Grande","d":"Leiria","p":"previews/Leiria/Marinha_Grande/caop_preview.geojson"},{"m":"Nazaré","d":"Leiria","p":"previews/Leiria/Nazaré/caop_preview.geojson"},{"m":"Pedrógão Grande","d":"Leiria","p":"previews/Leiria/Pedrógão_Grande/caop_preview.geojson"},{"m":"Pombal","d":"Leiria","p":"previews/Leiria/Pombal/caop_preview.geojson"},{"m":"Porto de Mós","d":"Leiria","p":"previews/Leiria/Porto_de_Mós/caop_preview.geojson"},{"m":"Óbidos","d":"Leiria","p":"previews/Leiria/Óbidos/caop_preview.geojson"},{"m":"Alenquer","d":"Lisboa","p":"previews/Lisboa/Alenquer/caop_preview.geojson"},{"m":"Amadora","d":"Lisboa","p":"previews/Lisboa/Amadora/caop_preview.geojson"},{"m":"Arruda dos Vinhos","d":"Lisboa","p":"previews/Lisboa/Arruda_dos_Vinhos/caop_preview.geojson"},{"m":"Azambuja","d":"Lisboa","p":"previews/Lisboa/Azambuja/caop_preview.geojson"},{"m":"Cadaval","d":"Lisboa","p":"previews/Lisboa/Cadaval/caop_preview.geojson"},{"m":"Cascais","d":"Lisboa","p":"previews/Lisboa/Cascais/caop_preview.geojson"},{"m":"Lisboa","d":"Lisboa","p":"previews/Lisboa/Lisboa/caop_preview.geojson"},{"m":"Loures","d":"Lisboa","p":"previews/Lisboa/Loures/caop_preview.geojson"},{"m":"Lourinhã","d":"Lisboa","p":"previews/Lisboa/Lourinhã/caop_preview.geojson"},{"m":"Odivelas","d":"Lisboa","p":"previews/Lisboa/Odivelas/caop_preview.geojson"},{"m":"Oeiras","d":"Lisboa","p":"previews/Lisboa/Oeiras/caop_preview.geojson"},{"m":"Sintra","d":"Lisboa","p":"previews/Lisboa/Sintra/caop_preview.geojson"},{"m":"Sobral de Monte Agraço","d":"Lisboa","p":"previews/Lisboa/Sobral_de_Monte_Agraço/caop_preview.geojson"},{"m":"Vila Franca de Xira","d":"Lisboa","p":"previews/Lisboa/Vila_Franca_de_Xira/caop_preview.geojson"},{"m":"Alter do Chão","d":"Portalegre","p":"previews/Portalegre/Alter_do_Chão/caop_preview.geojson"},{"m":"Arronches","d":"Portalegre","p":"previews/Portalegre/Arronches/caop_preview.geojson"},{"m":"Avis","d":"Portalegre","p":"previews/Portalegre/Avis/caop_preview.geojson"},{"m":"Campo Maior","d":"Portalegre","p":"previews/Portalegre/Campo_Maior/caop_preview.geojson"},{"m":"Castelo de Vide","d":"Portalegre","p":"previews/Portalegre/Castelo_de_Vide/caop_preview.geojson"},{"m":"Crato","d":"Portalegre","p":"previews/Portalegre/Crato/caop_preview.geojson"},{"m":"Elvas","d":"Portalegre","p":"previews/Portalegre/Elvas/caop_preview.geojson"},{"m":"Fronteira","d":"Portalegre","p":"previews/Portalegre/Fronteira/caop_preview.geojson"},{"m":"Gavião","d":"Portalegre","p":"previews/Portalegre/Gavião/caop_preview.geojson"},{"m":"Marvão","d":"Portalegre","p":"previews/Portalegre/Marvão/caop_preview.geojson"},{"m":"Monforte","d":"Portalegre","p":"previews/Portalegre/Monforte/caop_preview.geojson"},{"m":"Nisa","d":"Portalegre","p":"previews/Portalegre/Nisa/caop_preview.geojson"},{"m":"Ponte de Sor","d":"Portalegre","p":"previews/Portalegre/Ponte_de_Sor/caop_preview.geojson"},{"m":"Portalegre","d":"Portalegre","p":"previews/Portalegre/Portalegre/caop_preview.geojson"},{"m":"Sousel","d":"Portalegre","p":"previews/Portalegre/Sousel/caop_preview.geojson"},{"m":"Amarante","d":"Porto","p":"previews/Porto/Amarante/caop_preview.geojson"},{"m":"Baião","d":"Porto","p":"previews/Porto/Baião/caop_preview.geojson"},{"m":"Felgueiras","d":"Porto","p":"previews/Porto/Felgueiras/caop_preview.geojson"},{"m":"Gondomar","d":"Porto","p":"previews/Porto/Gondomar/caop_preview.geojson"},{"m":"Lousada","d":"Porto","p":"previews/Porto/Lousada/caop_preview.geojson"},{"m":"Maia","d":"Porto","p":"previews/Porto/Maia/caop_preview.geojson"},{"m":"Marco de Canaveses","d":"Porto","p":"previews/Porto/Marco_de_Canaveses/caop_preview.geojson"},{"m":"Matosinhos","d":"Porto","p":"previews/Porto/Matosinhos/caop_preview.geojson"},{"m":"Paredes","d":"Porto","p":"previews/Porto/Paredes/caop_preview.geojson"},{"m":"Paços de Ferreira","d":"Porto","p":"previews/Porto/Paços_de_Ferreira/caop_preview.geojson"},{"m":"Penafiel","d":"Porto","p":"previews/Porto/Penafiel/caop_preview.geojson"},{"m":"Porto","d":"Porto","p":"previews/Porto/Porto/caop_preview.geojson"},{"m":"Póvoa de Varzim","d":"Porto","p":"previews/Porto/Póvoa_de_Varzim/caop_preview.geojson"},{"m":"Santo Tirso","d":"Porto","p":"previews/Porto/Santo_Tirso/caop_preview.geojson"},{"m":"Trofa","d":"Porto","p":"previews/Porto/Trofa/caop_preview.geojson"},{"m":"Valongo","d":"Porto","p":"previews/Porto/Valongo/caop_preview.geojson"},{"m":"Vila do Conde","d":"Porto","p":"previews/Porto/Vila_do_Conde/caop_preview.geojson"},{"m":"Abrantes","d":"Santarém","p":"previews/Santarém/Abrantes/caop_preview.geojson"},{"m":"Almeirim","d":"Santarém","p":"previews/Santarém/Almeirim/caop_preview.geojson"},{"m":"Alpiarça","d":"Santarém","p":"previews/Santarém/Alpiarça/caop_preview.geojson"},{"m":"Benavente","d":"Santarém","p":"previews/Santarém/Benavente/caop_preview.geojson"},{"m":"Cartaxo","d":"Santarém","p":"previews/Santarém/Cartaxo/caop_preview.geojson"},{"m":"Chamusca","d":"Santarém","p":"previews/Santarém/Chamusca/caop_preview.geojson"},{"m":"Constância","d":"Santarém","p":"previews/Santarém/Constância/caop_preview.geojson"},{"m":"Coruche","d":"Santarém","p":"previews/Santarém/Coruche/caop_preview.geojson"},{"m":"Entroncamento","d":"Santarém","p":"previews/Santarém/Entroncamento/caop_preview.geojson"},{"m":"Ferreira do Zêzere","d":"Santarém","p":"previews/Santarém/Ferreira_do_Zêzere/caop_preview.geojson"},{"m":"Golegã","d":"Santarém","p":"previews/Santarém/Golegã/caop_preview.geojson"},{"m":"Mação","d":"Santarém","p":"previews/Santarém/Mação/caop_preview.geojson"},{"m":"Ourém","d":"Santarém","p":"previews/Santarém/Ourém/caop_preview.geojson"},{"m":"Rio Maior","d":"Santarém","p":"previews/Santarém/Rio_Maior/caop_preview.geojson"},{"m":"Salvaterra de Magos","d":"Santarém","p":"previews/Santarém/Salvaterra_de_Magos/caop_preview.geojson"},{"m":"Santarém","d":"Santarém","p":"previews/Santarém/Santarém/caop_preview.geojson"},{"m":"Sardoal","d":"Santarém","p":"previews/Santarém/Sardoal/caop_preview.geojson"},{"m":"Tomar","d":"Santarém","p":"previews/Santarém/Tomar/caop_preview.geojson"},{"m":"Torres Novas","d":"Santarém","p":"previews/Santarém/Torres_Novas/caop_preview.geojson"},{"m":"Vila Nova da Barquinha","d":"Santarém","p":"previews/Santarém/Vila_Nova_da_Barquinha/caop_preview.geojson"},{"m":"Alcochete","d":"Setúbal","p":"previews/Setúbal/Alcochete/caop_preview.geojson"},{"m":"Alcácer do Sal","d":"Setúbal","p":"previews/Setúbal/Alcácer_do_Sal/caop_preview.geojson"},{"m":"Almada","d":"Setúbal","p":"previews/Setúbal/Almada/caop_preview.geojson"},{"m":"Barreiro","d":"Setúbal","p":"previews/Setúbal/Barreiro/caop_preview.geojson"},{"m":"Grândola","d":"Setúbal","p":"previews/Setúbal/Grândola/caop_preview.geojson"},{"m":"Moita","d":"Setúbal","p":"previews/Setúbal/Moita/caop_preview.geojson"},{"m":"Montijo","d":"Setúbal","p":"previews/Setúbal/Montijo/caop_preview.geojson"},{"m":"Palmela","d":"Setúbal","p":"previews/Setúbal/Palmela/caop_preview.geojson"},{"m":"Santiago do Cacém","d":"Setúbal","p":"previews/Setúbal/Santiago_do_Cacém/caop_preview.geojson"},{"m":"Seixal","d":"Setúbal","p":"previews/Setúbal/Seixal/caop_preview.geojson"},{"m":"Setúbal","d":"Setúbal","p":"previews/Setúbal/Setúbal/caop_preview.geojson"},{"m":"Arcos de Valdevez","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Arcos_de_Valdevez/caop_preview.geojson"},{"m":"Caminha","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Caminha/caop_preview.geojson"},{"m":"Melgaço","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Melgaço/caop_preview.geojson"},{"m":"Monção","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Monção/caop_preview.geojson"},{"m":"Paredes de Coura","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Paredes_de_Coura/caop_preview.geojson"},{"m":"Ponte da Barca","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Ponte_da_Barca/caop_preview.geojson"},{"m":"Ponte de Lima","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Ponte_de_Lima/caop_preview.geojson"},{"m":"Valença","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Valença/caop_preview.geojson"},{"m":"Viana do Castelo","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Viana_do_Castelo/caop_preview.geojson"},{"m":"Vila Nova de Cerveira","d":"Viana do Castelo","p":"previews/Viana_do_Castelo/Vila_Nova_de_Cerveira/caop_preview.geojson"},{"m":"Alijó","d":"Vila Real","p":"previews/Vila_Real/Alijó/caop_preview.geojson"},{"m":"Boticas","d":"Vila Real","p":"previews/Vila_Real/Boticas/caop_preview.geojson"},{"m":"Chaves","d":"Vila Real","p":"previews/Vila_Real/Chaves/caop_preview.geojson"},{"m":"Mesão Frio","d":"Vila Real","p":"previews/Vila_Real/Mesão_Frio/caop_preview.geojson"},{"m":"Mondim de Basto","d":"Vila Real","p":"previews/Vila_Real/Mondim_de_Basto/caop_preview.geojson"},{"m":"Montalegre","d":"Vila Real","p":"previews/Vila_Real/Montalegre/caop_preview.geojson"},{"m":"Murça","d":"Vila Real","p":"previews/Vila_Real/Murça/caop_preview.geojson"},{"m":"Peso da Régua","d":"Vila Real","p":"previews/Vila_Real/Peso_da_Régua/caop_preview.geojson"},{"m":"Ribeira de Pena","d":"Vila Real","p":"previews/Vila_Real/Ribeira_de_Pena/caop_preview.geojson"},{"m":"Sabrosa","d":"Vila Real","p":"previews/Vila_Real/Sabrosa/caop_preview.geojson"},{"m":"Santa Marta de Penaguião","d":"Vila Real","p":"previews/Vila_Real/Santa_Marta_de_Penaguião/caop_preview.geojson"},{"m":"Valpaços","d":"Vila Real","p":"previews/Vila_Real/Valpaços/caop_preview.geojson"},{"m":"Vila Pouca de Aguiar","d":"Vila Real","p":"previews/Vila_Real/Vila_Pouca_de_Aguiar/caop_preview.geojson"},{"m":"Vila Real","d":"Vila Real","p":"previews/Vila_Real/Vila_Real/caop_preview.geojson"},{"m":"Armamar","d":"Viseu","p":"previews/Viseu/Armamar/caop_preview.geojson"},{"m":"Carregal do Sal","d":"Viseu","p":"previews/Viseu/Carregal_do_Sal/caop_preview.geojson"},{"m":"Castro Daire","d":"Viseu","p":"previews/Viseu/Castro_Daire/caop_preview.geojson"},{"m":"Cinfães","d":"Viseu","p":"previews/Viseu/Cinfães/caop_preview.geojson"},{"m":"Lamego","d":"Viseu","p":"previews/Viseu/Lamego/caop_preview.geojson"},{"m":"Mangualde","d":"Viseu","p":"previews/Viseu/Mangualde/caop_preview.geojson"},{"m":"Moimenta da Beira","d":"Viseu","p":"previews/Viseu/Moimenta_da_Beira/caop_preview.geojson"},{"m":"Mortágua","d":"Viseu","p":"previews/Viseu/Mortágua/caop_preview.geojson"},{"m":"Nelas","d":"Viseu","p":"previews/Viseu/Nelas/caop_preview.geojson"},{"m":"Oliveira de Frades","d":"Viseu","p":"previews/Viseu/Oliveira_de_Frades/caop_preview.geojson"},{"m":"Penalva do Castelo","d":"Viseu","p":"previews/Viseu/Penalva_do_Castelo/caop_preview.geojson"},{"m":"Penedono","d":"Viseu","p":"previews/Viseu/Penedono/caop_preview.geojson"},{"m":"Resende","d":"Viseu","p":"previews/Viseu/Resende/caop_preview.geojson"},{"m":"Santa Comba Dão","d":"Viseu","p":"previews/Viseu/Santa_Comba_Dão/caop_preview.geojson"},{"m":"Sernancelhe","d":"Viseu","p":"previews/Viseu/Sernancelhe/caop_preview.geojson"},{"m":"Sátão","d":"Viseu","p":"previews/Viseu/Sátão/caop_preview.geojson"},{"m":"São João da Pesqueira","d":"Viseu","p":"previews/Viseu/São_João_da_Pesqueira/caop_preview.geojson"},{"m":"São Pedro do Sul","d":"Viseu","p":"previews/Viseu/São_Pedro_do_Sul/caop_preview.geojson"},{"m":"Tabuaço","d":"Viseu","p":"previews/Viseu/Tabuaço/caop_preview.geojson"},{"m":"Tarouca","d":"Viseu","p":"previews/Viseu/Tarouca/caop_preview.geojson"},{"m":"Tondela","d":"Viseu","p":"previews/Viseu/Tondela/caop_preview.geojson"},{"m":"Vila Nova de Paiva","d":"Viseu","p":"previews/Viseu/Vila_Nova_de_Paiva/caop_preview.geojson"},{"m":"Viseu","d":"Viseu","p":"previews/Viseu/Viseu/caop_preview.geojson"},{"m":"Vouzela","d":"Viseu","p":"previews/Viseu/Vouzela/caop_preview.geojson"},{"m":"Alandroal","d":"Évora","p":"previews/Évora/Alandroal/caop_preview.geojson"},{"m":"Arraiolos","d":"Évora","p":"previews/Évora/Arraiolos/caop_preview.geojson"},{"m":"Borba","d":"Évora","p":"previews/Évora/Borba/caop_preview.geojson"},{"m":"Estremoz","d":"Évora","p":"previews/Évora/Estremoz/caop_preview.geojson"},{"m":"Montemor-o-Novo","d":"Évora","p":"previews/Évora/Montemor-o-Novo/caop_preview.geojson"},{"m":"Mora","d":"Évora","p":"previews/Évora/Mora/caop_preview.geojson"},{"m":"Mourão","d":"Évora","p":"previews/Évora/Mourão/caop_preview.geojson"},{"m":"Portel","d":"Évora","p":"previews/Évora/Portel/caop_preview.geojson"},{"m":"Redondo","d":"Évora","p":"previews/Évora/Redondo/caop_preview.geojson"},{"m":"Reguengos de Monsaraz","d":"Évora","p":"previews/Évora/Reguengos_de_Monsaraz/caop_preview.geojson"},{"m":"Vendas Novas","d":"Évora","p":"previews/Évora/Vendas_Novas/caop_preview.geojson"},{"m":"Viana do Alentejo","d":"Évora","p":"previews/Évora/Viana_do_Alentejo/caop_preview.geojson"},{"m":"Vila Viçosa","d":"Évora","p":"previews/Évora/Vila_Viçosa/caop_preview.geojson"},{"m":"Évora","d":"Évora","p":"previews/Évora/Évora/caop_preview.geojson"}];


/* ============================================================
   MODO OFFLINE
   ============================================================ */
let offlineDrawing = false;
let rulerDrawing = false;
let offlineRectLayer = null;
let offlineCancelDownload = false;

const OFFLINE_MAX_ZOOM = 18;
const OFFLINE_TILE_LIMIT = 3000; // segurança: bloqueia áreas demasiado grandes
const BYTES_PER_TILE_ESTIMATE = 22000; // estimativa média (~22KB/tile)

// para cada basemap visível na UI, quais as sub-camadas (chave + template) a cachear
const BASE_LAYERS_INFO = {
  satelite: [
    {key:'satellite', tpl:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'}
  ],
  dgt: [
    {key:'dgt', wms:true, base:'https://cartografia.dgterritorio.gov.pt/wms/ortos2021', wmsLayer:'Ortos2021-RGB'}
  ],
  claro: [
    {key:'claro', tpl:'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'}
  ],
  osm: [
    {key:'osm', tpl:'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'}
  ]
};




/* ============================================================
   CONECTIVIDADE — deteta perda de ligação e bloqueia o mapa
   ============================================================ */
let offlineSessionActive = false; // true quando o utilizador escolheu trabalhar com uma área guardada
let offlineBoundaryLayer = null;  // contorno tracejado vermelho da área com tiles guardados
let offlineMaskLayer = null;      // sombreado vermelho fora dessa área
let wasOffline = !navigator.onLine; // estado anterior, para detetar a transição offline -> online
// Funções de conectividade migradas para js/modules/connectivity.js


// Wizard migrated to js/modules/wizard.js

/* ============================================================
   MAPA + GEOMAN
   ============================================================ */
/* mostra uma mensagem na pill do canto superior esquerdo do mapa; se autoHideMs for passado,
   a mensagem desaparece sozinha (com fade) passado esse tempo */
let toolbarHintHideTimer = null;
function showToolbarHint(text, autoHideMs){
  if(!settings.showInterfaceHints) return;
  const el = document.getElementById('toolbar-hint');
  const textEl = document.getElementById('toolbar-hint-text');
  if(!el || !textEl) return;
  textEl.textContent = text;
  el.classList.remove('hint-hidden');
  clearTimeout(toolbarHintHideTimer);
  toolbarHintHideTimer = setTimeout(()=>{
    el.classList.add('hint-hidden');
  }, autoHideMs || 2600);
}

/* toast flutuante e discreto, usado para avisar de trocas automáticas (ex.: mudança de basemap) */
let basemapToastHideTimer = null;
function showBasemapToast(text, autoHideMs){
  const toast = document.getElementById('basemap-toast');
  const textEl = document.getElementById('basemap-toast-text');
  if(!toast || !textEl) return;
  textEl.textContent = text;
  toast.classList.add('is-visible');
  clearTimeout(basemapToastHideTimer);
  basemapToastHideTimer = setTimeout(()=>{
    toast.classList.remove('is-visible');
  }, autoHideMs || 3500);
}

let mapGridLayer = null;
function buildMapGridLines(){
  const step = 1;
  const lines = [];
  for(let lng = -180; lng <= 180; lng += step){
    lines.push(L.polyline([[ -90, lng ], [ 90, lng ]], { color: 'rgba(31,92,107,.16)', weight: 1, dashArray: '3 4', interactive: false }));
  }
  for(let lat = -90; lat <= 90; lat += step){
    lines.push(L.polyline([[ lat, -180 ], [ lat, 180 ]], { color: 'rgba(31,92,107,.16)', weight: 1, dashArray: '3 4', interactive: false }));
  }
  return lines;
}

const GEOREF_AUTO_MIN_ZOOM = 17;
const GEOREF_AUTO_MAX_ZOOM = 20;

function initMap(){
  map = L.map('map', {zoomControl:false, attributionControl:false, maxZoom: 24}).setView([20, 0], 2);

  const satellite = new OfflineTileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 24, maxNativeZoom: 19,
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    offlineKey: 'satellite'
  });
  const satelliteGroup = L.layerGroup([satellite]).addTo(map);

  const claro = new OfflineTileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 24, maxNativeZoom: 19,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    offlineKey: 'claro'
  });
  const osm = new OfflineTileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 24, maxNativeZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
    offlineKey: 'osm'
  });

  const dgt = new OfflineWMSTileLayer('https://cartografia.dgterritorio.gov.pt/wms/ortos2021', {
    layers: 'Ortos2021-RGB',
    format: 'image/jpeg',
    transparent: false,
    version: '1.3.0',
    maxZoom: 24, maxNativeZoom: 20, minNativeZoom: 6,
    attribution: 'Ortofotos &copy; DGT — Ortos 2021 Portugal Continental (CC-BY 4.0)',
    offlineKey: 'dgt'
  });

  const basemaps = { satelite: satelliteGroup, claro: claro, osm: osm, dgt: dgt };
  basemapLayers = basemaps;
  window.__basemapLayers = basemaps;

  // regista qual a camada base ativa, para saber o que cachear no modo offline
  activeBaseLayerKey = 'satelite';
  window.__activeBaseLayerKey = activeBaseLayerKey;

  function renderBasemapMenu(){
    document.querySelectorAll('#basemap-menu button[data-basemap]').forEach(btn=>{
      btn.classList.toggle('is-active', btn.dataset.basemap === activeBaseLayerKey);
    });
    const autoBtn = document.getElementById('basemap-auto-toggle');
    if(autoBtn) autoBtn.classList.toggle('is-active', autoResolutionEnabled);
  }

  function switchBasemap(key, opts){
    opts = opts || {};
    if(key === 'none'){
      Object.values(basemaps).forEach(l=>{ if(map.hasLayer(l)) map.removeLayer(l); });
      activeBaseLayerKey = 'none';
      window.__activeBaseLayerKey = 'none';
      renderBasemapMenu();
      closeBasemapMenu();
      return;
    }
    const next = basemaps[key];
    if(!next || key === activeBaseLayerKey){ closeBasemapMenu(); return; }
    Object.values(basemaps).forEach(l=>{ if(l !== next && map.hasLayer(l)) map.removeLayer(l); });
    if(!map.hasLayer(next)) next.addTo(map);
    activeBaseLayerKey = key;
    window.__activeBaseLayerKey = key;
    renderBasemapMenu();
    closeBasemapMenu();
    if(key === 'dgt' && !opts.auto){
      showToolbarHint('Portugal HD (DGT): só mostra imagem a partir de zoom de cidade/bairro — aproxima-te para veres o detalhe.', 6000);
    }
  }

  /* Hook estável para outros módulos (ex. 18-sam-segment.js) forçarem um
     basemap especifico e desligarem a troca automática satelite<->dgt,
     sem terem de aceder a variaveis privadas deste closure (activeBaseLayerKey,
     autoResolutionEnabled) nem simular cliques no menu de basemap. */
  window.__forceBasemap = function(key){
    autoResolutionEnabled = false;
    switchBasemap(key, {auto:true});
  };

  /* ---------- troca automática Satélite ⇄ Portugal HD (DGT) por nível de zoom ---------- */
  let autoResolutionEnabled = true;
  const PT_CONTINENTAL_BOUNDS = L.latLngBounds([36.7, -9.6], [42.3, -6.0]);
  const AUTO_HD_MIN_ZOOM = 17;
  function maybeAutoSwitchBasemap(){
    if(!autoResolutionEnabled) return;
    // só atua sobre o par satélite/DGT — se o utilizador escolheu manualmente "claro" ou "OSM", não interfere
    if(activeBaseLayerKey !== 'satelite' && activeBaseLayerKey !== 'dgt') return;
    const zoom = map.getZoom();
    const dentroPT = PT_CONTINENTAL_BOUNDS.contains(map.getCenter());
    if(activeBaseLayerKey === 'satelite' && dentroPT && zoom >= AUTO_HD_MIN_ZOOM){
      switchBasemap('dgt', {auto:true});
      showBasemapToast('Basemap otimizado automaticamente: Portugal HD (DGT) — resolução máxima disponível aqui.');
    } else if(activeBaseLayerKey === 'dgt' && (!dentroPT || zoom < AUTO_HD_MIN_ZOOM)){
      switchBasemap('satelite', {auto:true});
      showBasemapToast('A voltar ao Satélite global.');
    }
  }
  map.on('zoomend moveend', ()=>{
    maybeAutoSwitchBasemap();
    enableGeorefAutoButtonIfZoomReady();
  });

  function openBasemapMenu(){
    const menu = document.getElementById('basemap-menu');
    const btn = document.getElementById('btn-basemap');
    const rect = btn.getBoundingClientRect();
    menu.classList.remove('hidden');
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
    renderBasemapMenu();
  }
  function closeBasemapMenu(){
    document.getElementById('basemap-menu').classList.add('hidden');
  }

  document.getElementById('btn-basemap').addEventListener('click', (e)=>{
    e.stopPropagation();
    const menu = document.getElementById('basemap-menu');
    if(menu.classList.contains('hidden')) openBasemapMenu(); else closeBasemapMenu();
  });
  document.querySelectorAll('#basemap-menu button[data-basemap]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      autoResolutionEnabled = false;
      switchBasemap(btn.dataset.basemap);
    });
  });
  document.getElementById('basemap-auto-toggle').addEventListener('click', (e)=>{
    e.stopPropagation();
    autoResolutionEnabled = true;
    renderBasemapMenu();
    closeBasemapMenu();
    showBasemapToast('Resolução automática reativada.');
    maybeAutoSwitchBasemap();
  });
  document.addEventListener('click', (e)=>{
    const menu = document.getElementById('basemap-menu');
    const btn = document.getElementById('btn-basemap');
    if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      closeBasemapMenu();
    }
  });
  renderBasemapMenu();

  drawnGroup = L.featureGroup().addTo(map);
  measuresGroup = L.layerGroup().addTo(map);
  rulerGroup = L.layerGroup().addTo(map);

  map.pm.addControls({
    position: 'topleft',
    drawCircle: false,
    drawCircleMarker: false,
    drawRectangle: false,
    drawText: false,
    drawPolyline: false,
    drawPolygon: false,
    drawMarker: false,
    editMode: true,
    dragMode: true,
    removalMode: true,
    cutPolygon: false,
    rotateMode: false
  });

  /* Vetorização Assistida (SAM) -- deixou de ser um botão do header e
     passou a ser um controlo Leaflet próprio, no canto 'topleft', a
     seguir à toolbar de edição do Geoman (desenhar/editar vértices/
     mover/eliminar) acima -- por isso aparece sempre logo por baixo
     dela. Só fica visível quando essa toolbar está aberta (mesma classe
     "pm-toolbar-visible" em #map -- ver css/pm-toolbar.css), já que é
     uma ferramenta do mesmo grupo de edição/desenho.
     A lógica de ativar/desativar o modo SAM em si vive toda em
     18-sam-segment.js (window.__sam.activate/deactivate) -- aqui só se
     cria o botão e liga-se o clique. */
  var VetAssistControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function(){
      var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control va-vetassist-control');
      var link = L.DomUtil.create('a', '', container);
      link.href = '#';
      link.id = 'btn-vetassist';
      link.title = 'AAV (Algoritmo de assistência à vetorização automática)';
      link.setAttribute('role', 'button');
      link.setAttribute('aria-label', 'Vetorização Assistida');
      link.setAttribute('aria-pressed', 'false');
      link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/></svg>';

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.on(link, 'click', function(e){
        L.DomEvent.stop(e);
        if(!window.__sam) return;
        if(window.__sam.active) window.__sam.deactivate();
        else window.__sam.activate();
      });

      // Refletir o estado (ativo/inativo) independentemente de quem o mudou
      // -- clique neste botão, tecla Esc, ou qualquer outro sítio.
      window.addEventListener('sam:state', function(e){
        var isActive = !!(e.detail && e.detail.active);
        link.classList.toggle('is-active', isActive);
        link.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      return container;
    }
  });
  map.addControl(new VetAssistControl());

  // usa o marcador circular DataGis (em vez do pin azul padrão) também
  // durante a pré-visualização ao colocar o ponto, antes do clique
  //
  // --- Smart snapping ---
  // snappable      liga o "íman" de desenho: o cursor agarra-se a pontos próximos
  // snapDistance   raio (em pixels de ecrã) dentro do qual o íman atua
  // snapSegment    o "smart" do snapping: além de colar aos VÉRTICES de outras
  //                geometrias (extremos/cantos), também cola a qualquer ponto AO
  //                LONGO das arestas/segmentos — incluindo os da própria geometria
  //                que estás a desenhar. É o que permite, por ex., fechar um
  //                polígono exatamente sobre o lado de outro já existente, sem
  //                teres de acertar num vértice exato.
  applySettingsToEditing();

  map.on('pm:create', e => onFeatureCreated(e.layer));
  map.on('pm:remove', e => onFeatureRemoved(e.layer));

  setupOfflineMapEvents();
  setupRulerMapEvents();
  setupGeorefMapEvents();
  renderOfflineAreasMenu();
  updateConnectivityUI();
  updateMapGridVisibility();
  map.on('mousemove', e => {
    if(settings.showCursorCoordinates){ updateCoordBar(e.latlng.lat, e.latlng.lng); }
  });
}

/* ativa as ferramentas de desenho certas depois do wizard definir o tipo de geometria */
function applyGeometryConfig(){
  map.pm.addControls({
    position: 'topleft',
    drawCircle: false,
    drawCircleMarker: false,
    drawRectangle: false,
    drawText: false,
    drawPolyline: config.geometryType === 'LineString',
    drawPolygon: config.geometryType === 'Polygon',
    drawMarker: config.geometryType === 'Point',
    editMode: true,
    dragMode: true,
    removalMode: true,
    cutPolygon: false,
    rotateMode: false
  });

}

/* --- init.js encarrega-se da sequência de arranque (loadSettings, initMap, etc.) --- */

/* ============================================================
   CRIAÇÃO DE FEATURE + FORMULÁRIO DE ATRIBUTOS
   ============================================================ */
/* ============================================================
   HISTÓRICO DE AÇÕES (DESFAZER / REFAZER)
   ------------------------------------------------------------
   Guarda um histórico linear de ações de edição (criar, apagar,
   editar geometria) feitas com as ferramentas de desenho/edição.
   Cada ação sabe reverter-se (undo) e reaplicar-se (redo). Ao
   fazer uma nova ação depois de um undo, o "ramo" de redo é
   cortado (comportamento standard tipo Ctrl+Z de qualquer editor).
   ============================================================ */
const actionHistory = [];
let historyIndex = -1;       // aponta para a última ação já aplicada
const HISTORY_LIMIT = 60;    // limite de ações guardadas, para não crescer sem fim
let isApplyingHistory = false; // true enquanto um undo/redo está a decorrer,
                                // para as próprias mudanças não se auto-registarem

function pushHistoryAction(action){
  if(isApplyingHistory) return;
  // qualquer ação nova corta o que estava disponível para "refazer"
  actionHistory.splice(historyIndex + 1);
  actionHistory.push(action);
  if(actionHistory.length > HISTORY_LIMIT){ actionHistory.shift(); }
  historyIndex = actionHistory.length - 1;
  updateUndoRedoButtons();
}

/* devolve só a geometria (coordenadas) de uma layer, para poder guardar
   o "antes" e o "depois" de uma edição e restaurar mais tarde */
function geomSnapshot(layer){
  try{ return JSON.stringify(layer.toGeoJSON().geometry); }
  catch(err){ return null; }
}
function restoreGeomSnapshot(layer, snapshotStr){
  if(!snapshotStr) return;
  let geom;
  try{ geom = JSON.parse(snapshotStr); } catch(err){ return; }
  if(!geom) return;
  if(layer instanceof L.Marker){
    const c = geom.coordinates;
    layer.setLatLng(L.latLng(c[1], c[0]));
    return;
  }
  if(typeof layer.setLatLngs !== 'function') return;
  const nestingByType = { LineString:0, MultiLineString:1, Polygon:1, MultiPolygon:2 };
  const nesting = nestingByType[geom.type] ?? 0;
  const latlngs = L.GeoJSON.coordsToLatLngs(geom.coordinates, nesting);
  layer.setLatLngs(latlngs);
  if(typeof layer.redraw === 'function') layer.redraw();
}

/* regista o "antes" de uma edição de geometria (arrastar vértice / mover a
   forma toda) e, quando a edição termina, guarda a ação no histórico */
function bindFeatureEditTracking(entry){
  const layer = entry.layer;
  let editSnapshot = null;
  const captureSnapshot = ()=>{ editSnapshot = geomSnapshot(layer); };
  const commitEdit = ()=>{
    entry.updatedAt = Date.now();
    markProjectDirty();
    refreshStatsIfOpen(entry);
    checkAllTopology();
    if(entry.showMeasures) renderPolygonMeasures(entry);
    if(editSnapshot && !isApplyingHistory){
      const after = geomSnapshot(layer);
      if(after && after !== editSnapshot){
        pushHistoryAction({type:'edit', layer, entry, before: editSnapshot, after});
      }
    }
    editSnapshot = null;
  };
  layer.on('pm:markerdragstart', captureSnapshot);
  layer.on('pm:dragstart', captureSnapshot);
  layer.on('pm:edit', commitEdit);
  layer.on('pm:dragend', commitEdit);
}

/* volta a colocar uma geometria já existente (entry+layer) no mapa e no
   estado da app — usado ao refazer uma criação ou desfazer uma remoção */
function historyAddFeature(layer, entry){
  featuresData.set(entry.id, entry);
  if(!drawnGroup.hasLayer(layer)) drawnGroup.addLayer(layer);
  if(entry.fid) teamState.deletedFids.delete(entry.fid);
  markProjectDirty();
  refreshFeatList();
  checkAllTopology();
  if(entry.showMeasures) renderPolygonMeasures(entry);
}
/* remove uma geometria do mapa e do estado da app — usado ao desfazer uma
   criação ou refazer uma remoção */
function historyRemoveFeature(layer, entry){
  clearPolygonMeasures(entry);
  if(entry.fid) teamState.deletedFids.set(entry.fid, Date.now());
  featuresData.delete(entry.id);
  drawnGroup.removeLayer(layer);
  markProjectDirty();
  refreshFeatList();
  checkAllTopology();
}

function applyHistoryAction(action, direction){
  isApplyingHistory = true;
  try{
    if(action.type === 'create'){
      if(direction === 'undo') historyRemoveFeature(action.layer, action.entry);
      else historyAddFeature(action.layer, action.entry);
    } else if(action.type === 'remove'){
      if(direction === 'undo') historyAddFeature(action.layer, action.entry);
      else historyRemoveFeature(action.layer, action.entry);
    } else if(action.type === 'edit'){
      restoreGeomSnapshot(action.layer, direction === 'undo' ? action.before : action.after);
      action.entry.updatedAt = Date.now();
      markProjectDirty();
      refreshStatsIfOpen(action.entry);
      checkAllTopology();
      if(action.entry.showMeasures) renderPolygonMeasures(action.entry);
    }
  } finally {
    isApplyingHistory = false;
  }
}

function canUndoAction(){ return historyIndex >= 0; }
function canRedoAction(){ return historyIndex < actionHistory.length - 1; }

function undoLastAction(){
  if(!canUndoAction()) return;
  const action = actionHistory[historyIndex];
  applyHistoryAction(action, 'undo');
  historyIndex--;
  updateUndoRedoButtons();
}
function redoLastAction(){
  if(!canRedoAction()) return;
  historyIndex++;
  const action = actionHistory[historyIndex];
  applyHistoryAction(action, 'redo');
  updateUndoRedoButtons();
}

function updateUndoRedoButtons(){
  const undoBtn = document.getElementById('btn-undo-action');
  const redoBtn = document.getElementById('btn-redo-action');
  if(undoBtn) undoBtn.disabled = !canUndoAction();
  if(redoBtn) redoBtn.disabled = !canRedoAction();
}

/* faz o botão "saltar" tal como acontece com um clique real, mesmo quando
   a ação é despoletada pelo teclado (Ctrl+Z / Ctrl+Y) */
function pulseUndoRedoButton(btn){
  if(!btn) return;
  btn.classList.remove('is-pressed');
  // força reflow para poder reiniciar a animação mesmo que seja chamada em sequência rápida
  void btn.offsetWidth;
  btn.classList.add('is-pressed');
  setTimeout(()=> btn.classList.remove('is-pressed'), 200);
}

const btnUndoAction = document.getElementById('btn-undo-action');
const btnRedoAction = document.getElementById('btn-redo-action');
btnUndoAction?.addEventListener('click', ()=>{
  if(!canUndoAction()) return;
  pulseUndoRedoButton(btnUndoAction);
  undoLastAction();
});
btnRedoAction?.addEventListener('click', ()=>{
  if(!canRedoAction()) return;
  pulseUndoRedoButton(btnRedoAction);
  redoLastAction();
});
document.addEventListener('keydown', (event)=>{
  const target = event.target;
  const isTyping = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if(isTyping) return;
  const key = event.key.toLowerCase();
  if((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z'){
    event.preventDefault();
    if(canUndoAction()){ pulseUndoRedoButton(btnUndoAction); undoLastAction(); }
  } else if(((event.ctrlKey || event.metaKey) && key === 'y') || ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'z')){
    event.preventDefault();
    if(canRedoAction()){ pulseUndoRedoButton(btnRedoAction); redoLastAction(); }
  }
});

function genFid(){
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('fid-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

function onFeatureCreated(layer){
  if(offlineDrawing || rulerDrawing || window.vaDrawingActive) return; // retângulo offline / linha da régua / vetorização assistida não são geometrias do utilizador
  if(layerVisible.get(activeLayerId) === undefined){
    layerVisible.set(activeLayerId, true);
  }
  if(!layerOrder.includes(activeLayerId)) layerOrder.unshift(activeLayerId);
  drawnGroup.addLayer(layer);
  assignLayerPane(layer, activeLayerId);
  featureCounter++;
  const id = L.Util.stamp(layer);

  const entry = {layer, props:{}, id, fid: genFid(), updatedAt: Date.now(), label:'Geometria '+featureCounter, geomType: config.geometryType, layerId: activeLayerId, hasOverlap:false, overlapsWith:[], showMeasures:false, measureTooltips:[]};
  featuresData.set(id, entry);
  markProjectDirty();

  styleLayerDefault(layer, activeLayerId);
  showStatsPopup(entry);
  bindFeatureContextMenu(entry);

  // reage a edições posteriores desta geometria (arrastar vértices, mover) para
  // manter as estatísticas e a verificação de topologia sempre atualizadas,
  // e para poder desfazer/refazer essas edições
  bindFeatureEditTracking(entry);

  // sem popup ao criar: a geometria fica logo com o nome genérico "Geometria N"
  // e aparece de imediato na lista/tabela; atributos (se o modo os tiver) editam-se na tabela
  refreshFeatList();

  checkAllTopology();

  pushHistoryAction({type:'create', layer, entry});
}

function onFeatureRemoved(layer){
  const id = L.Util.stamp(layer);
  const entry = featuresData.get(id);
  if(entry){
    if(entry.fid){ teamState.deletedFids.set(entry.fid, Date.now()); }
    clearPolygonMeasures(entry);
  }
  featuresData.delete(id);
  markProjectDirty();
  refreshFeatList();
  checkAllTopology(); // remover uma geometria pode resolver sobreposições de outras
  if(entry) pushHistoryAction({type:'remove', layer, entry});
}

// Section migrated to js/modules/import.js
// IMPORTAR GEOJSON/SHAPEFILE: parseImportedFile, importGeoJSONFeatures,
// importFeaturesInChunks, parseLooseShapefileParts, processImportedFiles,
// import-file-input handler, drag-and-drop handler

// Section migrated to js/modules/raster.js
// IMPORTAÇÃO DE RASTER (GEORREFERENCIAÇÃO)
/*
   Migrated: rasterLayers, splitImportFileGroups, fileToDataUrl,
   importRasterFiles, serializeRasterLayersForProject, clearRasterLayerState,
   restoreRasterLayersFromProject, renderRasterLayersPanel, georefModeState,
   beginGeoreferencingMode, cancelGeorefMode, runAutoGeorefDetection,
   setupGeorefMapEvents, and all georef-related functions
*/


// Select by attributes migrated to js/modules/select-by-attr.js

// Popup/stats/highlight/hatch migrated to js/modules/popup.js

// Symbology engine migrada para js/modules/symbology-engine.js

// Features, layers panel, symbology panel, attr table migradas para js/modules/features.js

// Exportação migrada para js/modules/export.js

// Análise espacial migrada para js/modules/analysis.js
