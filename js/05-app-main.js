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

/* ============================================================
   SIMBOLOGIA — modelo de dados
   mode: 'simples'  -> cor única (usa config.baseColor, como sempre foi)
         'unicos'   -> uma cor por cada valor distinto de um atributo (texto/categórico/número)
         'graduado' -> classes numéricas sobre um atributo numérico, com 4 métodos de
                       cálculo dos intervalos: manual, quantis, intervalos iguais, natural breaks (Jenks)
   ============================================================ */
const SYMBOLOGY_PALETTE = [
  '#F5821F', '#2E7D32', '#1565C0', '#C62828', '#6A1B9A',
  '#00838F', '#F9A825', '#4E342E', '#AD1457', '#33691E',
  '#EF6C00', '#283593', '#00695C', '#D84315', '#5D4037'
];

function paletteColor(i){ return SYMBOLOGY_PALETTE[i % SYMBOLOGY_PALETTE.length]; }

function defaultSymbology(){
  return {
    mode: 'simples',
    attr: null,
    method: 'iguais',   // 'manual' | 'quantis' | 'iguais' | 'jenks'
    classCount: 5,
    breaks: [],          // [{min, max, color}] (modo graduado)
    uniqueValues: []      // [{value, color}] (modo valores únicos)
  };
}

function cloneSymbology(sym){
  const base = defaultSymbology();
  if(!sym || typeof sym !== 'object') return base;
  return {
    mode: (sym.mode === 'unicos' || sym.mode === 'graduado') ? sym.mode : 'simples',
    attr: sym.attr || null,
    method: ['manual','quantis','iguais','jenks'].includes(sym.method) ? sym.method : 'iguais',
    classCount: Number.isFinite(sym.classCount) ? sym.classCount : 5,
    breaks: Array.isArray(sym.breaks) ? sym.breaks.map(b=>({min:b.min, max:b.max, color:b.color})) : [],
    uniqueValues: Array.isArray(sym.uniqueValues) ? sym.uniqueValues.map(u=>({value:u.value, color:u.color})) : []
  };
}

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
    alert('Não é possível fechar o último mapa aberto.');
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

/* ---------- IndexedDB ---------- */
let _idbPromise = null;
function idbOpen(){
  if(_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject)=>{
    const req = indexedDB.open('engenh_offline', 1);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
  return _idbPromise;
}
async function idbPutTile(key, blob){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').put(blob, key);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}
async function idbGetTile(key){
  const db = await idbOpen();
  return new Promise((resolve)=>{
    const tx = db.transaction('tiles', 'readonly');
    const req = tx.objectStore('tiles').get(key);
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> resolve(null);
  });
}
async function idbClearTiles(){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').clear();
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}
async function idbSetMeta(meta){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(meta, meta.id);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}
async function idbGetMeta(id){
  const db = await idbOpen();
  return new Promise((resolve)=>{
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(id);
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> resolve(null);
  });
}
async function idbGetAllMeta(){
  const db = await idbOpen();
  return new Promise((resolve)=>{
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').getAll();
    req.onsuccess = ()=> resolve((req.result || []).sort((a,b)=> b.savedAt - a.savedAt));
    req.onerror = ()=> resolve([]);
  });
}
async function idbDeleteMeta(id){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}

/* ---------- camada de tiles com cache offline ---------- */
const OfflineTileLayer = L.TileLayer.extend({
  createTile: function(coords, done){
    const tile = document.createElement('img');
    tile.alt = '';
    const z = coords.z, x = coords.x, y = coords.y;
    const offlineKey = this.options.offlineKey + '_' + z + '_' + x + '_' + y;

    idbGetTile(offlineKey).then(blob=>{
      if(blob){
        const url = URL.createObjectURL(blob);
        tile.onload = ()=>{ URL.revokeObjectURL(url); done(null, tile); };
        tile.onerror = ()=> done(null, tile);
        tile.src = url;
      } else {
        tile.onload = ()=> done(null, tile);
        tile.onerror = (e)=> done(e, tile);
        tile.src = this.getTileUrl(coords);
      }
    });
    return tile;
  }
});

/* camada WMS (usada para o basemap de alta resolução da DGT) com o mesmo cache offline */
const OfflineWMSTileLayer = L.TileLayer.WMS.extend({
  createTile: OfflineTileLayer.prototype.createTile
});

/* converte coordenadas de tile z/x/y para bbox em metros (EPSG:3857) — usado para montar
   pedidos WMS (GetMap) equivalentes ao tile XYZ pedido pelo Leaflet */
function tile3857BBox(z, x, y){
  const EARTH = 20037508.342789244;
  const size = (2 * EARTH) / Math.pow(2, z);
  const minX = -EARTH + x * size;
  const maxX = -EARTH + (x + 1) * size;
  const maxY = EARTH - y * size;
  const minY = EARTH - (y + 1) * size;
  return [minX, minY, maxX, maxY];
}
function buildWmsTileUrl(info, t){
  const [minX, minY, maxX, maxY] = tile3857BBox(t.z, t.x, t.y);
  const params = new URLSearchParams({
    service: 'WMS', version: '1.3.0', request: 'GetMap',
    layers: info.wmsLayer, styles: '', format: 'image/jpeg', transparent: 'false',
    width: '256', height: '256', crs: 'EPSG:3857',
    bbox: `${minX},${minY},${maxX},${maxY}`
  });
  return `${info.base}?${params.toString()}`;
}

/* ---------- utilidades de tiles ---------- */
function lonLatToTile(lon, lat, z){
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2 * n);
  return {x, y};
}
function tileRangeForBounds(bounds, z){
  const nw = lonLatToTile(bounds.getWest(), bounds.getNorth(), z);
  const se = lonLatToTile(bounds.getEast(), bounds.getSouth(), z);
  return {minX: Math.min(nw.x, se.x), maxX: Math.max(nw.x, se.x), minY: Math.min(nw.y, se.y), maxY: Math.max(nw.y, se.y)};
}
function buildTilePlan(bounds, minZoom, maxZoom){
  const plan = [];
  for(let z=minZoom; z<=maxZoom; z++){
    const r = tileRangeForBounds(bounds, z);
    for(let x=r.minX; x<=r.maxX; x++){
      for(let y=r.minY; y<=r.maxY; y++){
        plan.push({z, x, y});
      }
    }
  }
  return plan;
}

/* ---------- UI: iniciar definição de área ---------- */
function startOfflineAreaDrawing(){
  if(offlineDrawing) return;
  closeOfflineAreasMenu();
  offlineDrawing = true;
  document.getElementById('offline-rect-banner').style.display = 'flex';
  map.pm.enableDraw('Rectangle');
}
document.getElementById('offline-areas-new').addEventListener('click', (e)=>{
  e.stopPropagation();
  startOfflineAreaDrawing();
});

document.getElementById('offline-rect-cancel').addEventListener('click', cancelOfflineDrawing);

function cancelOfflineDrawing(){
  offlineDrawing = false;
  document.getElementById('offline-rect-banner').style.display = 'none';
  if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw('Rectangle');
}

function setupOfflineMapEvents(){
  map.on('pm:create', (e)=>{
    if(!offlineDrawing) return; // não interfere com o desenho normal de geometrias
    offlineDrawing = false;
    document.getElementById('offline-rect-banner').style.display = 'none';
    offlineRectLayer = e.layer;
    openOfflineEstimate(offlineRectLayer.getBounds());
  });
}

/* ============================================================
   RÉGUA — medir uma distância livre no mapa (não é uma geometria do projeto)
   ============================================================ */
let rulerLineLayer = null;
let rulerLabelLayers = [];

function startRulerDrawing(){
  if(rulerDrawing) return;
  clearRulerMeasurement();
  rulerDrawing = true;
  document.getElementById('ruler-banner').style.display = 'flex';
  map.pm.enableDraw('Line');
}
document.getElementById('btn-ruler').addEventListener('click', startRulerDrawing);

function cancelRulerDrawing(){
  rulerDrawing = false;
  document.getElementById('ruler-banner').style.display = 'none';
  if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw('Line');
}
document.getElementById('ruler-cancel').addEventListener('click', cancelRulerDrawing);

function setupRulerMapEvents(){
  map.on('pm:create', (e)=>{
    if(!rulerDrawing) return; // não interfere com o desenho normal de geometrias
    rulerDrawing = false;
    document.getElementById('ruler-banner').style.display = 'none';
    renderRulerLine(e.layer);
  });
}

/* desenha a linha da régua com uma etiqueta (em metros) por segmento, e mostra o total */
function renderRulerLine(layer){
  clearRulerMeasurement();
  rulerLineLayer = layer;
  if(layer.setStyle) layer.setStyle({color:'#B5472B', weight:3, dashArray:'6,4'});
  rulerGroup.addLayer(layer);

  const latlngs = layer.getLatLngs();
  let total = 0;
  for(let i=0; i<latlngs.length-1; i++){
    const a = latlngs[i], b = latlngs[i+1];
    const dist = a.distanceTo(b);
    total += dist;
    const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    const label = formatDistance(dist);
    const tooltip = L.tooltip({
      permanent: true, direction: 'center', className: 'edge-measure-tooltip', interactive: false
    }).setLatLng(mid).setContent(label);
    rulerGroup.addLayer(tooltip);
    rulerLabelLayers.push(tooltip);
  }

  const totalLabel = formatDistance(total);
  document.getElementById('ruler-result-value').textContent = totalLabel;
  document.getElementById('ruler-result').style.display = 'flex';
}

function clearRulerMeasurement(){
  if(rulerLineLayer){ rulerGroup.removeLayer(rulerLineLayer); rulerLineLayer = null; }
  rulerLabelLayers.forEach(t=> rulerGroup.removeLayer(t));
  rulerLabelLayers = [];
  document.getElementById('ruler-result').style.display = 'none';
}
document.getElementById('ruler-result-clear').addEventListener('click', clearRulerMeasurement);

/* ---------- estimativa + confirmação ---------- */
function openOfflineEstimate(bounds){
  const minZoom = Math.max(0, Math.min(map.getZoom(), OFFLINE_MAX_ZOOM));
  const maxZoom = OFFLINE_MAX_ZOOM;
  const layerInfos = BASE_LAYERS_INFO[activeBaseLayerKey];

  let tileCount = 0;
  for(let z=minZoom; z<=maxZoom; z++){
    const r = tileRangeForBounds(bounds, z);
    tileCount += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  tileCount *= layerInfos.length;

  const mb = (tileCount * BYTES_PER_TILE_ESTIMATE / 1024 / 1024).toFixed(1);
  const statsEl = document.getElementById('offline-stats');
  statsEl.innerHTML = `
    <div><span>Zoom</span><b>${minZoom} → ${maxZoom}</b></div>
    <div><span>Camada</span><b>${activeBaseLayerKey}</b></div>
    <div><span>Tiles a descarregar</span><b>${tileCount.toLocaleString('pt-PT')}</b></div>
    <div><span>Tamanho estimado</span><b>~${mb} MB</b></div>
  `;

  const warnEl = document.getElementById('offline-warning');
  const startBtn = document.getElementById('offline-confirm-start');
  if(tileCount > OFFLINE_TILE_LIMIT){
    warnEl.style.display = 'block';
    warnEl.textContent = `Área demasiado grande para guardar offline (limite: ${OFFLINE_TILE_LIMIT.toLocaleString('pt-PT')} tiles). Desenha uma área mais pequena ou reduz o zoom inicial.`;
    startBtn.disabled = true;
  } else {
    warnEl.style.display = 'none';
    startBtn.disabled = false;
  }

  const nameInput = document.getElementById('offline-area-name');
  if(nameInput) nameInput.value = '';
  document.getElementById('offline-overlay').classList.remove('hidden');

  startBtn.onclick = async ()=>{
    document.getElementById('offline-overlay').classList.add('hidden');
    await downloadOfflineArea(bounds, minZoom, maxZoom, layerInfos);
  };
}

document.getElementById('offline-confirm-cancel').addEventListener('click', ()=>{
  document.getElementById('offline-overlay').classList.add('hidden');
  if(offlineRectLayer){ map.removeLayer(offlineRectLayer); offlineRectLayer = null; }
});

/* ---------- download ---------- */
async function downloadOfflineArea(bounds, minZoom, maxZoom, layerInfos){
  offlineCancelDownload = false;
  const progressOverlay = document.getElementById('offline-progress-overlay');
  const fill = document.getElementById('offline-progress-fill');
  const label = document.getElementById('offline-progress-label');
  progressOverlay.classList.remove('hidden');

  const baseTiles = buildTilePlan(bounds, minZoom, maxZoom);
  const totalTiles = baseTiles.length * layerInfos.length;
  let done = 0;

  outer:
  for(const info of layerInfos){
    for(const t of baseTiles){
      if(offlineCancelDownload) break outer;
      const url = info.wms ? buildWmsTileUrl(info, t) : info.tpl.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
      try{
        const resp = await fetch(url);
        if(resp.ok){
          const blob = await resp.blob();
          await idbPutTile(`${info.key}_${t.z}_${t.x}_${t.y}`, blob);
        }
      }catch(err){
        // tile falhada não bloqueia o resto do download
      }
      done++;
      const pct = Math.round(done/totalTiles*100);
      fill.style.width = pct + '%';
      label.textContent = `${done.toLocaleString('pt-PT')} / ${totalTiles.toLocaleString('pt-PT')} tiles`;
    }
  }

  progressOverlay.classList.add('hidden');

  if(offlineCancelDownload){
    if(offlineRectLayer){ map.removeLayer(offlineRectLayer); offlineRectLayer = null; }
    return;
  }

  const nameInput = document.getElementById('offline-area-name');
  const areaName = (nameInput && nameInput.value.trim()) || `Área ${new Date().toLocaleDateString('pt-PT')}`;

  await idbSetMeta({
    id: 'area_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name: areaName,
    bounds: [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]],
    minZoom, maxZoom,
    layerKey: activeBaseLayerKey,
    savedAt: Date.now(),
    tileCount: totalTiles
  });

  if(offlineRectLayer){ map.removeLayer(offlineRectLayer); offlineRectLayer = null; }
  renderOfflineAreasMenu();
  alert('Área offline guardada com sucesso. Já podes usar este mapa sem ligação à internet, dentro desta área.');
}

document.getElementById('offline-progress-cancel').addEventListener('click', ()=>{
  offlineCancelDownload = true;
});

/* ---------- estado / gestão: menu de áreas guardadas (no cabeçalho) ---------- */
async function renderOfflineAreasMenu(){
  const list = document.getElementById('offline-areas-list');
  const areas = await idbGetAllMeta();
  if(!areas.length){
    list.innerHTML = `<p class="offline-area-empty">Ainda não guardaste nenhuma área offline.</p>`;
    return;
  }
  list.innerHTML = '';
  areas.forEach(meta=>{
    const date = new Date(meta.savedAt).toLocaleDateString('pt-PT');
    const item = document.createElement('div');
    item.className = 'offline-area-item';
    item.innerHTML = `
      <div class="offline-area-info">
        <b>${meta.name || 'Área sem nome'}</b>
        <span>zoom ${meta.minZoom}–${meta.maxZoom} · ${date}</span>
      </div>
      <button type="button" title="Ver no mapa" aria-label="Ver no mapa">🔎</button>
      <button type="button" title="Apagar área" aria-label="Apagar área" data-action="delete">🗑</button>
    `;
    const [zoomBtn, deleteBtn] = item.querySelectorAll('button');
    zoomBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const b = L.latLngBounds(meta.bounds[0], meta.bounds[1]);
      map.fitBounds(b);
      closeOfflineAreasMenu();
    });
    deleteBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if(!requestConfirmation(`Apagar a área "${meta.name || 'sem nome'}"? Deixa de poder ser usada offline.`)) return;
      await idbDeleteMeta(meta.id);
      renderOfflineAreasMenu();
    });
    list.appendChild(item);
  });
}

function openOfflineAreasMenu(){
  const menu = document.getElementById('offline-areas-menu');
  const btn = document.getElementById('btn-offline-define');
  const rect = btn.getBoundingClientRect();
  menu.classList.remove('hidden');
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
  renderOfflineAreasMenu();
}
function closeOfflineAreasMenu(){
  document.getElementById('offline-areas-menu').classList.add('hidden');
}
document.getElementById('btn-offline-define').addEventListener('click', (e)=>{
  e.stopPropagation();
  const menu = document.getElementById('offline-areas-menu');
  if(menu.classList.contains('hidden')) openOfflineAreasMenu(); else closeOfflineAreasMenu();
});
document.addEventListener('click', (e)=>{
  const menu = document.getElementById('offline-areas-menu');
  const btn = document.getElementById('btn-offline-define');
  if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
    closeOfflineAreasMenu();
  }
});

/* ---------- ao reabrir: prompt para usar a área guardada ----------
   Só mostra o popup depois de o utilizador ter aberto/iniciado o projeto
   (chamado a partir de proceedToMap), nunca logo ao carregar a página. */
async function promptResumeOfflineArea(){
  const areas = await idbGetAllMeta();
  if(!areas.length) return;
  if(!navigator.onLine) return; // sem ligação: trata-se no overlay de conectividade, não aqui

  const meta = areas[0]; // área guardada mais recente
  const date = new Date(meta.savedAt).toLocaleString('pt-PT');
  const extra = areas.length > 1 ? ` (tens mais ${areas.length - 1} área(s) guardada(s), acessíveis no botão de área offline)` : '';
  document.getElementById('offline-prompt-detail').textContent =
    `Tens uma área guardada ("${meta.name || 'sem nome'}", zoom ${meta.minZoom}–${meta.maxZoom}) desde ${date}${extra}. Queres abrir o mapa nessa área?`;
  document.getElementById('offline-prompt-overlay').classList.remove('hidden');

  document.getElementById('offline-prompt-yes').onclick = ()=>{
    document.getElementById('offline-prompt-overlay').classList.add('hidden');
    const b = L.latLngBounds(meta.bounds[0], meta.bounds[1]);
    map.fitBounds(b);
  };
  document.getElementById('offline-prompt-no').onclick = ()=>{
    document.getElementById('offline-prompt-overlay').classList.add('hidden');
  };
}

/* ============================================================
   CONECTIVIDADE — deteta perda de ligação e bloqueia o mapa
   ============================================================ */
let offlineSessionActive = false; // true quando o utilizador escolheu trabalhar com uma área guardada
let offlineBoundaryLayer = null;  // contorno tracejado vermelho da área com tiles guardados
let offlineMaskLayer = null;      // sombreado vermelho fora dessa área
let wasOffline = !navigator.onLine; // estado anterior, para detetar a transição offline -> online

function showReconnectedToast(){
  const toast = document.getElementById('connectivity-restored-toast');
  if(!toast) return;
  clearTimeout(toast._hideTimer);
  toast.classList.remove('is-leaving');
  // força reflow para reiniciar a animação caso já estivesse a aparecer
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  toast._hideTimer = setTimeout(()=>{
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
  }, 3200);
}

function showWelcomeToast(){
  const toast = document.getElementById('welcome-toast');
  if(!toast) return;
  clearTimeout(toast._hideTimer);
  toast.classList.remove('is-leaving');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  toast._hideTimer = setTimeout(()=>{
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
  }, 4200);
}

function setBackLinkDisabled(disabled){
  const link = document.getElementById('back-link');
  if(!link) return;
  link.classList.toggle('is-disabled', disabled);
  if(disabled){
    link.setAttribute('aria-disabled', 'true');
    link.title = 'Sem ligação à internet — não é possível voltar ao portal agora.';
  } else {
    link.removeAttribute('aria-disabled');
    link.removeAttribute('title');
  }
}
let pendingExitAction = null;
let suppressProjectRestoreErrorAlert = false;

function hasUnsavedChanges(){
  return Boolean(projectDirty && featuresData.size > 0);
}

function showExitConfirmOverlay(){
  const overlay = document.getElementById('exit-confirm-overlay');
  if(!overlay) return;
  overlay.classList.remove('hidden');
  void overlay.offsetWidth;
  overlay.classList.add('is-visible');
}

function hideExitConfirmOverlay(){
  const overlay = document.getElementById('exit-confirm-overlay');
  if(!overlay) return;
  overlay.classList.add('hidden');
  overlay.classList.remove('is-visible');
}

// se houver alterações por guardar, mostra o modal antes de executar a ação (sair/recomeçar);
// caso contrário executa-a de imediato
function requestExit(action){
  if(hasUnsavedChanges()){
    pendingExitAction = action;
    showExitConfirmOverlay();
  } else {
    action();
  }
}

document.getElementById('exit-confirm-cancel').addEventListener('click', ()=>{
  hideExitConfirmOverlay();
  pendingExitAction = null;
});
document.getElementById('exit-confirm-discard').addEventListener('click', ()=>{
  hideExitConfirmOverlay();
  const action = pendingExitAction;
  pendingExitAction = null;
  if(action) action();
});
document.getElementById('exit-confirm-save').addEventListener('click', ()=>{
  const saved = saveCurrentProject();
  hideExitConfirmOverlay();
  const action = pendingExitAction;
  pendingExitAction = null;
  if(saved && action) action();
});

document.getElementById('back-link').addEventListener('click', (e)=>{
  if(!navigator.onLine){ e.preventDefault(); return; }
  e.preventDefault();
  requestExit(()=>{ window.location.href = 'index.html'; });
});

document.addEventListener('keydown', (event)=>{
  if(!hasUnsavedChanges()) return;
  const key = event.key.toLowerCase();
  const isReloadShortcut = key === 'f5' || ((event.ctrlKey || event.metaKey) && key === 'r');
  if(!isReloadShortcut) return;
  event.preventDefault();
  event.stopPropagation();
  pendingExitAction = ()=> window.location.reload();
  showExitConfirmOverlay();
});

// aviso nativo do browser ao fechar o separador/janela ou recarregar a página
window.addEventListener('beforeunload', (e)=>{
  if(hasUnsavedChanges()){
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

async function renderConnectivityOfflineMenu(){
  const menu = document.getElementById('connectivity-offline-menu');
  const areas = await idbGetAllMeta();
  if(!areas.length){
    menu.innerHTML = `<p class="connectivity-offline-empty">Ainda não guardaste nenhuma área para usar offline. Liga-te à internet e usa o botão de definir área offline no cabeçalho.</p>`;
    return;
  }
  menu.innerHTML = '';
  areas.forEach(meta=>{
    const date = new Date(meta.savedAt).toLocaleString('pt-PT');
    const item = document.createElement('div');
    item.className = 'connectivity-offline-item';
    item.innerHTML = `
      <div>
        <b>${meta.name || 'Área sem nome'}</b>
        <span>zoom ${meta.minZoom}–${meta.maxZoom} · desde ${date}</span>
      </div>
      <button type="button">Usar</button>
    `;
    item.querySelector('button').addEventListener('click', ()=> enterOfflineSession(meta));
    item.addEventListener('click', (e)=>{
      if(e.target.tagName !== 'BUTTON') enterOfflineSession(meta);
    });
    menu.appendChild(item);
  });
}

document.getElementById('connectivity-enter-offline-btn').addEventListener('click', async ()=>{
  const menu = document.getElementById('connectivity-offline-menu');
  const willShow = menu.classList.contains('hidden');
  if(willShow) await renderConnectivityOfflineMenu();
  menu.classList.toggle('hidden', !willShow);
});

function enterOfflineSession(meta){
  offlineSessionActive = true;
  document.getElementById('connectivity-overlay').classList.add('hidden');
  document.getElementById('connectivity-offline-menu').classList.add('hidden');

  const banner = document.getElementById('connectivity-active-banner');
  document.getElementById('connectivity-active-banner-area').textContent = ` — área "${meta.name || meta.layerKey}"`;
  banner.classList.remove('hidden');

  const b = L.latLngBounds(meta.bounds[0], meta.bounds[1]);
  map.fitBounds(b);
  map.setMaxBounds(b.pad(0.15)); // mantém o utilizador dentro da área com tiles guardados

  // sombreia a vermelho tracejado tudo o que fica fora da área com tiles guardados
  const outerRing = [[-85,-180], [-85,180], [85,180], [85,-180]];
  const holeRing = [
    [b.getSouth(), b.getWest()], [b.getNorth(), b.getWest()],
    [b.getNorth(), b.getEast()], [b.getSouth(), b.getEast()]
  ];
  offlineMaskLayer = L.polygon([outerRing, holeRing], {
    stroke:false, fillColor:'#B5472B', fillOpacity:.16, interactive:false
  }).addTo(map);
  offlineBoundaryLayer = L.rectangle(b, {
    color:'#B5472B', weight:2, dashArray:'8,6', fill:false, interactive:false
  }).addTo(map);
}

function exitOfflineSession(){
  offlineSessionActive = false;
  document.getElementById('connectivity-active-banner').classList.add('hidden');
  map.setMaxBounds(null);
  if(offlineMaskLayer){ map.removeLayer(offlineMaskLayer); offlineMaskLayer = null; }
  if(offlineBoundaryLayer){ map.removeLayer(offlineBoundaryLayer); offlineBoundaryLayer = null; }
}

function updateConnectivityUI(){
  const overlay = document.getElementById('connectivity-overlay');
  if(navigator.onLine){
    overlay.classList.add('hidden');
    document.getElementById('connectivity-offline-menu').classList.add('hidden');
    setBackLinkDisabled(false);
    if(offlineSessionActive) exitOfflineSession();
    if(wasOffline) showReconnectedToast();
  } else {
    setBackLinkDisabled(true);
    if(!offlineSessionActive){
      overlay.classList.remove('hidden');
    }
  }
  wasOffline = !navigator.onLine;
}

window.addEventListener('online', updateConnectivityUI);
window.addEventListener('offline', updateConnectivityUI);

/* ============================================================
   WIZARD — passo 1
   ============================================================ */
document.querySelectorAll('[data-mode]').forEach(card=>{
  card.addEventListener('click', ()=>{
    document.querySelectorAll('[data-mode]').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    config.mode = card.dataset.mode;
    validateStep1Continue();
  });
});

document.getElementById('wizard-shape-name').addEventListener('input', ()=>{
  document.getElementById('wizard-shape-name-error').style.display = 'none';
  validateStep1Continue();
});

function validateStep1Continue(){
  const hasName = document.getElementById('wizard-shape-name').value.trim().length > 0;
  document.getElementById('step1-next').disabled = !(hasName && config.mode);
}

document.getElementById('step1-next').addEventListener('click', ()=>{
  const name = document.getElementById('wizard-shape-name').value.trim();
  if(!name){
    document.getElementById('wizard-shape-name-error').style.display = 'block';
    return;
  }
  config.shapeName = name;

  if(config.mode === 'atributos'){
    if(config.attributes.length === 0) addAttributeBlock();
    document.getElementById('step3-total').textContent = '3';
    document.getElementById('step3-num').textContent = '3';
    showStep(2);
  } else {
    document.getElementById('step3-total').textContent = '2';
    document.getElementById('step3-num').textContent = '2';
    showStep(3);
  }
});

function showStep(n){
  document.querySelectorAll('.wizard-step').forEach(s=>{
    s.style.display = (s.dataset.step == n) ? '' : 'none';
  });
}

document.getElementById('open-wizard-btn').addEventListener('click', ()=>{
  toggleCloudMenu();
});

document.getElementById('btn-cloud-settings')?.addEventListener('click', (event)=>{
  event.stopPropagation();
  toggleSettingsMenu(true);
});

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

function requestConfirmation(message){
  if(!settings.confirmDeletes) return true;
  return confirm(message);
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
    snapSegment: true
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

function formatDistance(distance){
  if(settings.distanceUnits === 'imperial'){
    const feet = distance * 3.28084;
    return feet >= 5280 ? `${(feet / 5280).toFixed(2)} mi` : `${Math.round(feet)} ft`;
  }
  return distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
}

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

      <div class="cloud-menu-actions" style="margin-top:4px; display:flex; flex-direction:column; gap:8px;">
        <div class="hint" style="font-size:11.5px; color:var(--stone);">As alterações só ficam definitivas depois de guardar.</div>
        <button type="button" class="btn primary" id="settings-save-btn">Guardar alterações</button>
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
      if(!projectName || !password){ alert('Introduz o nome do projeto e a password para eliminar.'); return; }
      if(!requestConfirmation(`Eliminar o projeto “${projectName}” da base de dados? Esta ação não pode ser desfeita.`)) return;
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
        alert('Não foi possível eliminar o projeto. Verifica o nome e a password.');
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

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
    alert('Não foi possível guardar o projeto localmente (armazenamento cheio ou indisponível).');
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
    geojson: buildGeoJSON(false, true)
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
  const toast = document.getElementById('autosave-toast');
  if(!toast) return;
  toast.querySelector('.message').textContent = message;
  toast.classList.remove('is-leaving');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(()=>{
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
  }, 3200);
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
          layers.push({id:l.id, name:l.name, geometryType:l.geometryType, mode:l.mode, attributes:l.attributes || [], colorAttr:l.colorAttr || null, baseColor:l.baseColor || null, opacity: (l.opacity != null ? l.opacity : null), symbology: cloneSymbology(l.symbology)});
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
    config.symbology = defaultSymbology();
    if(!suppressAlert){
      alert('Não foi possível restaurar este projeto corretamente. O estado foi limpo e ficou pronto para começar de novo.');
    }
  }

  applyLayerZOrder();
  finalizeLoadedProjectState();

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

/* ============================================================
   TOGGLE DAS FERRAMENTAS DE EDIÇÃO (draw / edit layers / drag layers /
   remove layers) — por omissão ficam escondidas; o botão do lápis no
   cabeçalho (antes do "Vetorizar") liga/desliga a sua visibilidade.
   As ferramentas em si (map.pm.addControls / applyGeometryConfig) não
   são alteradas — apenas escondemos/mostramos a toolbar já existente
   via CSS (classe "pm-toolbar-visible" em #map).
   ============================================================ */
(function(){
  const toggleBtn = document.getElementById('btn-toggle-pm-toolbar');
  const mapEl = document.getElementById('map');
  if(!toggleBtn || !mapEl) return;
  toggleBtn.addEventListener('click', ()=>{
    const nowVisible = mapEl.classList.toggle('pm-toolbar-visible');
    toggleBtn.classList.toggle('is-active', nowVisible);
    toggleBtn.setAttribute('aria-pressed', nowVisible ? 'true' : 'false');
  });
})();

document.getElementById('open-feature-wizard-btn').addEventListener('click', ()=>{
  archiveActiveLayerIfNeeded();
  document.getElementById('wizard-overlay').classList.remove('hidden');
  document.getElementById('wizard-shape-name').value = config.shapeName || '';
  document.getElementById('wizard-shape-name-error').style.display = 'none';
  validateStep1Continue();
  showStep(1);
  dismissGearCoachmark();
});

/* Se já existe uma camada configurada e com o wizard concluído, guarda-a na lista
   de camadas antes de começar a configurar uma nova — assim não desaparece do painel. */
function archiveActiveLayerIfNeeded(){
  if(!config.geometryType) return; // ainda não há nenhuma camada configurada, nada a arquivar
  const sanitizedName = (config.shapeName || '').toString().trim();
  if(!sanitizedName){
    alert('Dá um nome à camada antes de a guardar.');
    return;
  }

  layers.push({
    id: activeLayerId,
    name: sanitizedName,
    geometryType: config.geometryType,
    mode: config.mode,
    attributes: Array.isArray(config.attributes) ? config.attributes.filter(a=>a && a.name && a.name.trim()) : [],
    colorAttr: config.colorAttr,
    baseColor: config.baseColor,
    opacity: config.opacity,
    symbology: cloneSymbology(config.symbology)
  });
  activeLayerId = ++layerCounter;
  layerVisible.set(activeLayerId, true);
  config.shapeName = null;
  config.mode = null;
  config.attributes = [];
  config.geometryType = null;
  config.colorAttr = null;
  config.baseColor = null;
  config.opacity = null;
  config.symbology = defaultSymbology();
  refreshLayerEditability();
}

document.getElementById('wizard-close-btn').addEventListener('click', ()=>{
  document.getElementById('wizard-overlay').classList.add('hidden');
});

/* ============================================================
   ATERRAGEM — "Iniciar projeto" + coach-mark da engrenagem
   ============================================================ */
function proceedToMap(){
  document.getElementById('landing-banner').classList.add('hidden');
  map.flyTo([39.6, -8.0], 7, { duration: 2.2, easeLinearity: 0.25 });
  map.once('moveend', showGearCoachmark);
  // nota: deixámos de mostrar o popup "Área offline encontrada" ao reabrir o projeto;
  // as áreas guardadas continuam acessíveis a partir do botão de área offline no cabeçalho.
}

function showGearCoachmark(){
  positionGearCoachmark();
  document.getElementById('gear-coachmark').classList.remove('hidden');
}

function positionGearCoachmark(){
  const btn = document.getElementById('open-feature-wizard-btn');
  const bubble = document.getElementById('gear-coachmark');
  const btnRect = btn.getBoundingClientRect();
  const bubbleWidth = 220;
  let left = btnRect.right - bubbleWidth + 12; // alinha a ponta da seta com o centro do botão
  left = Math.max(10, Math.min(left, window.innerWidth - bubbleWidth - 10));
  bubble.style.left = left + 'px';
  bubble.style.top = (btnRect.bottom + 10) + 'px';
}

function dismissGearCoachmark(){
  document.getElementById('gear-coachmark').classList.add('hidden');
}

document.getElementById('gear-coachmark-close').addEventListener('click', dismissGearCoachmark);
window.addEventListener('resize', ()=>{
  if(!document.getElementById('gear-coachmark').classList.contains('hidden')){
    positionGearCoachmark();
  }
});

/* ============================================================
   WIZARD — passo 2 (atributos)
   ============================================================ */
const attrsContainer = document.getElementById('attrs-container');

function addAttributeBlock(){
  if(config.attributes.length >= 3) return;
  const idx = config.attributes.length;
  const attr = {name:'', type:'texto', classes:[]};
  config.attributes.push(attr);
  renderAttrs();
}

function renderAttrs(){
  attrsContainer.innerHTML = '';
  config.attributes.forEach((attr, idx)=>{
    const block = document.createElement('div');
    block.className = 'attr-block';
    block.innerHTML = `
      <div class="attr-head">
        <b>Atributo ${idx+1}</b>
        <button class="small-link" data-remove="${idx}" style="color:var(--warn);">Remover ✕</button>
      </div>
      <label style="font-size:11px;font-weight:600;color:var(--stone);">Nome do campo</label>
      <input type="text" data-name="${idx}" placeholder="ex: tipo_uso" value="${attr.name}">
      <label style="font-size:11px;font-weight:600;color:var(--stone);">Tipo</label>
      <select data-type="${idx}">
        <option value="texto" ${attr.type==='texto'?'selected':''}>Texto livre</option>
        <option value="numero" ${attr.type==='numero'?'selected':''}>Numérico</option>
        <option value="categorico" ${attr.type==='categorico'?'selected':''}>Categórico (classes predefinidas)</option>
      </select>
      <div class="classes-wrap" data-classes-wrap="${idx}" style="${attr.type==='categorico'?'':'display:none;'}">
        <label style="font-size:11px;font-weight:600;color:var(--stone);">Classes</label>
        <div data-classes-list="${idx}"></div>
        <button class="small-link" data-add-class="${idx}">+ Adicionar classe</button>
      </div>
    `;
    attrsContainer.appendChild(block);
    renderClasses(idx);
  });

  attrsContainer.querySelectorAll('[data-remove]').forEach(b=>{
    b.addEventListener('click', ()=>{
      config.attributes.splice(+b.dataset.remove,1);
      renderAttrs();
    });
  });
  attrsContainer.querySelectorAll('[data-name]').forEach(inp=>{
    inp.addEventListener('input', ()=>{ config.attributes[+inp.dataset.name].name = inp.value; });
  });
  attrsContainer.querySelectorAll('[data-type]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const i = +sel.dataset.type;
      config.attributes[i].type = sel.value;
      if(sel.value === 'categorico' && config.attributes[i].classes.length === 0){
        config.attributes[i].classes.push({name:'Classe 1', color: PALETTE[0]});
        config.attributes[i].classes.push({name:'Classe 2', color: PALETTE[1]});
      }
      renderAttrs();
    });
  });
  attrsContainer.querySelectorAll('[data-add-class]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = +b.dataset.addClass;
      const n = config.attributes[i].classes.length;
      config.attributes[i].classes.push({name:'Classe '+(n+1), color: PALETTE[n % PALETTE.length]});
      renderClasses(i);
    });
  });

  document.getElementById('add-attr').style.display = config.attributes.length >= 3 ? 'none' : '';
}

function renderClasses(idx){
  const wrap = attrsContainer.querySelector(`[data-classes-list="${idx}"]`);
  if(!wrap) return;
  const attr = config.attributes[idx];
  wrap.innerHTML = '';
  attr.classes.forEach((cls, ci)=>{
    const row = document.createElement('div');
    row.className = 'class-row';
    row.innerHTML = `
      <input type="color" value="${cls.color}" data-cls-color="${idx}:${ci}">
      <input type="text" value="${cls.name}" data-cls-name="${idx}:${ci}" placeholder="Nome da classe">
      <button data-cls-remove="${idx}:${ci}" title="Remover classe">✕</button>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('[data-cls-color]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const [i,ci] = inp.dataset.clsColor.split(':').map(Number);
      config.attributes[i].classes[ci].color = inp.value;
    });
  });
  wrap.querySelectorAll('[data-cls-name]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const [i,ci] = inp.dataset.clsName.split(':').map(Number);
      config.attributes[i].classes[ci].name = inp.value;
    });
  });
  wrap.querySelectorAll('[data-cls-remove]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const [i,ci] = b.dataset.clsRemove.split(':').map(Number);
      config.attributes[i].classes.splice(ci,1);
      renderClasses(i);
    });
  });
}

document.getElementById('add-attr').addEventListener('click', addAttributeBlock);
document.getElementById('step2-back').addEventListener('click', ()=> showStep(1));
document.getElementById('step2-next').addEventListener('click', ()=>{
  config.attributes = (Array.isArray(config.attributes) ? config.attributes : []).filter(a=>a && typeof a === 'object' && a.name && a.name.toString().trim() !== '');
  showStep(3);
});

/* ============================================================
   WIZARD — passo 3 (geometria)
   ============================================================ */
document.querySelectorAll('[data-geom]').forEach(card=>{
  card.addEventListener('click', ()=>{
    document.querySelectorAll('[data-geom]').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    const geomValue = card.dataset.geom;
    if(!['Point','LineString','Polygon'].includes(geomValue)){
      alert('Tipo de geometria inválido.');
      return;
    }
    config.geometryType = geomValue;
    document.getElementById('step3-finish').disabled = false;
  });
});
document.getElementById('step3-back').addEventListener('click', ()=>{
  showStep(config.mode === 'atributos' ? 2 : 1);
});
document.getElementById('step3-finish').addEventListener('click', finishWizard);

function finishWizard(){
  const shapeName = (document.getElementById('wizard-shape-name')?.value || '').toString().trim();
  if(!shapeName){
    alert('Dá um nome à camada antes de concluir.');
    return;
  }
  config.shapeName = shapeName;
  document.getElementById('wizard-overlay').classList.add('hidden');
  setupSummary();
  applyGeometryConfig();
  refreshFeatList();
  refreshLayerEditability();
}

function setupSummary(){
  // o resumo de "tipo de geometria + atributos" da camada ativa deixou de ser
  // mostrado no painel — a lista de camadas já traz essa informação em cada linha.
}

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

function initMap(){
  map = L.map('map', {zoomControl:true, maxZoom: 24}).setView([20, 0], 2);

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

  // regista qual a camada base ativa, para saber o que cachear no modo offline
  activeBaseLayerKey = 'satelite';

  function renderBasemapMenu(){
    document.querySelectorAll('#basemap-menu button[data-basemap]').forEach(btn=>{
      btn.classList.toggle('is-active', btn.dataset.basemap === activeBaseLayerKey);
    });
    const autoBtn = document.getElementById('basemap-auto-toggle');
    if(autoBtn) autoBtn.classList.toggle('is-active', autoResolutionEnabled);
  }

  function switchBasemap(key, opts){
    opts = opts || {};
    const next = basemaps[key];
    if(!next || key === activeBaseLayerKey){ closeBasemapMenu(); return; }
    Object.values(basemaps).forEach(l=>{ if(l !== next && map.hasLayer(l)) map.removeLayer(l); });
    if(!map.hasLayer(next)) next.addTo(map);
    activeBaseLayerKey = key;
    renderBasemapMenu();
    closeBasemapMenu();
    if(key === 'dgt' && !opts.auto){
      showToolbarHint('Portugal HD (DGT): só mostra imagem a partir de zoom de cidade/bairro — aproxima-te para veres o detalhe.', 6000);
    }
  }

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
  map.on('zoomend moveend', maybeAutoSwitchBasemap);

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

loadSettings();
initMap(); // o mapa fica pronto logo ao carregar a página (já chama updateMapGridVisibility() internamente)
initializeWorkspaces();
if(settings.autoSaveEnabled){ enableAutoSave(); }
maybeRestoreLastProjectOnStartup();
initTeamUI();

/* ============================================================
   CRIAÇÃO DE FEATURE + FORMULÁRIO DE ATRIBUTOS
   ============================================================ */
function genFid(){
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('fid-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

function onFeatureCreated(layer){
  if(offlineDrawing || rulerDrawing) return; // retângulo offline / linha da régua não são geometrias do utilizador
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
  // manter as estatísticas e a verificação de topologia sempre atualizadas
  layer.on('pm:edit', ()=>{ entry.updatedAt = Date.now(); markProjectDirty(); refreshStatsIfOpen(entry); checkAllTopology(); if(entry.showMeasures) renderPolygonMeasures(entry); });
  layer.on('pm:dragend', ()=>{ entry.updatedAt = Date.now(); markProjectDirty(); refreshStatsIfOpen(entry); checkAllTopology(); if(entry.showMeasures) renderPolygonMeasures(entry); });

  // sem popup ao criar: a geometria fica logo com o nome genérico "Geometria N"
  // e aparece de imediato na lista/tabela; atributos (se o modo os tiver) editam-se na tabela
  refreshFeatList();

  checkAllTopology();
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
}

/* ============================================================
   IMPORTAR GEOJSON / SHAPEFILE
   ============================================================ */
function baseGeomType(t){
  if(t === 'MultiPoint') return 'Point';
  if(t === 'MultiLineString') return 'LineString';
  if(t === 'MultiPolygon') return 'Polygon';
  return t;
}

function getImportedLayerName(fileName){
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  const clean = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || 'Camada importada';
}

function ensureImportedLayerSchema(layerName, geometryType){
  if(!geometryType) return;
  if(!config.geometryType){
    config.shapeName = layerName || 'Camada importada';
    config.mode = 'atributos';
    config.geometryType = geometryType;
    config.attributes = [];
    config.colorAttr = null;
    config.baseColor = null;
    config.opacity = null;
    config.symbology = defaultSymbology();
    if(!layerVisible.has(activeLayerId)) layerVisible.set(activeLayerId, true);
    if(!layerOrder.includes(activeLayerId)) layerOrder.unshift(activeLayerId);
    ensureLayerPane(activeLayerId);
  } else if(!config.shapeName && layerName){
    config.shapeName = layerName;
  }
}

async function parseImportedFile(file){
  const name = file.name.toLowerCase();
  const layerName = getImportedLayerName(file.name);
  if(name.endsWith('.zip')){
    const buffer = await file.arrayBuffer();
    const result = await shp(buffer);
    if(Array.isArray(result)){
      return {type:'FeatureCollection', features: result.flatMap(fc => fc.features || []), layerName};
    }
    return {...result, layerName};
  }
  const text = await file.text();
  const parsed = JSON.parse(text);
  if(parsed.type === 'FeatureCollection') return {...parsed, layerName};
  if(parsed.type === 'Feature') return {type:'FeatureCollection', features:[parsed], layerName};
  if(parsed.type){ return {type:'FeatureCollection', features:[{type:'Feature', properties:{}, geometry:parsed}], layerName}; }
  throw new Error('Formato GeoJSON não reconhecido.');
}

/* ---------- .shp/.dbf/.shx/.prj soltos (sem .zip) ----------
   Agrupa os ficheiros selecionados pelo nome base (ex.: "estradas.shp"
   + "estradas.dbf" + "estradas.prj" -> grupo "estradas") e usa as
   funções de baixo nível da shpjs (já carregada para o .zip) para
   construir o GeoJSON, uma "camada" por grupo/.shp encontrado. */
function groupLooseShapefileParts(files){
  const groups = new Map();
  files.forEach(f=>{
    const m = f.name.match(/^(.*)\.(shp|dbf|shx|prj|cpg)$/i);
    if(!m) return;
    const base = m[1].toLowerCase();
    const ext = m[2].toLowerCase();
    if(!groups.has(base)) groups.set(base, {});
    groups.get(base)[ext] = f;
  });
  return groups;
}

async function parseLooseShapefileParts(files){
  const groups = groupLooseShapefileParts(files);
  const collections = [];
  for(const parts of groups.values()){
    if(!parts.shp) continue; // sem .shp não há geometria para este grupo
    const layerName = getImportedLayerName(parts.shp.name);
    const shpBuffer = await parts.shp.arrayBuffer();
    let prjText;
    if(parts.prj){ try{ prjText = await parts.prj.text(); }catch(e){ prjText = undefined; } }
    const geometries = shp.parseShp(shpBuffer, prjText);

    let properties = geometries.map(()=>({}));
    if(parts.dbf){
      const dbfBuffer = await parts.dbf.arrayBuffer();
      let cpgText;
      if(parts.cpg){ try{ cpgText = (await parts.cpg.text()).trim(); }catch(e){ cpgText = undefined; } }
      try{ properties = shp.parseDbf(dbfBuffer, cpgText); }catch(e){ /* .dbf ilegível: segue só com geometria */ }
    }

    const gj = shp.combine([geometries, properties]);
    collections.push({...gj, layerName});
  }
  if(!collections.length){
    throw new Error('Não foi encontrado nenhum ficheiro .shp válido na seleção.');
  }
  return collections;
}

function importGeoJSONFeatures(geojson, layerIdResolver, silent, options = {}){
  if(!geojson || typeof geojson !== 'object' || !Array.isArray(geojson.features)){
    alert('O conteúdo importado não tem o formato esperado de GeoJSON.');
    return {imported:0, skipped:0};
  }

  const features = geojson.features.filter(f => f && f.geometry);
  let imported = 0, skipped = 0;

  const firstGeometryType = features.length ? baseGeomType(features.find(f => f.geometry && f.geometry.type)?.geometry?.type) : null;
  if(!layerIdResolver && firstGeometryType){
    ensureImportedLayerSchema(options.layerName || geojson.layerName || null, firstGeometryType);
  }

  let typeMismatch = 0;

  features.forEach(f=>{
    let layer;
    try{ layer = L.geoJSON(f).getLayers()[0]; }
    catch(err){ skipped++; return; }
    if(!layer){ skipped++; return; }

    const rawProps = f.properties && typeof f.properties === 'object' ? {...f.properties} : {};
    const layerId = layerIdResolver ? layerIdResolver(rawProps) : activeLayerId;

    // valida a geometria importada contra o tipo configurado da camada de destino
    // (impede geometrias mistas numa camada, o que deixava o estado da app inconsistente)
    const targetSchema = getLayerSchema(layerId);
    const targetGeomType = targetSchema ? targetSchema.geometryType : config.geometryType;
    const importedGeomType = baseGeomType(f.geometry.type);
    if(targetGeomType && importedGeomType && targetGeomType !== importedGeomType){
      typeMismatch++;
      return;
    }

    drawnGroup.addLayer(layer);
    featureCounter++;
    const id = L.Util.stamp(layer);
    const fid = rawProps.__fid || genFid();
    const updatedAt = rawProps.__updatedAt || Date.now();
    assignLayerPane(layer, layerId);
    delete rawProps.__fid;
    delete rawProps.__updatedAt;
    delete rawProps.__layerId;
    const props = rawProps;
    inferLayerAttributesFromProps(layerId, props);
    const label = props.name || props.label || 'Geometria '+featureCounter;
    const geomType = baseGeomType(f.geometry.type);
    const entry = {layer, props, id, fid, updatedAt, label, geomType, layerId, hasOverlap:false, overlapsWith:[], showMeasures:false, measureTooltips:[]};
    featuresData.set(id, entry);

    styleLayerByClass(entry);
    if(!getLayerSchema(layerId) || getLayerSchema(layerId).mode !== 'atributos'){ styleLayerDefault(layer, layerId); }
    bindFeatureContextMenu(entry);
    layer.on('pm:edit', ()=>{ entry.updatedAt = Date.now(); markProjectDirty(); refreshStatsIfOpen(entry); checkAllTopology(); if(entry.showMeasures) renderPolygonMeasures(entry); });
    layer.on('pm:dragend', ()=>{ entry.updatedAt = Date.now(); markProjectDirty(); refreshStatsIfOpen(entry); checkAllTopology(); if(entry.showMeasures) renderPolygonMeasures(entry); });

    imported++;
  });

  if(!options.deferPostProcess){
    refreshFeatList();
    checkAllTopology();

    if(imported > 0){
      try{ map.fitBounds(drawnGroup.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }
    }
  }

  const parts = [];
  if(imported > 0) parts.push(`Importadas ${imported} geometria(s) com sucesso.`);
  if(skipped > 0) parts.push(`${skipped} geometria(s) inválida(s) ou ilegível(is) foram ignoradas.`);
  if(typeMismatch > 0) parts.push(`${typeMismatch} geometria(s) foram ignoradas por não corresponderem ao tipo configurado da camada de destino.`);
  const msg = parts.length ? parts.join(' ') : 'Nenhuma geometria válida encontrada no ficheiro.';
  if(!silent) alert(msg);
  return {imported, skipped, typeMismatch};
}

/* Conclui o pós-processamento pesado que o import em lotes (importFeaturesInChunks)
   propositadamente adia até ao fim, para não repetir checkAllTopology()/fitBounds()
   uma vez por lote (isso, sim, travava/crashava com ficheiros grandes). */
function finalizeChunkedImport(){
  refreshFeatList();
  checkAllTopology();
  if(featuresData.size > 0){
    try{ map.fitBounds(drawnGroup.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }
  }
}

/* Importa um FeatureCollection potencialmente enorme em lotes, cedendo o
   thread principal (via requestAnimationFrame) entre cada lote. Isto não
   reduz o pico de memória do GeoJSON já parseado, mas evita o bloqueio
   síncrono prolongado que levava o separador a ficar "sem resposta" e,
   em ficheiros muito grandes, a ser morto pelo browser. */
async function importFeaturesInChunks(geojson, layerName, chunkSize = 400){
  const allFeatures = Array.isArray(geojson.features) ? geojson.features : [];
  const total = allFeatures.length;
  if(total <= chunkSize){
    const res = importGeoJSONFeatures({...geojson, layerName}, null, true, { layerName });
    finalizeChunkedImport();
    return res;
  }

  let imported = 0, skipped = 0, typeMismatch = 0;
  for(let i = 0; i < total; i += chunkSize){
    const chunk = { type:'FeatureCollection', features: allFeatures.slice(i, i + chunkSize), layerName };
    const res = importGeoJSONFeatures(chunk, null, true, { layerName, deferPostProcess:true });
    imported += res.imported; skipped += res.skipped; typeMismatch += res.typeMismatch;
    // dá uma oportunidade ao browser de pintar/libertar memória entre lotes
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  finalizeChunkedImport();
  return {imported, skipped, typeMismatch};
}

document.getElementById('btn-import-geom').addEventListener('click', ()=>{
  document.getElementById('import-file-input').click();
});

async function processImportedFiles(files){
  if(!files.length) return;

  try{
    const hasLooseShp = files.some(f => /\.shp$/i.test(f.name));

    if(hasLooseShp){
      const collections = await parseLooseShapefileParts(files);
      let totalImported = 0, totalSkipped = 0, totalMismatch = 0;
      for(const gj of collections){
        const res = await importFeaturesInChunks(gj, gj.layerName || 'Camada importada');
        totalImported += res.imported; totalSkipped += res.skipped; totalMismatch += res.typeMismatch;
      }
      const parts = [];
      if(totalImported > 0) parts.push(`Importadas ${totalImported} geometria(s) com sucesso.`);
      if(totalSkipped > 0) parts.push(`${totalSkipped} geometria(s) ignorada(s).`);
      if(totalMismatch > 0) parts.push(`${totalMismatch} geometria(s) não corresponderam à camada de destino.`);
      alert(parts.length ? parts.join(' ') : 'Nenhuma geometria válida encontrada nos ficheiros .shp selecionados.');
      markProjectDirty();
      return;
    }

    const file = files[0];

    // ficheiros grandes (ex.: .zip de shapefile com dezenas/centenas de MB): o parsing
    // e a construção de milhares de geometrias no browser consomem muita memória, por
    // isso avisa-se e dá-se a opção de cancelar antes de tentar, em vez de deixar o
    // separador simplesmente crashar sem explicação.
    const sizeMB = file.size / (1024*1024);
    if(sizeMB > 80){
      const proceed = confirm(
        `O ficheiro "${file.name}" tem cerca de ${sizeMB.toFixed(0)} MB.\n` +
        `Ficheiros deste tamanho podem demorar bastante e, em computadores com pouca ` +
        `memória, podem fazer o separador do browser crashar.\n\nQueres continuar mesmo assim?`
      );
      if(!proceed) return;
    }

    const geojson = await parseImportedFile(file);
    const layerName = geojson.layerName || getImportedLayerName(file.name);
    const res = await importFeaturesInChunks(geojson, layerName);
    const parts = [];
    if(res.imported > 0) parts.push(`Importadas ${res.imported} geometria(s) com sucesso.`);
    if(res.skipped > 0) parts.push(`${res.skipped} geometria(s) inválida(s) ou ilegível(is) foram ignoradas.`);
    if(res.typeMismatch > 0) parts.push(`${res.typeMismatch} geometria(s) foram ignoradas por não corresponderem ao tipo configurado da camada de destino.`);
    alert(parts.length ? parts.join(' ') : 'Nenhuma geometria válida encontrada no ficheiro.');
    markProjectDirty();
  }catch(err){
    console.error('Erro ao importar ficheiro:', err);
    alert('Não foi possível importar o ficheiro. Verifica se é um GeoJSON válido, um .zip de Shapefile (.shp + .dbf + .shx, opcionalmente .prj), ou ficheiros .shp/.dbf/.shx soltos.');
  }
}

document.getElementById('import-file-input').addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  await processImportedFiles(files);
});

/* ============================================================
   ARRASTAR-E-LARGAR — o browser nunca deixa um <input type="file">
   ver os "irmãos" de um ficheiro (.dbf/.shx/.prj do mesmo .shp) só
   por segurança/sandboxing; não há forma de contornar isso com um
   clique simples. Mas ao ARRASTAR uma PASTA inteira para cima do
   mapa, a API de arrastar do browser (webkitGetAsEntry) dá acesso
   ao conteúdo dessa pasta — por isso esta é a forma real de "só
   apontar para o sítio e ele vai buscar o resto": arrasta a pasta
   onde estão o .shp/.dbf/.shx/.prj (ou o .zip, ou um .geojson) e
   este código lê tudo lá dentro sozinho.
   ============================================================ */
async function readAllDirEntries(reader){
  let all = [];
  let batch;
  do{
    batch = await new Promise((resolve, reject)=> reader.readEntries(resolve, reject));
    all = all.concat(batch);
  } while(batch.length > 0); // o Chrome só devolve até 100 de cada vez
  return all;
}

async function collectFilesFromEntry(entry, out){
  if(!entry) return;
  if(entry.isFile){
    const file = await new Promise((resolve, reject)=> entry.file(resolve, reject));
    out.push(file);
  } else if(entry.isDirectory){
    const entries = await readAllDirEntries(entry.createReader());
    for(const child of entries){ await collectFilesFromEntry(child, out); }
  }
}

async function collectFilesFromDataTransfer(dataTransfer){
  const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const out = [];
  if(items.length && items[0].webkitGetAsEntry){
    for(const item of items){
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if(entry) await collectFilesFromEntry(entry, out);
      else if(item.getAsFile){ const f = item.getAsFile(); if(f) out.push(f); }
    }
  } else if(dataTransfer && dataTransfer.files){
    out.push(...Array.from(dataTransfer.files)); // fallback: browser sem suporte a pastas arrastadas
  }
  return out;
}

(function wireImportDragAndDrop(){
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    body.is-file-drag-over::after{
      content:"Larga aqui para importar (.shp/.dbf/.shx/.prj, .zip ou .geojson)";
      position:fixed; inset:0; z-index:2147482000;
      display:flex; align-items:center; justify-content:center;
      background:rgba(23,49,36,.55); color:#fff;
      font-family:'IBM Plex Sans', sans-serif; font-size:18px; font-weight:700;
      text-align:center; padding:40px; pointer-events:none;
      border:4px dashed rgba(255,255,255,.7); box-sizing:border-box;
    }
  `;
  document.head.appendChild(styleEl);

  const isFileDrag = (ev)=> ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');

  // Nota: NÃO se usa um contador de dragenter/dragleave (fica facilmente
  // dessincronizado — ex. se o arrasto sair da janela do browser sem
  // largar em lado nenhum, o "dragleave" final às vezes não chega a
  // disparar, e o overlay fica preso a tapar o ecrã inteiro). Em vez
  // disso: o "dragover" dispara continuamente enquanto se arrasta por
  // cima da página, por isso basta reiniciar um temporizador a cada
  // "dragover" — se ele parar de disparar (arrasto saiu ou foi cancelado),
  // o overlay esconde-se sozinho pouco depois, sem poder ficar preso.
  let hideTimer = null;
  function showDragOverlay(){
    document.body.classList.add('is-file-drag-over');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideDragOverlay, 150);
  }
  function hideDragOverlay(){
    clearTimeout(hideTimer);
    hideTimer = null;
    document.body.classList.remove('is-file-drag-over');
  }

  document.addEventListener('dragenter', (ev)=>{
    if(!isFileDrag(ev)) return;
    ev.preventDefault();
    showDragOverlay();
  });
  document.addEventListener('dragover', (ev)=>{
    if(!isFileDrag(ev)) return;
    ev.preventDefault();
    showDragOverlay();
  });
  document.addEventListener('drop', async (ev)=>{
    if(!isFileDrag(ev)) return;
    ev.preventDefault();
    hideDragOverlay();
    const files = await collectFilesFromDataTransfer(ev.dataTransfer);
    if(files.length) await processImportedFiles(files);
  });
  // salvaguardas extra: se o utilizador sair da janela a meio do arrasto
  // (troca de app, alt-tab) sem largar nem voltar, o overlay não fica preso.
  window.addEventListener('blur', hideDragOverlay);
  document.addEventListener('mouseleave', hideDragOverlay);
})();

/* ============================================================
   SELECIONAR POR ATRIBUTOS (botão da lupa no cabeçalho)
   Cria uma nova camada só com as geometrias que cumprem uma
   condição simples (campo + operador + valor) sobre uma camada
   já existente. Reutiliza buildGeoJSON()/importGeoJSONFeatures()
   em vez de reinventar a criação de geometrias/camadas.
   ============================================================ */
(function(){
  const menu = document.getElementById('select-by-attr-menu');
  const btn = document.getElementById('btn-select-by-attr');
  const layerSelect = document.getElementById('select-by-attr-layer');
  const fieldSelect = document.getElementById('select-by-attr-field');
  const opSelect = document.getElementById('select-by-attr-op');
  const valueInput = document.getElementById('select-by-attr-value');
  const hintEl = document.getElementById('select-by-attr-hint');
  const statusEl = document.getElementById('select-by-attr-status');
  const applyBtn = document.getElementById('select-by-attr-apply');
  if(!menu || !btn) return;

  // lista de camadas com pelo menos 1 geometria (a ativa + as arquivadas em "layers")
  function listSelectableLayers(){
    const ids = layers.map(l=>l.id).concat(config.geometryType ? [activeLayerId] : []);
    return ids
      .filter(id => countLayerFeatures(id) > 0)
      .map(id => ({ id, schema: getLayerSchema(id) }))
      .filter(entry => entry.schema);
  }

  function populateLayerSelect(){
    const entries = listSelectableLayers();
    layerSelect.innerHTML = entries.length
      ? entries.map(e => `<option value="${e.id}">${escapeHtml(e.schema.name || 'Shape sem nome')}</option>`).join('')
      : '<option value="">Sem camadas com geometrias</option>';
    populateFieldSelect();
  }

  function currentLayerSchema(){
    const id = Number(layerSelect.value);
    if(!Number.isFinite(id)) return null;
    return getLayerSchema(id);
  }

  function populateFieldSelect(){
    const schema = currentLayerSchema();
    const attrs = (schema && schema.mode === 'atributos' && Array.isArray(schema.attributes)) ? schema.attributes : [];
    if(attrs.length){
      fieldSelect.innerHTML = attrs.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
      fieldSelect.disabled = false;
      opSelect.disabled = false;
      valueInput.disabled = false;
      applyBtn.disabled = false;
      hintEl.textContent = '';
    } else {
      fieldSelect.innerHTML = '<option value="">— sem campos —</option>';
      fieldSelect.disabled = true;
      opSelect.disabled = true;
      valueInput.disabled = true;
      applyBtn.disabled = true;
      hintEl.textContent = 'Esta camada não tem atributos definidos, por isso não é possível filtrar por campo.';
    }
  }

  layerSelect.addEventListener('change', populateFieldSelect);

  function openMenu(){
    populateLayerSelect();
    statusEl.textContent = '';
    menu.classList.remove('hidden');
    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
  }
  function closeMenu(){ menu.classList.add('hidden'); }

  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(menu.classList.contains('hidden')) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e)=>{
    if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      closeMenu();
    }
  });

  function evalCondition(rawValue, op, queryValue){
    const textA = String(rawValue ?? '').trim();
    const textQ = queryValue.trim();
    if(op === 'eq') return textA === textQ;
    if(op === 'neq') return textA !== textQ;
    if(op === 'contains') return textA.toLowerCase().includes(textQ.toLowerCase());
    if(op === 'gt' || op === 'lt'){
      const numA = parseFloat(rawValue);
      const numQ = parseFloat(queryValue);
      if(Number.isNaN(numA) || Number.isNaN(numQ)) return false;
      return op === 'gt' ? numA > numQ : numA < numQ;
    }
    return false;
  }

  applyBtn.addEventListener('click', ()=>{
    const layerId = Number(layerSelect.value);
    const fieldName = fieldSelect.value;
    const op = opSelect.value;
    const queryValue = valueInput.value;

    if(!Number.isFinite(layerId)){ statusEl.textContent = 'Escolhe uma camada.'; return; }
    if(!fieldName){ statusEl.textContent = 'Escolhe um campo.'; return; }
    if(queryValue.trim() === ''){ statusEl.textContent = 'Escreve um valor para comparar.'; return; }

    const sourceSchema = getLayerSchema(layerId);
    if(!sourceSchema){ statusEl.textContent = 'Camada inválida.'; return; }

    const collection = buildGeoJSON(false, false, layerId);
    const matched = collection.features.filter(f =>
      evalCondition(f.properties ? f.properties[fieldName] : undefined, op, queryValue)
    );

    if(matched.length === 0){
      statusEl.textContent = 'Nenhuma geometria corresponde a esta condição.';
      return;
    }

    const newLayerId = ++layerCounter;
    const newName = (sourceSchema.name || 'camada') + '_selectBA';
    layers.push({
      id: newLayerId,
      name: newName,
      geometryType: sourceSchema.geometryType,
      mode: sourceSchema.mode || 'atributos',
      attributes: Array.isArray(sourceSchema.attributes) ? sourceSchema.attributes.map(a=>({...a})) : [],
      colorAttr: sourceSchema.colorAttr || null,
      baseColor: sourceSchema.baseColor || null,
      opacity: sourceSchema.opacity,
      symbology: defaultSymbology()
    });

    importGeoJSONFeatures({type:'FeatureCollection', features: matched}, ()=>newLayerId, true);
    renderLayersPanel();
    markProjectDirty();

    statusEl.textContent = `✓ Criada a camada "${newName}" com ${matched.length} geometria(s).`;
    valueInput.value = '';
  });
})();

/* ============================================================
   MINI POP-UP DE ESTATÍSTICAS (ao concluir uma geometria)
   ============================================================ */
function geometryStatsHTML(entry){
  const gj = entry.layer.toGeoJSON();
  const type = gj.geometry.type;
  let rows = '';

  if(type === 'Point'){
    const [lng, lat] = gj.geometry.coordinates;
    rows += `<div class="stats-popup-row"><span>Latitude</span><b>${lat.toFixed(5)}</b></div>`;
    rows += `<div class="stats-popup-row"><span>Longitude</span><b>${lng.toFixed(5)}</b></div>`;
  } else if(type === 'LineString'){
    const km = turf.length(gj, {units:'kilometers'});
    rows += `<div class="stats-popup-row"><span>Extensão</span><b>${km < 1 ? (km*1000).toFixed(0)+' m' : km.toFixed(3)+' km'}</b></div>`;
  } else if(type === 'Polygon'){
    const m2 = turf.area(gj);
    const km2 = m2 / 1_000_000;
    const ha = m2 / 10_000;
    let perimKm = 0;
    try{ perimKm = turf.length(turf.polygonToLine(gj), {units:'kilometers'}); }catch(err){ perimKm = 0; }
    rows += `<div class="stats-popup-row"><span>Área</span><b>${km2 < 0.01 ? ha.toFixed(2)+' ha' : km2.toFixed(4)+' km²'}</b></div>`;
    rows += `<div class="stats-popup-row"><span>Perímetro</span><b>${perimKm < 1 ? (perimKm*1000).toFixed(0)+' m' : perimKm.toFixed(3)+' km'}</b></div>`;
  }

  let warnHtml = '';
  if(entry.hasOverlap && topologyWarningsEnabled){
    warnHtml = `<div class="stats-popup-warn">⚠ Sobreposto a: ${entry.overlapsWith.join(', ')}</div>`;
  }

  // mini edição de atributos: ao desenhar uma geometria, permite já preencher aqui
  // os atributos definidos na shape (categóricos como dropdown, texto/número como campo),
  // sem precisar de abrir a tabela de atributos
  let quickAttrHtml = '';
  const entrySchema = getLayerSchema(entry.layerId);
  if(entrySchema && entrySchema.mode === 'atributos'){
    quickAttrHtml = entrySchema.attributes.map(attr=>{
      if(attr.type === 'categorico'){
        const opts = attr.classes.map(c=>
          `<option value="${escapeHtml(c.name)}" ${entry.props[attr.name]===c.name?'selected':''}>${escapeHtml(c.name)}</option>`
        ).join('');
        return `
          <div class="stats-popup-quickattr">
            <label>${escapeHtml(attr.name)}</label>
            <select class="quick-attr-field" data-entry-id="${entry.id}" data-attr-name="${escapeHtml(attr.name)}">
              <option value="">—</option>
              ${opts}
            </select>
          </div>`;
      }
      const val = entry.props[attr.name] ?? '';
      return `
        <div class="stats-popup-quickattr">
          <label>${escapeHtml(attr.name)}</label>
          <input class="quick-attr-field" type="${attr.type==='numero'?'number':'text'}" data-entry-id="${entry.id}" data-attr-name="${escapeHtml(attr.name)}" value="${escapeHtml(String(val))}">
        </div>`;
    }).join('');
  }

  return `
    <div class="stats-popup-title"><span class="dot"></span>${entry.label}</div>
    ${rows}
    ${quickAttrHtml}
    ${warnHtml}
  `;
}

function showStatsPopup(entry){
  if(!entry.layer.bindPopup) return;
  entry.layer.bindPopup(geometryStatsHTML(entry), {
    className: 'datagis-stats-popup',
    closeButton: true,
    autoPan: true
  });
  entry.layer.openPopup();
}

function refreshStatsIfOpen(entry){
  if(!entry.layer.getPopup || !entry.layer.getPopup()) return;
  entry.layer.setPopupContent(geometryStatsHTML(entry));
}

// mini edição de atributos dentro do popup (dropdown para categóricos, campo para
// texto/número), delegado no document porque o popup é recriado a cada abertura
function handleQuickAttrEdit(e){
  const field = e.target.closest('.quick-attr-field');
  if(!field) return;
  const entry = featuresData.get(Number(field.dataset.entryId));
  if(!entry) return;
  entry.props[field.dataset.attrName] = field.value;
  entry.updatedAt = Date.now();
  markProjectDirty();
  styleLayerByClass(entry);
  if(entry.hasOverlap) applyTopologyVisual(entry);
  const tableOverlay = document.getElementById('attr-table-overlay');
  if(tableOverlay && !tableOverlay.classList.contains('hidden')) renderAttrTable(entry.layerId);
}
// 'change' cobre os dropdowns (categórico); 'input' cobre texto/número enquanto se escreve
document.addEventListener('change', handleQuickAttrEdit);
document.addEventListener('input', handleQuickAttrEdit);

/* ---------- realçar geometria selecionada (botão "olho" na lista) ---------- */
function flashHighlight(entry){
  if(entry.layer.setStyle){
    entry.layer.setStyle({weight:6, color: getHighlightColor(), fillOpacity:.5});
    setTimeout(()=>{
      if(entry.hasOverlap){
        applyTopologyVisual(entry);
      } else {
        const schema = getLayerSchema(entry.layerId);
        if(schema && schema.mode === 'atributos'){
          styleLayerByClass(entry);
        } else {
          styleLayerDefault(entry.layer, entry.layerId);
        }
      }
    }, 900);
  } else if(entry.layer._icon){
    entry.layer._icon.classList.add('marker-pulse');
    setTimeout(()=> entry.layer._icon && entry.layer._icon.classList.remove('marker-pulse'), 900);
  }
}

function getHighlightColor(){
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ochre').trim();
  return v || '#C2703D';
}

// gera (uma única vez) um padrão SVG de tracejado obliquo, usado como
// preenchimento de qualquer resultado de análise espacial (buffer, intersect,
// union, clip) para se destacar claramente da área original desenhada
function ensureResultHatchPattern(){
  let defsSvg = document.getElementById('result-hatch-defs');
  if(!defsSvg){
    defsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defsSvg.setAttribute('id', 'result-hatch-defs');
    defsSvg.setAttribute('width', '0');
    defsSvg.setAttribute('height', '0');
    defsSvg.style.position = 'absolute';
    defsSvg.innerHTML = `
      <defs>
        <pattern id="result-hatch-pattern" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)">
          <rect width="9" height="9" fill="rgba(0,0,0,0)"></rect>
          <line x1="0" y1="0" x2="0" y2="9" stroke-width="4"></line>
        </pattern>
      </defs>`;
    document.body.appendChild(defsSvg);
  }
  const line = defsSvg.querySelector('#result-hatch-pattern line');
  if(line) line.setAttribute('stroke', getHighlightColor());
  return 'url(#result-hatch-pattern)';
}

/* ============================================================
   TOPOLOGIA — deteção de polígonos sobrepostos
   ============================================================ */
function checkAllTopology(){
  if(typeof turf === 'undefined') return;

  // pré-computa o GeoJSON e a bounding box de cada polígono uma única vez,
  // em vez de chamar toGeoJSON() repetidamente dentro do loop de pares (era O(n²) chamadas)
  const polyEntries = [];
  featuresData.forEach(entry=>{
    if(!entry.layer.toGeoJSON) return;
    const gj = entry.layer.toGeoJSON();
    if(gj.geometry.type !== 'Polygon') return;
    entry.hasOverlap = false;
    entry.overlapsWith = [];
    let bbox = null;
    try{ bbox = turf.bbox(gj); }catch(err){ bbox = null; } // [minX, minY, maxX, maxY]
    polyEntries.push({ entry, gj, bbox });
  });

  for(let i=0; i<polyEntries.length; i++){
    const a = polyEntries[i];
    for(let j=i+1; j<polyEntries.length; j++){
      const b = polyEntries[j];

      // só interessa sobreposição DENTRO da mesma camada — polígonos de
      // camadas distintas podem legitimamente coincidir no espaço (ex.: um
      // limite de município e uma camada de uso do solo) e isso não é um
      // erro de topologia a assinalar ao utilizador
      if(a.entry.layerId !== b.entry.layerId) continue;

      // rejeição rápida e barata: se as bounding boxes nem sequer se sobrepõem,
      // as geometrias reais também não podem sobrepor-se — evita chamar as
      // operações turf.js (muito mais caras) para a maioria dos pares
      if(a.bbox && b.bbox){
        const noOverlap = a.bbox[2] < b.bbox[0] || b.bbox[2] < a.bbox[0] ||
                           a.bbox[3] < b.bbox[1] || b.bbox[3] < a.bbox[1];
        if(noOverlap) continue;
      }

      let overlaps = false;
      try{
        overlaps = turf.booleanOverlap(a.gj, b.gj) ||
                   turf.booleanContains(a.gj, b.gj) ||
                   turf.booleanContains(b.gj, a.gj);
      }catch(err){
        overlaps = false; // geometria inválida/auto-interseção — ignora em vez de rebentar
      }
      if(overlaps){
        a.entry.hasOverlap = true; a.entry.overlapsWith.push(b.entry.label);
        b.entry.hasOverlap = true; b.entry.overlapsWith.push(a.entry.label);
      }
    }
  }

  polyEntries.forEach(({entry})=>{
    applyTopologyVisual(entry);
    refreshStatsIfOpen(entry);
  });

  refreshFeatList();
  updateTopologyWarnButton();
}

function getWarnColor(){
  const v = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
  return v || '#B5472B';
}

/* ---------- avisos de sobreposição: ligar/desligar (botão no header) ----------
   Só afeta a APRESENTAÇÃO (tracejado nas arestas, badge na tabela, aviso no
   popup) — a deteção em si (entry.hasOverlap/overlapsWith) continua sempre
   ativa, para o botão saber quando aparecer/desaparecer. A preferência fica
   guardada no localStorage, por isso mantém-se entre sessões. */
let topologyWarningsEnabled = localStorage.getItem('dgpt_topology_warnings_off') !== '1';

function toggleTopologyWarnings(){
  topologyWarningsEnabled = !topologyWarningsEnabled;
  try{ localStorage.setItem('dgpt_topology_warnings_off', topologyWarningsEnabled ? '0' : '1'); }
  catch(err){ /* localStorage indisponível, ignora */ }

  featuresData.forEach(entry=>{ if(entry.hasOverlap) applyTopologyVisual(entry); });
  refreshFeatList();
  updateTopologyWarnButton();
}

function updateTopologyWarnButton(){
  const btn = document.getElementById('btn-topology-warn-toggle');
  if(!btn) return;
  let hasAnyOverlap = false;
  featuresData.forEach(e => { if(e.hasOverlap) hasAnyOverlap = true; });
  btn.classList.toggle('hidden', !hasAnyOverlap);
  btn.classList.toggle('has-overlap-warn', hasAnyOverlap && topologyWarningsEnabled);
  btn.classList.toggle('is-active', hasAnyOverlap && !topologyWarningsEnabled);
  btn.setAttribute('aria-pressed', String(!topologyWarningsEnabled));
  btn.title = topologyWarningsEnabled
    ? 'Sobreposições detetadas — clicar para desligar os avisos'
    : 'Avisos de sobreposição desligados — clicar para voltar a ligar';
}

document.getElementById('btn-topology-warn-toggle')?.addEventListener('click', toggleTopologyWarnings);

function applyTopologyVisual(entry){
  if(!entry.layer.setStyle) return;
  if(entry.hasOverlap && topologyWarningsEnabled){
    entry.layer.setStyle({color: getWarnColor(), weight:4, dashArray:'8 5', fillOpacity:.25});
  } else {
    // repõe o estilo normal (categórico, se aplicável, senão a cor por defeito)
    const schema = getLayerSchema(entry.layerId);
    styleLayerByClass(entry);
    if(!schema || schema.mode !== 'atributos'){ styleLayerDefault(entry.layer, entry.layerId); }
  }
}

function dataGisMarkerIcon(color){
  color = color || DEFAULT_COLOR;
  return L.divIcon({
    className:'datagis-point-marker',
    html:`<span style="
      display:block; width:18px; height:18px; border-radius:50%;
      background:${color}; border:3px solid var(--paper-elevated, #fff);
      box-shadow:0 1px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.12);
    "></span>`,
    iconSize:[18,18], iconAnchor:[9,9]
  });
}

/* ============================================================
   SIMBOLOGIA — estatísticas e classificação
   ============================================================ */

/* todas as entradas (geometrias) já desenhadas que pertencem a uma camada */
function getLayerFeatureEntries(layerId){
  const out = [];
  featuresData.forEach(entry=>{ if(entry.layerId === layerId) out.push(entry); });
  return out;
}

/* valores brutos (não vazios) de um atributo, para todas as geometrias da camada */
function getAttributeRawValues(layerId, attrName){
  return getLayerFeatureEntries(layerId)
    .map(e => e.props ? e.props[attrName] : undefined)
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '');
}

/* lista de valores distintos (como texto), ordenada alfabética/numericamente */
function getUniqueValuesForAttr(layerId, attrName){
  const seen = new Set();
  const out = [];
  getAttributeRawValues(layerId, attrName).forEach(v=>{
    const key = String(v);
    if(!seen.has(key)){ seen.add(key); out.push(key); }
  });
  out.sort((a,b)=> a.localeCompare(b, 'pt', {numeric:true, sensitivity:'base'}));
  return out;
}

/* valores numéricos válidos de um atributo, ordenados a crescer */
function getNumericValuesForAttr(layerId, attrName){
  return getAttributeRawValues(layerId, attrName)
    .map(v=>parseFloat(v))
    .filter(n=>Number.isFinite(n))
    .sort((a,b)=>a-b);
}

/* intervalos iguais: divide [min,max] em N fatias do mesmo tamanho */
function classifyEqualInterval(values, classCount){
  const min = values[0], max = values[values.length-1];
  const breaks = [];
  if(min === max){ breaks.push({min, max}); return breaks; }
  const step = (max - min) / classCount;
  for(let i=0;i<classCount;i++){
    const lo = min + step*i;
    const hi = (i === classCount-1) ? max : min + step*(i+1);
    breaks.push({min: lo, max: hi});
  }
  return breaks;
}

/* quantis: cada classe fica com (aproximadamente) o mesmo nº de geometrias */
function classifyQuantile(values, classCount){
  const n = values.length;
  const breaks = [];
  for(let i=0;i<classCount;i++){
    const loIdx = Math.floor(i * n / classCount);
    const hiIdx = (i === classCount-1) ? (n-1) : Math.max(loIdx, Math.floor((i+1) * n / classCount) - 1);
    breaks.push({min: values[loIdx], max: values[hiIdx]});
  }
  // garante que não há sobreposições/lacunas por causa dos arredondamentos
  for(let i=1;i<breaks.length;i++){
    if(breaks[i].min < breaks[i-1].max) breaks[i].min = breaks[i-1].max;
  }
  breaks[breaks.length-1].max = values[n-1];
  return breaks;
}

/* natural breaks (Jenks) — minimiza a variância dentro de cada classe */
function classifyJenks(values, classCount){
  const data = values.slice();
  const n = data.length;
  if(n <= classCount){
    // poucos valores distintos: um valor por classe (evita o algoritmo com matriz maior que os dados)
    return classifyEqualInterval(data, classCount);
  }
  const mat1 = [];
  const mat2 = [];
  for(let i=0;i<=n;i++){
    mat1.push(new Array(classCount+1).fill(0));
    mat2.push(new Array(classCount+1).fill(0));
  }
  for(let i=1;i<=classCount;i++){
    mat1[1][i] = 1;
    mat2[1][i] = 0;
    for(let j=2;j<=n;j++) mat2[j][i] = Infinity;
  }
  let v = 0;
  for(let l=2;l<=n;l++){
    let s1=0, s2=0, w=0;
    for(let m=1;m<=l;m++){
      const i3 = l - m + 1;
      const val = data[i3-1];
      s2 += val*val; s1 += val; w++;
      v = s2 - (s1*s1)/w;
      const i4 = i3 - 1;
      if(i4 !== 0){
        for(let j=2;j<=classCount;j++){
          if(mat2[l][j] >= (v + mat2[i4][j-1])){
            mat1[l][j] = i3;
            mat2[l][j] = v + mat2[i4][j-1];
          }
        }
      }
    }
    mat1[l][1] = 1;
    mat2[l][1] = v;
  }
  let k = n;
  const kclass = new Array(classCount+1);
  kclass[classCount] = data[n-1];
  kclass[0] = data[0];
  let countNum = classCount;
  while(countNum >= 2){
    const id = mat1[k][countNum] - 2;
    kclass[countNum-1] = data[id];
    k = mat1[k][countNum] - 1;
    countNum--;
  }
  const breaks = [];
  for(let i=0;i<classCount;i++){
    breaks.push({min: kclass[i], max: kclass[i+1]});
  }
  return breaks;
}

/* calcula as classes graduadas para uma camada/atributo segundo o método escolhido */
function computeGraduatedBreaks(layerId, attrName, method, classCount){
  const values = getNumericValuesForAttr(layerId, attrName);
  if(values.length === 0) return [];
  const n = Math.max(1, Math.min(classCount || 5, values.length));
  let ranges;
  if(method === 'quantis') ranges = classifyQuantile(values, n);
  else if(method === 'jenks') ranges = classifyJenks(values, n);
  else ranges = classifyEqualInterval(values, n); // 'iguais' e 'manual' partem daqui como ponto de partida
  return ranges.map((r, i)=>({min:r.min, max:r.max, color: paletteColor(i)}));
}

function styleLayerDefault(layer, layerId){
  const schema = layerId != null ? getLayerSchema(layerId) : null;
  const color = (schema && schema.baseColor) || DEFAULT_COLOR;
  const fillOpacity = ((schema && schema.opacity != null) ? schema.opacity : DEFAULT_OPACITY) / 100;
  if(layer.setIcon){
    // marker: usa o marcador circular DataGis em vez do pin azul padrão
    layer.setIcon(dataGisMarkerIcon(color));
  } else if(layer.setStyle){
    layer.setStyle({color, weight:3, fillColor: color, fillOpacity});
  }
}

/* devolve a cor de uma geometria segundo a simbologia atual da sua camada.
   Ordem de decisão:
   1) symbology.mode === 'unicos'   -> cor associada ao valor do atributo escolhido
   2) symbology.mode === 'graduado' -> cor da classe numérica em que o valor cai
   3) fallback legado: atributo categórico antigo (colorAttr + attr.classes)
   4) cor única da camada (baseColor) */
function resolveFeatureColor(schema, props){
  const sym = schema.symbology;
  if(sym && sym.mode === 'unicos' && sym.attr){
    const raw = props ? props[sym.attr] : undefined;
    const key = (raw === undefined || raw === null) ? '' : String(raw);
    const match = sym.uniqueValues.find(u=>String(u.value) === key);
    if(match) return match.color;
    return schema.baseColor || DEFAULT_COLOR;
  }
  if(sym && sym.mode === 'graduado' && sym.attr){
    const num = parseFloat(props ? props[sym.attr] : undefined);
    if(Number.isFinite(num)){
      const cls = sym.breaks.find(b=>num >= b.min && num <= b.max)
        || (sym.breaks.length ? sym.breaks[sym.breaks.length-1] : null);
      if(cls) return cls.color;
    }
    return schema.baseColor || DEFAULT_COLOR;
  }
  // legado: atributo categórico único (classes definidas no wizard de atributos)
  if(schema.mode === 'atributos' && Array.isArray(schema.attributes)){
    const catAttr = schema.attributes.find(a=>a.type==='categorico' && a.name === schema.colorAttr)
      || schema.attributes.find(a=>a.type==='categorico');
    if(catAttr){
      const val = props ? props[catAttr.name] : undefined;
      const cls = (catAttr.classes || []).find(c=>c.name === val);
      return cls ? cls.color : (schema.baseColor || DEFAULT_COLOR);
    }
  }
  return schema.baseColor || DEFAULT_COLOR;
}

/* aplica a simbologia (qualquer modo) a uma única geometria já desenhada */
function styleLayerByClass(entry){
  const schema = getLayerSchema(entry.layerId);
  if(!schema) return;
  const hasActiveSymbology = schema.symbology && (schema.symbology.mode === 'unicos' || schema.symbology.mode === 'graduado');
  if(!hasActiveSymbology && schema.mode !== 'atributos'){ styleLayerDefault(entry.layer, entry.layerId); return; }
  const color = resolveFeatureColor(schema, entry.props);
  const fillOpacity = ((schema && schema.opacity != null) ? schema.opacity : DEFAULT_OPACITY) / 100;
  if(entry.layer.setIcon){
    entry.layer.setIcon(dataGisMarkerIcon(color));
  } else if(entry.layer.setStyle){
    entry.layer.setStyle({color, fillColor:color, fillOpacity, weight:3});
  }
}

/* reaplica a simbologia atual a todas as geometrias de uma camada (usado ao mudar de modo/atributo/método) */
function restyleLayerId(layerId){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  getLayerFeatureEntries(layerId).forEach(entry=>{
    const sym = schema.symbology;
    if(sym && (sym.mode === 'unicos' || sym.mode === 'graduado')){
      styleLayerByClass(entry);
    } else if(schema.mode === 'atributos'){
      styleLayerByClass(entry);
    } else {
      styleLayerDefault(entry.layer, layerId);
    }
    if(entry.hasOverlap) applyTopologyVisual(entry);
  });
}

let formEntryRef = null;
let attrTableLayerId = null; // qual camada a tabela de atributos está a mostrar de momento
let formIsNewFeature = false;
const GEOM_TYPE_LABELS = {Point:'Ponto', LineString:'Linha', Polygon:'Polígono'};

function openAttrForm(entry, isNew){
  formEntryRef = entry;
  formIsNewFeature = !!isNew;

  const schema = getLayerSchema(entry.layerId) || {name:null, mode:null, attributes:[]};
  document.getElementById('feat-form-title').textContent = formIsNewFeature ? 'Nova geometria' : 'Editar geometria';
  const typeLabel = GEOM_TYPE_LABELS[entry.geomType] || '—';
  document.getElementById('feat-form-type-line').textContent = 'Tipo: ' + typeLabel;

  const nameInput = document.getElementById('feat-form-name');
  nameInput.value = formIsNewFeature ? '' : (entry.label || '');
  document.getElementById('feat-form-name-error').style.display = 'none';

  const fieldsWrap = document.getElementById('feat-form-fields');
  fieldsWrap.innerHTML = '';
  (schema.attributes || []).forEach(attr=>{
    const wrap = document.createElement('div');
    if(attr.type === 'categorico'){
      const opts = (attr.classes || []).map(c=>`<option value="${c.name}">${c.name}</option>`).join('');
      wrap.innerHTML = `<label>${attr.name}</label><select data-field="${attr.name}"><option value="">—</option>${opts}</select>`;
      if(!formIsNewFeature) wrap.querySelector('select').value = entry.props[attr.name] || '';
    } else {
      wrap.innerHTML = `<label>${attr.name}</label><input type="${attr.type==='numero'?'number':'text'}" data-field="${attr.name}">`;
      if(!formIsNewFeature) wrap.querySelector('input').value = entry.props[attr.name] || '';
    }
    fieldsWrap.appendChild(wrap);
  });
  document.getElementById('attr-form-overlay').classList.remove('hidden');
  nameInput.focus();
}

document.getElementById('feat-form-cancel').addEventListener('click', ()=>{
  document.getElementById('attr-form-overlay').classList.add('hidden');
  refreshFeatList();
});

document.getElementById('feat-form-save').addEventListener('click', ()=>{
  const name = document.getElementById('feat-form-name').value.trim();
  // nome é opcional: se não preenchido, mantém-se o nome genérico já atribuído (Geometria N)
  if(name) formEntryRef.label = name;

  const fieldsWrap = document.getElementById('feat-form-fields');
  fieldsWrap.querySelectorAll('[data-field]').forEach(inp=>{
    formEntryRef.props[inp.dataset.field] = inp.value;
  });
  formEntryRef.updatedAt = Date.now();
  markProjectDirty();
  styleLayerByClass(formEntryRef);
  if(formEntryRef.hasOverlap) applyTopologyVisual(formEntryRef);
  document.getElementById('attr-form-overlay').classList.add('hidden');
  refreshFeatList();
});

/* ============================================================
   LISTA DE GEOMETRIAS (sidebar)
   ============================================================ */
function refreshFeatList(){
  updateFeatSummary();
}

function updateFeatSummary(){
  const emptyMsg = document.getElementById('empty-msg');
  const shapePanel = document.getElementById('shape-panel');

  if(!config.geometryType && layers.length === 0){
    emptyMsg.style.display = '';
    shapePanel.classList.add('hidden');
  } else {
    emptyMsg.style.display = 'none';
    shapePanel.classList.remove('hidden');
    renderLayersPanel();
  }

  const tableOverlay = document.getElementById('attr-table-overlay');
  if(tableOverlay && !tableOverlay.classList.contains('hidden')){
    renderAttrTable(attrTableLayerId);
  }
}

/* devolve o "esquema" (nome, tipo de geometria, modo, atributos) de uma camada,
   quer seja a camada ativa (vive em "config") quer seja uma já arquivada em "layers" */
function getLayerSchema(layerId){
  if(layerId === activeLayerId){
    if(!config.symbology) config.symbology = defaultSymbology();
    return {name: config.shapeName, geometryType: config.geometryType, mode: config.mode, attributes: config.attributes, colorAttr: config.colorAttr, baseColor: config.baseColor, opacity: config.opacity, symbology: config.symbology};
  }
  const rec = layers.find(l=>l.id === layerId) || null;
  // defensivo: camadas arquivadas antes de existir "symbology" (projetos antigos) podem não a ter
  if(rec && !rec.symbology) rec.symbology = defaultSymbology();
  return rec;
}

function countLayerFeatures(layerId){
  let n = 0;
  featuresData.forEach(entry=>{ if(entry.layerId === layerId) n++; });
  return n;
}

/* ---------- empilhamento (z-order) das camadas no mapa ----------
   Cada camada tem o seu próprio "pane" do Leaflet (uma camada de DOM dedicada);
   mudar a ordem no painel é só reatribuir o z-index de cada pane — não é preciso
   tocar em cada geometria individualmente. Funciona da mesma forma para pontos
   (marcadores), linhas e polígonos, porque todos passam a viver no pane da sua
   própria camada em vez dos panes genéricos do Leaflet. */
function ensureLayerPane(id){
  const name = 'camada-pane-' + id;
  if(!layerPanes.has(id)){
    const pane = map.createPane(name);
    pane.style.pointerEvents = 'auto'; // panes criados à mão não herdam isto por defeito
    layerPanes.set(id, name);
    if(!layerOrder.includes(id)) layerOrder.unshift(id); // nova camada entra no topo
    applyLayerZOrder();
  }
  return layerPanes.get(id);
}

/* garante que uma geometria já criada (que o Geoman coloca sempre nos panes
   genéricos por defeito) passa a viver no pane da sua camada. */
function assignLayerPane(layer, layerId){
  const paneName = ensureLayerPane(layerId);
  if(layer.options.pane === paneName) return;

  if(layerVisible.get(layerId) === undefined){
    layerVisible.set(layerId, true);
  }
  if(!layerOrder.includes(layerId)) layerOrder.unshift(layerId);

  layer.options.pane = paneName;

  if(drawnGroup && typeof drawnGroup.hasLayer === 'function' && drawnGroup.hasLayer(layer)){
    drawnGroup.removeLayer(layer);
    drawnGroup.addLayer(layer);
    return;
  }

  const wasOnMap = !!layer._map;
  if(wasOnMap){
    try{ map.removeLayer(layer); }catch(err){ /* ignora */ }
    try{ map.addLayer(layer); }catch(err){ /* ignora */ }
  }
}

/* aplica a ordem atual de "layerOrder" ao mapa, ajustando o z-index de cada
   pane (índice 0 em layerOrder = topo do painel = mais à frente no mapa). */
function applyLayerZOrder(){
  if(!map) return;
  const total = layerOrder.length;
  layerOrder.forEach((id, idx)=>{
    const paneName = layerPanes.get(id);
    if(!paneName) return;
    const pane = map.getPane(paneName);
    if(pane) pane.style.zIndex = 450 + (total - idx);
  });
}

let draggedLayerRowId = null;

/* painel: uma linha por camada (arquivadas + a ativa, se já tiver tipo de geometria definido),
   cada uma com interruptor de visibilidade, menu de contexto (botão direito) e arrastar
   para reordenar — a ordem das linhas no painel passa a definir qual camada fica por
   cima/por baixo das outras no mapa. */
/* cores (e etiquetas) a mostrar na mini-legenda por baixo da camada ativa no painel */
function layerSwatchColors(schema){
  const sym = schema.symbology;
  if(sym && sym.mode === 'unicos' && sym.uniqueValues.length){
    return sym.uniqueValues.map(u=>({color:u.color, label:u.value}));
  }
  if(sym && sym.mode === 'graduado' && sym.breaks.length){
    return sym.breaks.map(b=>({color:b.color, label: fmtBreakNumber(b.min) + ' – ' + fmtBreakNumber(b.max)}));
  }
  // legado: atributo categórico único definido no wizard de atributos
  if(schema.mode === 'atributos' && Array.isArray(schema.attributes)){
    const catAttr = schema.attributes.find(a=>a.type==='categorico' && a.name === schema.colorAttr)
      || schema.attributes.find(a=>a.type==='categorico');
    if(catAttr && catAttr.classes && catAttr.classes.length){
      return catAttr.classes.map(c=>({color:c.color, label:c.name}));
    }
  }
  return [{color: schema.baseColor || DEFAULT_COLOR, label: null}];
}

function renderLayersPanel(){
  const list = document.getElementById('layers-list');
  const allIds = layers.map(l=>l.id).concat(config.geometryType ? [activeLayerId] : []);

  // mantém a ordem já definida pelo utilizador (layerOrder) e acrescenta, no topo,
  // quaisquer camadas novas que ainda não lá estejam.
  allIds.forEach(id=>{ if(!layerOrder.includes(id)) layerOrder.unshift(id); });
  layerOrder = layerOrder.filter(id=>allIds.includes(id));

  list.innerHTML = layerOrder.map(id=>{
    const schema = getLayerSchema(id);
    if(!schema) return '';
    const typeLabel = GEOM_TYPE_LABELS[schema.geometryType] || '—';
    const visible = layerVisible.get(id) !== false;
    const isActive = id === activeLayerId;
    const count = countLayerFeatures(id);
    const rowHTML = `
      <li class="layer-row ${isActive ? 'is-active' : ''} ${visible ? '' : 'is-hidden-layer'}" data-layer-id="${id}" draggable="true" title="Arrasta para reordenar · clica para tornar ativa (editável) · botão direito para mais opções">
        <span class="layer-drag-handle" title="Arrastar para reordenar">⠿</span>
        <button type="button" class="layer-eye-btn" data-eye title="${visible ? 'Ocultar camada' : 'Mostrar camada'}">${visible ? '👁' : '🙈'}</button>
        <span class="layer-name">${escapeHtml(schema.name || 'Shape sem nome')} <span style="color:var(--stone); font-weight:400;">(${count})</span></span>
        <span class="shape-geom-badge">${typeLabel}</span>
        ${isActive ? '<span class="layer-active-tag">ativa</span>' : ''}
      </li>`;
    if(!isActive) return rowHTML;
    // camada ativa: mostra por baixo uma mini-legenda com as cores atuais; clicar nela abre a Simbologia
    const allSwatches = layerSwatchColors(schema);
    const hasLabels = allSwatches.some(s => s.label != null);
    const LEGEND_LIMIT = 25;
    const swatches = allSwatches.slice(0, LEGEND_LIMIT);
    const extraCount = allSwatches.length - swatches.length;

    const legendInnerHTML = hasLabels
      ? `
        <ul class="layer-legend-list" style="list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:3px; width:100%;">
          ${swatches.map(s=>`
            <li class="layer-legend-item" style="display:flex; align-items:center; gap:6px; font-size:11.5px; line-height:1.3; color:var(--stone, #8a8478);">
              <span class="layer-legend-swatch" style="background:${escapeHtml(s.color)}; width:11px; height:11px; min-width:11px; border-radius:3px; display:inline-block;"></span>
              <span class="layer-legend-label" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s.label!=null ? escapeHtml(String(s.label)) : '—'}</span>
            </li>`).join('')}
          ${extraCount > 0 ? `<li class="layer-legend-item layer-legend-more" style="font-size:11px; color:var(--stone, #8a8478); padding-left:17px;">+ ${extraCount} classe(s)</li>` : ''}
        </ul>`
      : swatches.map(s=>`<span class="layer-legend-swatch" style="background:${escapeHtml(s.color)}"></span>`).join('');

    const legendHTML = `
      <li class="layer-legend-row" data-legend-for="${id}" title="Clica para abrir a Simbologia">
        ${legendInnerHTML}
      </li>`;
    return rowHTML + legendHTML;
  }).join('') || '';

  list.querySelectorAll('.layer-legend-row').forEach(row=>{
    row.addEventListener('click', (e)=>{
      e.stopPropagation();
      symbologyLayerId = Number(row.dataset.legendFor);
      renderSymbologyPanel();
    });
  });

  list.querySelectorAll('.layer-row').forEach(row=>{
    const id = Number(row.dataset.layerId);
    const isActive = id === activeLayerId;
    row.querySelector('[data-eye]').addEventListener('click', (e)=>{
      e.stopPropagation();
      toggleLayerVisibility(id);
    });
    row.addEventListener('click', ()=>{
      switchActiveLayer(id);
    });
    row.addEventListener('contextmenu', (e)=>{
      e.preventDefault();
      openLayerContextMenu(e.clientX, e.clientY, id);
    });

    row.addEventListener('dragstart', (e)=>{
      draggedLayerRowId = id;
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try{ e.dataTransfer.setData('text/plain', String(id)); }catch(err){ /* alguns browsers exigem isto mesmo sem uso */ }
    });
    row.addEventListener('dragend', ()=>{
      draggedLayerRowId = null;
      list.querySelectorAll('.layer-row').forEach(r=>r.classList.remove('is-dragging','drag-over-top','drag-over-bottom'));
    });
    row.addEventListener('dragover', (e)=>{
      if(draggedLayerRowId === null || draggedLayerRowId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drag-over-top', before);
      row.classList.toggle('drag-over-bottom', !before);
    });
    row.addEventListener('dragleave', ()=>{
      row.classList.remove('drag-over-top','drag-over-bottom');
    });
    row.addEventListener('drop', (e)=>{
      e.preventDefault();
      const targetId = id;
      row.classList.remove('drag-over-top','drag-over-bottom');
      if(draggedLayerRowId === null || draggedLayerRowId === targetId) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      reorderLayer(draggedLayerRowId, targetId, before);
    });
  });

  renderSymbologyPanel();
}

/* move a camada "draggedId" para junto de "targetId" na lista (antes ou depois),
   atualiza o painel e reflete de imediato a nova ordem no mapa. */
function reorderLayer(draggedId, targetId, insertBefore){
  const from = layerOrder.indexOf(draggedId);
  if(from === -1) return;
  layerOrder.splice(from, 1);
  let to = layerOrder.indexOf(targetId);
  if(to === -1){ layerOrder.push(draggedId); }
  else{
    if(!insertBefore) to += 1;
    layerOrder.splice(to, 0, draggedId);
  }
  applyLayerZOrder();
  renderLayersPanel();
  markProjectDirty();
}

/* torna a camada clicada a única editável: podes criar geometrias novas nela e
   editar/mover/apagar as que já lá estão. As restantes ficam bloqueadas no mapa
   (não reagem ao modo de edição/arrastar/remoção do Geoman) até a selecionares. */
function switchActiveLayer(id){
  if(id !== activeLayerId){
    const rec = layers.find(l=>l.id === id);
    if(!rec) return; // segurança: camada desconhecida

    // arquiva a camada ativa atual antes de trocar (se já estiver configurada)
    if(config.geometryType){
      layers.push({
        id: activeLayerId,
        name: config.shapeName,
        geometryType: config.geometryType,
        mode: config.mode,
        attributes: config.attributes,
        colorAttr: config.colorAttr,
        baseColor: config.baseColor,
        opacity: config.opacity,
        symbology: cloneSymbology(config.symbology)
      });
    }

    // promove a camada escolhida a ativa
    layers.splice(layers.indexOf(rec), 1);
    activeLayerId = rec.id;
    config.shapeName = rec.name;
    config.mode = rec.mode;
    config.attributes = rec.attributes;
    config.geometryType = rec.geometryType;
    config.colorAttr = rec.colorAttr;
    config.baseColor = rec.baseColor;
    config.opacity = rec.opacity != null ? rec.opacity : null;
    config.symbology = cloneSymbology(rec.symbology);

    applyGeometryConfig();
    renderLayersPanel();
  }
  refreshLayerEditability();
}

/* bloqueia no Geoman (pmIgnore) todas as geometrias que não pertençam à camada
   ativa, para que criar/editar/apagar só funcione na camada selecionada. */
function refreshLayerEditability(){
  featuresData.forEach(entry=>{
    if(entry.layer.options) entry.layer.options.pmIgnore = (entry.layerId !== activeLayerId);
  });
  if(!map || !map.pm) return;
  // força o Geoman a reavaliar quais as geometrias elegíveis para cada modo,
  // respeitando o pmIgnore que acabámos de definir
  if(map.pm.globalEditModeEnabled()){ map.pm.disableGlobalEditMode(); map.pm.enableGlobalEditMode(); }
  if(map.pm.globalDragModeEnabled()){ map.pm.disableGlobalDragMode(); map.pm.enableGlobalDragMode(); }
  if(map.pm.globalRemovalModeEnabled()){ map.pm.disableGlobalRemovalMode(); map.pm.enableGlobalRemovalMode(); }
}

function toggleLayerVisibility(layerId){
  const nextVisible = !(layerVisible.get(layerId) !== false);
  layerVisible.set(layerId, nextVisible);
  featuresData.forEach(entry=>{
    if(entry.layerId !== layerId) return;
    if(nextVisible){
      drawnGroup.addLayer(entry.layer);
      if(entry.showMeasures) renderPolygonMeasures(entry);
    } else {
      drawnGroup.removeLayer(entry.layer);
      clearPolygonMeasures(entry);
    }
  });
  renderLayersPanel();
}

function removeLayerEntirely(layerId){
  const schema = getLayerSchema(layerId);
  const label = schema ? (schema.name || 'Shape sem nome') : 'esta camada';
  if(!requestConfirmation(`Remover a camada "${label}" e todas as suas geometrias? Esta ação não pode ser desfeita.`)) return;

  featuresData.forEach((entry, key)=>{
    if(entry.layerId !== layerId) return;
    if(entry.fid){ teamState.deletedFids.set(entry.fid, Date.now()); }
    clearPolygonMeasures(entry);
    drawnGroup.removeLayer(entry.layer);
    featuresData.delete(key);
  });

  const idx = layers.findIndex(l=>l.id === layerId);
  if(idx !== -1) layers.splice(idx, 1);

  const remainingLayerIds = layers.map(l=>l.id);
  const fallbackId = remainingLayerIds.length ? remainingLayerIds[remainingLayerIds.length - 1] : null;

  if(layerId === activeLayerId){
    if(fallbackId != null){
      const fallback = layers.find(l=>l.id === fallbackId);
      activeLayerId = fallbackId;
      config.shapeName = fallback ? fallback.name : null;
      config.mode = fallback ? fallback.mode : null;
      config.attributes = fallback ? (fallback.attributes || []) : [];
      config.geometryType = fallback ? fallback.geometryType : null;
      config.colorAttr = fallback ? fallback.colorAttr : null;
      config.baseColor = fallback ? fallback.baseColor : null;
      config.opacity = fallback && fallback.opacity != null ? fallback.opacity : null;
      config.symbology = cloneSymbology(fallback && fallback.symbology);
    } else {
      config.shapeName = null;
      config.mode = null;
      config.attributes = [];
      config.geometryType = null;
      config.colorAttr = null;
      config.baseColor = null;
      config.opacity = null;
      config.symbology = defaultSymbology();
    }
  }
  layerVisible.delete(layerId);
  layerOrder = layerOrder.filter(id=>id !== layerId);
  const paneName = layerPanes.get(layerId);
  if(paneName && map.getPane(paneName)) map.getPane(paneName).remove();
  layerPanes.delete(layerId);

  if(fallbackId != null && !layerVisible.has(fallbackId)){
    layerVisible.set(fallbackId, true);
  }

  markProjectDirty();
  refreshFeatList();
  checkAllTopology();
  refreshLayerEditability();
}

/* ---------- menu de contexto (botão direito) numa linha de camada ---------- */
let ctxMenuLayerId = null;
function openLayerContextMenu(x, y, layerId){
  ctxMenuLayerId = layerId;
  const menu = document.getElementById('layer-context-menu');
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - 8;
  const maxTop = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxLeft) + 'px';
  menu.style.top = Math.min(y, maxTop) + 'px';
}
function closeLayerContextMenu(){
  ctxMenuLayerId = null;
  document.getElementById('layer-context-menu').classList.add('hidden');
}
document.addEventListener('click', closeLayerContextMenu);
document.addEventListener('contextmenu', (e)=>{
  if(!e.target.closest('.layer-row')) closeLayerContextMenu();
});

/* ---------- menu de contexto (botão direito) numa geometria desenhada no mapa ---------- */
let ctxMenuFeatureEntry = null;
function bindFeatureContextMenu(entry){
  entry.layer.on('contextmenu', (e)=>{
    L.DomEvent.stop(e.originalEvent); // impede o menu nativo do browser e a propagação para o mapa/documento
    openFeatureContextMenu(e.originalEvent.clientX, e.originalEvent.clientY, entry);
  });
}
function openFeatureContextMenu(x, y, entry){
  closeLayerContextMenu();
  ctxMenuFeatureEntry = entry;
  const menu = document.getElementById('feature-context-menu');
  const measuresBtn = document.getElementById('feature-ctx-measures');
  // por agora só as geometrias de polígono têm a opção de medidas dos lados
  measuresBtn.style.display = entry.geomType === 'Polygon' ? 'flex' : 'none';
  measuresBtn.classList.toggle('is-active', !!entry.showMeasures);
  menu.classList.remove('hidden');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - 8;
  const maxTop = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxLeft) + 'px';
  menu.style.top = Math.min(y, maxTop) + 'px';
}
function closeFeatureContextMenu(){
  ctxMenuFeatureEntry = null;
  document.getElementById('feature-context-menu').classList.add('hidden');
}
document.addEventListener('click', closeFeatureContextMenu);
document.addEventListener('contextmenu', (e)=>{
  if(!e.target.closest('#feature-context-menu')) closeFeatureContextMenu();
});
document.getElementById('feature-ctx-measures').addEventListener('click', (e)=>{
  e.stopPropagation();
  if(!ctxMenuFeatureEntry) return;
  togglePolygonMeasures(ctxMenuFeatureEntry);
  closeFeatureContextMenu();
});

/* separa umas L.LatLng[] potencialmente aninhadas (Polygon com buracos, ou MultiPolygon)
   em várias listas simples de vértices — um "anel" por lista */
function flattenPolygonRings(latlngs){
  if(!Array.isArray(latlngs) || latlngs.length === 0) return [];
  if(latlngs[0] instanceof L.LatLng) return [latlngs];
  let rings = [];
  latlngs.forEach(item=>{
    if(Array.isArray(item) && item.length && item[0] instanceof L.LatLng) rings.push(item);
    else if(Array.isArray(item)) rings = rings.concat(flattenPolygonRings(item));
  });
  return rings;
}

/* desenha, tipo esquiço de engenharia, o comprimento (em metros) de cada lado do polígono */
function renderPolygonMeasures(entry){
  clearPolygonMeasures(entry);
  if(!entry.showMeasures) return;
  const rings = flattenPolygonRings(entry.layer.getLatLngs());
  entry.measureTooltips = [];
  rings.forEach(ring=>{
    for(let i=0; i<ring.length; i++){
      const a = ring[i], b = ring[(i+1) % ring.length];
      if(a.equals(b)) continue;
      const distM = a.distanceTo(b);
      if(distM < 0.05) continue; // ignora lados degenerados (vértices sobrepostos)
      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      const label = distM < 1000 ? Math.round(distM) + ' m' : (distM / 1000).toFixed(2) + ' km';
      const tooltip = L.tooltip({
        permanent: true, direction: 'center', className: 'edge-measure-tooltip', interactive: false
      }).setLatLng(mid).setContent(label);
      measuresGroup.addLayer(tooltip);
      entry.measureTooltips.push(tooltip);
    }
  });
}
function clearPolygonMeasures(entry){
  if(entry.measureTooltips && entry.measureTooltips.length){
    entry.measureTooltips.forEach(t=> measuresGroup.removeLayer(t));
  }
  entry.measureTooltips = [];
}
function togglePolygonMeasures(entry){
  entry.showMeasures = !entry.showMeasures;
  renderPolygonMeasures(entry);
}

/* dá zoom/enquadra o mapa em todas as geometrias de uma camada */
function zoomToLayer(layerId){
  const group = L.featureGroup();
  featuresData.forEach(entry=>{
    if(entry.layerId === layerId) group.addLayer(entry.layer);
  });
  if(group.getLayers().length === 0){
    alert('Esta camada ainda não tem geometrias para dar zoom.');
    return;
  }
  try{ map.fitBounds(group.getBounds(), {padding:[40,40], maxZoom:18}); }
  catch(err){ /* bounds inválidos, ignora em segurança */ }
}

document.getElementById('layer-ctx-zoom').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  zoomToLayer(ctxMenuLayerId);
});
document.getElementById('layer-ctx-open-table').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  attrTableLayerId = ctxMenuLayerId;
  renderAttrTable(attrTableLayerId);
  document.getElementById('attr-table-overlay').classList.remove('hidden');
});
document.getElementById('layer-ctx-remove').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  removeLayerEntirely(ctxMenuLayerId);
});
document.getElementById('layer-ctx-symbology').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  symbologyLayerId = ctxMenuLayerId;
  renderSymbologyPanel();
});
document.getElementById('layer-ctx-export').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  openExportMenu('layer_' + ctxMenuLayerId);
});
document.getElementById('symbology-close-btn').addEventListener('click', ()=>{
  symbologyLayerId = null;
  renderSymbologyPanel();
});

/* define/atualiza a cor de uma camada específica (não necessariamente a ativa) */
function setLayerColorAttr(layerId, attrName){
  if(layerId === activeLayerId){
    config.colorAttr = attrName;
  } else {
    const rec = layers.find(l=>l.id === layerId);
    if(rec) rec.colorAttr = attrName;
  }
  restyleLayerId(layerId);
}

/* define a cor única de uma camada (usada quando não há simbologia categórica/graduada ativa) */
function setLayerBaseColor(layerId, color){
  if(layerId === activeLayerId){
    config.baseColor = color;
  } else {
    const rec = layers.find(l=>l.id === layerId);
    if(rec) rec.baseColor = color;
  }
  restyleLayerId(layerId);
  markProjectDirty();
}

/* define a transparência (0-100) do preenchimento de uma camada */
function setLayerOpacity(layerId, opacityPct){
  const clamped = Math.max(0, Math.min(100, Number(opacityPct)));
  if(layerId === activeLayerId){
    config.opacity = clamped;
  } else {
    const rec = layers.find(l=>l.id === layerId);
    if(rec) rec.opacity = clamped;
  }
  restyleLayerId(layerId);
  markProjectDirty();
}

/* atualiza a cor de uma classe específica de um atributo categórico (legado, ainda usado
   pelo formulário de atributos quando não há simbologia por valores únicos/graduada ativa) */
function setClassColor(layerId, attrName, className, color){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const attr = schema.attributes.find(a=>a.name === attrName && a.type === 'categorico');
  if(!attr) return;
  const cls = attr.classes.find(c=>c.name === className);
  if(!cls) return;
  cls.color = color;
  restyleLayerId(layerId);
  markProjectDirty();
}

/* ---------- simbologia: modo (cor única / valores únicos / graduado) ---------- */

function ensureSymbology(schema){
  if(!schema.symbology) schema.symbology = defaultSymbology();
  return schema.symbology;
}

function setLayerSymbologyMode(layerId, mode){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const sym = ensureSymbology(schema);
  sym.mode = mode;
  if(mode === 'unicos' && sym.uniqueValues.length === 0){
    generateUniqueValueClasses(layerId, sym.attr);
  }
  if(mode === 'graduado' && sym.breaks.length === 0 && sym.attr){
    generateGraduatedClasses(layerId, sym.attr, sym.method, sym.classCount);
  }
  restyleLayerId(layerId);
  markProjectDirty();
}

/* modo "valores únicos": (re)constrói a lista de valores distintos e as suas cores.
   Se o atributo for categórico e já tiver classes definidas no wizard, reaproveita essas cores. */
function generateUniqueValueClasses(layerId, attrName){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const sym = ensureSymbology(schema);
  sym.attr = attrName;
  if(!attrName){ sym.uniqueValues = []; return; }
  const legacyAttr = (schema.attributes || []).find(a=>a.name === attrName && a.type === 'categorico');
  const legacyColors = new Map((legacyAttr && legacyAttr.classes || []).map(c=>[String(c.name), c.color]));
  const values = getUniqueValuesForAttr(layerId, attrName);
  sym.uniqueValues = values.map((v, i)=>({value: v, color: legacyColors.get(v) || paletteColor(i)}));
}

function setLayerSymbologyUniqueAttr(layerId, attrName){
  generateUniqueValueClasses(layerId, attrName);
  restyleLayerId(layerId);
  markProjectDirty();
}

function setUniqueValueColor(layerId, value, color){
  const schema = getLayerSchema(layerId);
  if(!schema || !schema.symbology) return;
  const item = schema.symbology.uniqueValues.find(u=>u.value === value);
  if(!item) return;
  item.color = color;
  restyleLayerId(layerId);
  markProjectDirty();
}

/* modo "graduado": calcula as classes segundo o método (manual parte de "iguais" e fica editável) */
function generateGraduatedClasses(layerId, attrName, method, classCount){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const sym = ensureSymbology(schema);
  sym.attr = attrName;
  sym.method = method || sym.method;
  sym.classCount = Number.isFinite(classCount) ? classCount : sym.classCount;
  if(!attrName){ sym.breaks = []; return; }
  sym.breaks = computeGraduatedBreaks(layerId, attrName, sym.method, sym.classCount);
}

function setLayerSymbologyGraduatedAttr(layerId, attrName){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const sym = ensureSymbology(schema);
  generateGraduatedClasses(layerId, attrName, sym.method, sym.classCount);
  restyleLayerId(layerId);
  markProjectDirty();
}

function setLayerSymbologyMethod(layerId, method){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const sym = ensureSymbology(schema);
  generateGraduatedClasses(layerId, sym.attr, method, sym.classCount);
  restyleLayerId(layerId);
  markProjectDirty();
}

function setLayerSymbologyClassCount(layerId, classCount){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  const sym = ensureSymbology(schema);
  generateGraduatedClasses(layerId, sym.attr, sym.method, classCount);
  restyleLayerId(layerId);
  markProjectDirty();
}

function setGraduatedBreakColor(layerId, index, color){
  const schema = getLayerSchema(layerId);
  if(!schema || !schema.symbology || !schema.symbology.breaks[index]) return;
  schema.symbology.breaks[index].color = color;
  restyleLayerId(layerId);
  markProjectDirty();
}

/* modo manual: o utilizador ajusta o limite superior de uma classe (o mínimo da seguinte
   acompanha automaticamente, para não deixar lacunas nem sobreposições) */
function setGraduatedBreakBound(layerId, index, value){
  const schema = getLayerSchema(layerId);
  if(!schema || !schema.symbology) return;
  const breaks = schema.symbology.breaks;
  const num = parseFloat(value);
  if(!breaks[index] || !Number.isFinite(num)) return;
  breaks[index].max = num;
  if(breaks[index+1]) breaks[index+1].min = num;
  schema.symbology.method = 'manual';
  restyleLayerId(layerId);
  markProjectDirty();
}

const SYMBOLOGY_METHOD_LABELS = {
  manual: 'Manual',
  quantis: 'Quantis',
  iguais: 'Intervalos iguais',
  jenks: 'Natural breaks (Jenks)'
};

function fmtBreakNumber(n){
  if(!Number.isFinite(n)) return '—';
  // até 2 casas decimais, sem zeros a mais
  return Math.round(n*100)/100 === Math.round(n) ? String(Math.round(n)) : (Math.round(n*100)/100).toString();
}

/* painel de simbologia: aberto sob pedido (opção "Simbologia" do menu de contexto, ou clicando
   na mini-legenda por baixo da camada ativa no painel). Suporta 3 modos: cor única, valores
   únicos (uma cor por cada valor distinto de qualquer atributo) e graduado (classes numéricas
   com 4 métodos: manual, quantis, intervalos iguais, natural breaks/Jenks). */
function renderSymbologyPanel(){
  const row = document.getElementById('shape-color-attr-row');
  const nameLabel = document.getElementById('symbology-layer-name');
  const body = document.getElementById('symbology-body');

  if(symbologyLayerId === null){
    row.classList.add('hidden');
    return;
  }

  const schema = getLayerSchema(symbologyLayerId);
  if(!schema){ // a camada foi entretanto removida
    symbologyLayerId = null;
    row.classList.add('hidden');
    return;
  }

  row.classList.remove('hidden');
  nameLabel.textContent = `Simbologia — ${schema.name || 'Shape sem nome'}`;

  const sym = ensureSymbology(schema);
  const allAttrs = schema.mode === 'atributos' ? (schema.attributes || []) : [];
  const numericAttrs = allAttrs.filter(a=>a.type === 'numero');
  const canGraduate = numericAttrs.length > 0;
  // se o modo guardado deixou de ser possível (ex: já não há atributos numéricos), recua para "unicos"/"simples"
  if(sym.mode === 'graduado' && !canGraduate) sym.mode = allAttrs.length ? 'unicos' : 'simples';
  if(sym.mode === 'unicos' && allAttrs.length === 0) sym.mode = 'simples';

  const currentOpacity = schema.opacity != null ? schema.opacity : DEFAULT_OPACITY;

  const tabsHTML = `
    <div class="symbology-mode-tabs" id="symbology-mode-tabs">
      <button type="button" class="symbology-mode-tab ${sym.mode==='simples'?'is-active':''}" data-sym-mode="simples">Cor única</button>
      <button type="button" class="symbology-mode-tab ${sym.mode==='unicos'?'is-active':''}" data-sym-mode="unicos" ${allAttrs.length?'':'disabled'}>Valores únicos</button>
      <button type="button" class="symbology-mode-tab ${sym.mode==='graduado'?'is-active':''}" data-sym-mode="graduado" ${canGraduate?'':'disabled'}>Graduado</button>
    </div>`;

  const opacityHTML = `
    <label for="shape-opacity-input" style="margin-top:10px;">Transparência do preenchimento</label>
    <div class="symbology-color-row">
      <input type="range" id="shape-opacity-input" min="0" max="100" step="1" value="${currentOpacity}" style="flex:1;">
      <span class="hint" id="shape-opacity-value" style="margin:0; min-width:36px; text-align:right;">${currentOpacity}%</span>
    </div>`;

  let modeBodyHTML = '';

  if(sym.mode === 'unicos'){
    if(!sym.attr || !allAttrs.some(a=>a.name === sym.attr)){
      generateUniqueValueClasses(symbologyLayerId, allAttrs[0] ? allAttrs[0].name : null);
    }
    modeBodyHTML = `
      <label for="symbology-attr-select" style="margin-top:10px;">Classificar por valores únicos de</label>
      <select id="symbology-attr-select">
        ${allAttrs.map(a=>`<option value="${escapeHtml(a.name)}" ${a.name===sym.attr?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
      <ul class="shape-color-legend" id="shape-color-legend">
        ${sym.uniqueValues.length ? sym.uniqueValues.map((u, i)=>`
          <li><input type="color" class="swatch-input" value="${escapeHtml(u.color)}" data-unique-idx="${i}">${escapeHtml(u.value)}</li>
        `).join('') : '<li class="hint" style="padding:4px 0;">Esta camada ainda não tem geometrias com valores neste atributo.</li>'}
      </ul>`;
  } else if(sym.mode === 'graduado'){
    if(!sym.attr || !numericAttrs.some(a=>a.name === sym.attr)){
      generateGraduatedClasses(symbologyLayerId, numericAttrs[0] ? numericAttrs[0].name : null, sym.method, sym.classCount);
    }
    modeBodyHTML = `
      <label for="symbology-attr-select" style="margin-top:10px;">Atributo numérico</label>
      <select id="symbology-attr-select">
        ${numericAttrs.map(a=>`<option value="${escapeHtml(a.name)}" ${a.name===sym.attr?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}
      </select>
      <div class="symbology-grad-controls">
        <div>
          <label for="symbology-method-select">Método</label>
          <select id="symbology-method-select">
            ${Object.keys(SYMBOLOGY_METHOD_LABELS).filter(m=>m!=='manual').map(m=>`<option value="${m}" ${m===sym.method?'selected':''}>${SYMBOLOGY_METHOD_LABELS[m]}</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="symbology-classcount-input">Nº de classes</label>
          <input type="number" id="symbology-classcount-input" min="2" max="12" step="1" value="${sym.classCount}">
        </div>
      </div>
      ${sym.method === 'manual' ? '<span class="hint">Método: manual (ajustaste os limites à mão). Escolhe outro método acima para recalcular.</span>' : ''}
      <ul class="shape-color-legend shape-color-legend-graduated" id="shape-color-legend">
        ${sym.breaks.length ? sym.breaks.map((b, i)=>`
          <li class="graduated-row" data-break-idx="${i}">
            <input type="color" class="swatch-input" value="${escapeHtml(b.color)}" data-break-color-idx="${i}">
            <span class="graduated-range">${fmtBreakNumber(b.min)} –</span>
            ${i < sym.breaks.length - 1
              ? `<input type="number" class="graduated-bound-input" data-break-bound-idx="${i}" value="${fmtBreakNumber(b.max)}">`
              : `<span class="graduated-range">${fmtBreakNumber(b.max)}</span>`}
          </li>
        `).join('') : '<li class="hint" style="padding:4px 0;">Sem valores numéricos válidos neste atributo.</li>'}
      </ul>`;
  } else {
    modeBodyHTML = `
      <label for="shape-base-color-input" style="margin-top:10px;">Cor da camada</label>
      <div class="symbology-color-row">
        <input type="color" id="shape-base-color-input" value="${escapeHtml(schema.baseColor || DEFAULT_COLOR)}">
        <span class="hint" style="margin:0;">Aplicada a todas as geometrias desta camada.</span>
      </div>`;
  }

  body.innerHTML = tabsHTML + modeBodyHTML + opacityHTML;

  document.getElementById('symbology-mode-tabs').querySelectorAll('[data-sym-mode]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(btn.disabled) return;
      setLayerSymbologyMode(symbologyLayerId, btn.dataset.symMode);
      renderSymbologyPanel();
    });
  });

  document.getElementById('shape-opacity-input').addEventListener('input', (e)=>{
    document.getElementById('shape-opacity-value').textContent = e.target.value + '%';
    setLayerOpacity(symbologyLayerId, e.target.value);
  });

  if(sym.mode === 'simples'){
    document.getElementById('shape-base-color-input').addEventListener('input', (e)=>{
      setLayerBaseColor(symbologyLayerId, e.target.value);
    });
  } else if(sym.mode === 'unicos'){
    document.getElementById('symbology-attr-select').addEventListener('change', (e)=>{
      setLayerSymbologyUniqueAttr(symbologyLayerId, e.target.value);
      renderSymbologyPanel();
    });
    document.querySelectorAll('[data-unique-idx]').forEach(inp=>{
      inp.addEventListener('input', (e)=>{
        const item = sym.uniqueValues[Number(inp.dataset.uniqueIdx)];
        setUniqueValueColor(symbologyLayerId, item.value, e.target.value);
      });
    });
  } else if(sym.mode === 'graduado'){
    document.getElementById('symbology-attr-select').addEventListener('change', (e)=>{
      setLayerSymbologyGraduatedAttr(symbologyLayerId, e.target.value);
      renderSymbologyPanel();
    });
    document.getElementById('symbology-method-select').addEventListener('change', (e)=>{
      setLayerSymbologyMethod(symbologyLayerId, e.target.value);
      renderSymbologyPanel();
    });
    document.getElementById('symbology-classcount-input').addEventListener('change', (e)=>{
      const n = Math.max(2, Math.min(12, parseInt(e.target.value, 10) || sym.classCount));
      setLayerSymbologyClassCount(symbologyLayerId, n);
      renderSymbologyPanel();
    });
    document.querySelectorAll('[data-break-color-idx]').forEach(inp=>{
      inp.addEventListener('input', (e)=>{
        setGraduatedBreakColor(symbologyLayerId, Number(inp.dataset.breakColorIdx), e.target.value);
      });
    });
    document.querySelectorAll('[data-break-bound-idx]').forEach(inp=>{
      inp.addEventListener('change', (e)=>{
        setGraduatedBreakBound(symbologyLayerId, Number(inp.dataset.breakBoundIdx), e.target.value);
        renderSymbologyPanel();
      });
    });
  }
}

// reaplica a simbologia atual da camada ativa a todas as suas geometrias já desenhadas
function restyleAllLayers(){
  restyleLayerId(activeLayerId);
}

const ATTR_ACTION_ICONS = {
  highlight: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>',
  focus: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  edit: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  delete: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  overlap: '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};

// formata o conteúdo de uma célula de atributo consoante o tipo definido na
// camada: números alinhados à direita, categorias como "chip" colorido
// (reutilizando a cor já definida na simbologia), texto normal com tooltip
// para valores compridos.
function formatAttrCellHtml(attr, rawValue){
  const isEmpty = rawValue === undefined || rawValue === null || rawValue === '';
  if(isEmpty){
    return { attrs: `data-type="${attr.type}"`, html: '<span class="attr-cell-empty">—</span>' };
  }
  if(attr.type === 'categorico'){
    const cls = (attr.classes || []).find(c=>c.name === rawValue);
    const swatch = cls ? `<span class="attr-chip-swatch" style="background:${escapeHtml(cls.color)}"></span>` : '';
    return { attrs: `data-type="${attr.type}"`, html: `<span class="attr-chip">${swatch}${escapeHtml(rawValue)}</span>` };
  }
  const text = escapeHtml(String(rawValue));
  if(attr.type === 'numero'){
    return { attrs: `data-type="numero"`, html: text };
  }
  return { attrs: `data-type="texto"`, html: `<span title="${text}">${text}</span>` };
}

function renderAttrTable(layerId){
  if(layerId === undefined || layerId === null) layerId = activeLayerId;
  attrTableLayerId = layerId;

  const schema = getLayerSchema(layerId) || {name:null, mode:null, attributes:[]};
  const isActiveLayer = layerId === activeLayerId;
  const typeLabel = GEOM_TYPE_LABELS[schema.geometryType] || '—';
  const nameTag = document.getElementById('attr-table-layer-name');
  if(nameTag) nameTag.textContent = `${schema.name || 'Shape sem nome'} · ${typeLabel}`;

  const head = document.getElementById('attr-table-head');
  const body = document.getElementById('attr-table-body');
  const countPill = document.getElementById('attr-table-count-pill');
  const attrCols = schema.mode === 'atributos' ? schema.attributes : [];

  head.innerHTML = '<th data-type="id">ID</th>' +
    attrCols.map(a=>`<th data-type="${a.type}">${escapeHtml(a.name)}</th>`).join('') +
    '<th class="col-actions">Ações</th>';

  const entries = [];
  featuresData.forEach(entry=>{ if(entry.layerId === layerId) entries.push(entry); });

  if(entries.length === 0){
    body.innerHTML = `<tr><td colspan="${attrCols.length + 2}" id="attr-table-empty">Ainda não desenhaste nenhuma geometria nesta camada.</td></tr>`;
    if(countPill){ countPill.textContent = ''; countPill.classList.remove('has-overlap-warn'); }
    return;
  }

  const overlapCount = entries.filter(e=>e.hasOverlap && topologyWarningsEnabled).length;
  if(countPill){
    countPill.textContent = entries.length === 1 ? '1 geometria' : `${entries.length} geometrias`;
    if(overlapCount > 0){
      countPill.textContent += ` · ${overlapCount} com sobreposição`;
      countPill.classList.add('has-overlap-warn');
    } else {
      countPill.classList.remove('has-overlap-warn');
    }
  }

  let i = 0;
  const rows = [];
  entries.forEach(entry=>{
    i++;
    const attrCells = attrCols.map(a=>{
      const { attrs, html } = formatAttrCellHtml(a, entry.props[a.name]);
      return `<td ${attrs}>${html}</td>`;
    }).join('');
    const showOverlap = entry.hasOverlap && topologyWarningsEnabled;
    const overlapBadge = showOverlap
      ? `<span class="overlap-badge" title="Esta geometria sobrepõe-se a outra">${ATTR_ACTION_ICONS.overlap}</span>`
      : '';
    rows.push(`
      <tr data-row-id="${entry.id}" class="${showOverlap ? 'has-overlap' : ''}">
        <td class="id-cell"><span class="id-cell-inner"><span class="id-badge">${i}</span>${overlapBadge}</span></td>
        ${attrCells}
        <td class="actions-cell">
          <button data-highlight title="Realçar e mostrar popup">${ATTR_ACTION_ICONS.highlight}</button>
          <button data-focus title="Centrar no mapa">${ATTR_ACTION_ICONS.focus}</button>
          ${(schema.mode === 'atributos' && isActiveLayer) ? `<button data-edit title="Editar atributos">${ATTR_ACTION_ICONS.edit}</button>` : ''}
          <button data-delete class="danger" title="Apagar">${ATTR_ACTION_ICONS.delete}</button>
        </td>
      </tr>`);
  });
  body.innerHTML = rows.join('');

  body.querySelectorAll('tr[data-row-id]').forEach(tr=>{
    const entry = featuresData.get(Number(tr.dataset.rowId));
    if(!entry) return;
    tr.querySelector('[data-focus]')?.addEventListener('click', ()=>{
      if(entry.layer.getBounds) map.fitBounds(entry.layer.getBounds(), {maxZoom:16});
      else if(entry.layer.getLatLng) map.setView(entry.layer.getLatLng(), 16);
    });
    tr.querySelector('[data-highlight]')?.addEventListener('click', ()=>{
      showStatsPopup(entry);
      flashHighlight(entry);
    });
    tr.querySelector('[data-edit]')?.addEventListener('click', ()=> openAttrForm(entry));
    tr.querySelector('[data-delete]')?.addEventListener('click', ()=>{
      if(entry.fid){ teamState.deletedFids.set(entry.fid, Date.now()); }
      drawnGroup.removeLayer(entry.layer);
      featuresData.delete(entry.id);
      markProjectDirty();
      refreshFeatList();
      checkAllTopology();
    });
  });
}

document.getElementById('attr-table-close').addEventListener('click', ()=>{
  document.getElementById('attr-table-overlay').classList.add('hidden');
});

/* ============================================================
   EXPORTAÇÃO
   ============================================================ */
function buildGeoJSON(includeSyncMeta, includeLayerId, onlyLayerId){
  const features = [];
  featuresData.forEach(entry=>{
    if(onlyLayerId !== undefined && entry.layerId !== onlyLayerId) return;
    const gj = entry.layer.toGeoJSON();
    const cleanProps = {...entry.props};
    delete cleanProps.__fid;
    delete cleanProps.__updatedAt;
    delete cleanProps.__layerId;
    gj.properties = cleanProps;
    if(includeSyncMeta){
      gj.properties.__fid = entry.fid || genFid();
      gj.properties.__updatedAt = entry.updatedAt || Date.now();
    }
    if(includeLayerId){
      gj.properties.__layerId = entry.layerId;
    }
    features.push(gj);
  });
  return {
    type:'FeatureCollection',
    features,
    __layers: serializeLayerSchemasForGeoJSON(),
    __activeLayerId: activeLayerId
  };
}

function loadSavedTeam(){
  try{
    const saved = JSON.parse(localStorage.getItem(TEAM_STORAGE_KEY));
    if(saved && saved.slug){
      teamState.savedSlug = saved.slug;
      teamState.savedName = saved.name || '';
      teamState.slug = saved.slug;
      teamState.name = saved.name || '';
      teamState.connected = false;
      if(Array.isArray(saved.deletedFids)){
        teamState.deletedFids = new Map(saved.deletedFids.map(fid=>[fid, Date.now()]));
      }
    }
  }catch(err){
    console.warn('Não foi possível ler o projeto de equipa guardado.', err);
  }
}

function saveTeamProject(){
  try{
    const payload = {
      slug: teamState.slug,
      name: teamState.name,
      deletedFids: Array.from(teamState.deletedFids.keys())
    };
    localStorage.setItem(TEAM_STORAGE_KEY, JSON.stringify(payload));
  }catch(err){ console.warn('Não foi possível guardar o estado da equipa.', err); }
}

function clearTeamProject(){
  try{ localStorage.removeItem(TEAM_STORAGE_KEY); }catch(err){ }
  teamState = {
    savedSlug: '', savedName: '', slug: '', name: '', password: null,
    connected: false, lastSync: null, deletedFids: new Map(), usedBytes: 0, sizeLimit: 200 * 1024 * 1024, status: 'idle'
  };
  updateProjectStatusUI();
}

function showTeamToast(message){
  const toast = document.getElementById('team-sync-toast');
  if(!toast) return;
  toast.querySelector('.message').textContent = message;
  toast.classList.remove('is-leaving');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(()=>{
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
  }, 3200);
}

const TEAM_API_BASE = 'https://datagis-equipa.gispt.workers.dev';

const API_REQUEST_TIMEOUT_MS = 20000;

async function apiRequest(method, path, data, extraHeaders){
  const controller = new AbortController();
  const timeoutId = setTimeout(()=> controller.abort(), API_REQUEST_TIMEOUT_MS);
  const options = {method, headers:{'Content-Type':'application/json', ...(extraHeaders || {})}, signal: controller.signal};
  if(data !== undefined) options.body = JSON.stringify(data);
  let res;
  try{
    res = await fetch(TEAM_API_BASE + path, options);
  }catch(err){
    if(err.name === 'AbortError'){
      const timeoutErr = new Error('O pedido demorou demasiado tempo e foi cancelado. Verifica a tua ligação e tenta novamente.');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    throw err;
  }finally{
    clearTimeout(timeoutId);
  }
  const text = await res.text();
  let result = null;
  try{
    result = text ? JSON.parse(text) : null;
  }catch(e){
    result = text;
  }
  if(!res.ok){
    const err = new Error((result && result.message) || `Erro ${res.status}`);
    err.status = res.status;
    err.body = result;
    throw err;
  }
  return result;
}

function normalizeTeamProjectName(name){
  return (name || '').trim();
}

function renderTeamCard(mode = null){
  const container = document.getElementById('cloud-team-content') || document.getElementById('team-card-content');
  if(!container) return;

  if(!mode && teamState.connected){
    const usedLabel = teamState.usedBytes ? `${(teamState.usedBytes / 1024 / 1024).toFixed(1)} MB` : '—';
    const lastSyncLabel = teamState.lastSync ? new Date(teamState.lastSync).toLocaleString('pt-PT') : 'Nunca sincronizado';
    const statusLabel = teamState.status === 'syncing' ? 'a sincronizar…' : 'Pronto para sincronizar';
    const percent = Math.min(100, (teamState.usedBytes / teamState.sizeLimit) * 100);

    container.innerHTML = `
      <div class="cloud-form-card">
        <div class="team-status-row"><span>Projeto</span><b>${teamState.name}</b></div>
        <div class="team-status-row"><span>Estado</span><b>${statusLabel}</b></div>
        <div class="team-status-row"><span>Última sincronização</span><b>${lastSyncLabel}</b></div>
        <div class="team-status-row"><span>Espaço usado</span><b>${usedLabel} / 200 MB</b></div>
        <div class="team-progress-bar"><div class="team-progress-fill" style="width:${percent}%"></div></div>
        <div class="cloud-inline-row">
          <button type="button" class="btn primary" id="team-sync-btn">Sincronizar</button>
          <button type="button" class="btn" id="team-download-btn">Descarregar/Atualizar</button>
        </div>
        <div class="cloud-inline-row">
          <button type="button" class="btn warn" id="team-leave-btn">Sair do projeto</button>
        </div>
      </div>
    `;

    container.querySelector('#team-sync-btn')?.addEventListener('click', syncTeamProject);
    container.querySelector('#team-download-btn')?.addEventListener('click', downloadTeamProject);
    container.querySelector('#team-leave-btn')?.addEventListener('click', leaveTeamProject);
    return;
  }

  const isCreateMode = mode === 'create';
  const savedInfo = teamState.slug ? `<div class="team-status-row"><span>Projeto guardado</span><b>${teamState.name || '—'}</b></div>` : '';
  const actionButtons = isCreateMode
    ? `<div class="btn-row"><button type="button" class="btn primary" id="team-create-btn">Criar projeto</button></div>`
    : `<div class="btn-row"><button type="button" class="btn primary" id="team-resume-btn">Retomar projeto</button><button type="button" class="btn warn" id="team-delete-btn">Eliminar projeto</button></div>`;

  container.innerHTML = `
    <div class="cloud-form-card">
      ${savedInfo}
      <div class="cloud-field">
        <label for="team-project-name">Nome do projeto</label>
        <input class="cloud-input" type="text" id="team-project-name" placeholder="Ex: meu-projeto" value="${teamState.name || ''}" autocomplete="off">
      </div>
      <div class="cloud-field">
        <label for="team-project-password">Password</label>
        <input class="cloud-input" type="password" id="team-project-password" autocomplete="new-password">
      </div>
      ${actionButtons}
      <p class="cloud-helper">${isCreateMode ? 'O nome do projeto fica guardado localmente. A password é usada apenas para proteger o acesso ao projeto online.' : 'Preenche o nome e a password para retomar ou eliminar um projeto guardado.'}</p>
    </div>
  `;
  container.querySelector('#team-create-btn')?.addEventListener('click', ()=>{
    if (typeof window.adminGateRequireAuth === 'function') {
      window.adminGateRequireAuth(createTeamProject);
    } else {
      createTeamProject();
    }
  });
  container.querySelector('#team-resume-btn')?.addEventListener('click', resumeTeamProject);
  container.querySelector('#team-delete-btn')?.addEventListener('click', ()=>{
    const projectName = normalizeTeamProjectName(document.getElementById('team-project-name')?.value || teamState.name);
    const promptText = projectName
      ? `Eliminar o projeto “${projectName}” guardado localmente?`
      : 'Eliminar o projeto guardado localmente?';
    if(!requestConfirmation(promptText)) return;
    clearTeamProject();
    clearCloudSyncState();
    renderTeamCard('load');
    updateTeamSyncSupportVisibility();
    showTeamToast('Projeto eliminado.');
  });
}

function updateTeamMetadata(result){
  if(result && result.manifest){
    const manifest = result.manifest;
    teamState.lastSync = manifest.updatedAt ? new Date(manifest.updatedAt).getTime() : teamState.lastSync || Date.now();
    teamState.usedBytes = manifest.total_bytes || manifest.size || manifest.bytes || teamState.usedBytes;
  }
}

async function createTeamProject(){
  const nameInput = document.getElementById('team-project-name');
  const passInput = document.getElementById('team-project-password');
  const projectName = normalizeTeamProjectName(nameInput?.value);
  const password = passInput?.value || '';
  if(!projectName || !password){ alert('Fornece um nome de projeto e password.'); return; }

  try{
    const result = await apiRequest('POST', '/api/projects/create', {name: projectName, password});
    teamState.slug = result.slug || projectName;
    teamState.name = projectName;
    teamState.password = password;
    teamState.connected = true;
    teamState.savedSlug = teamState.slug;
    teamState.savedName = teamState.name;
    setCloudSyncState('team');
    saveTeamProject();
    renderTeamCard();
    updateTeamSyncSupportVisibility();
    updateProjectStatusUI();
    showTeamToast('Projeto criado. Agora podes sincronizar.');
  }catch(err){
    if(err.status === 409){
      alert('Já existe um projeto com esse nome. Escolhe outro nome.');
    } else {
      console.error('Erro ao criar projeto de equipa:', err);
      alert('Não foi possível criar o projeto. ' + (err.message || 'Verifica a ligação ao servidor.'));
    }
  }
}

async function resumeTeamProject(){
  const nameInput = document.getElementById('team-project-name');
  const passInput = document.getElementById('team-project-password');
  const projectName = normalizeTeamProjectName(nameInput?.value || teamState.name);
  const password = passInput?.value || '';
  if(!projectName || !password){ alert('Fornece o nome do projeto e a password para retomar.'); return; }

  try{
    const result = await apiRequest('POST', '/api/projects/resume', {name: projectName, password});
    teamState.slug = result.slug || teamState.slug || projectName;
    teamState.name = projectName;
    teamState.password = password;
    teamState.connected = true;
    teamState.savedSlug = teamState.slug;
    teamState.savedName = teamState.name;
    setCloudSyncState('team');
    updateTeamMetadata(result);
    saveTeamProject();
    renderTeamCard();
    updateTeamSyncSupportVisibility();
    updateProjectStatusUI();
    await loadTeamGeometries(result);
  }catch(err){
    if(err.status === 401){ alert('Password incorreta.'); }
    else { console.error(err); alert('Não foi possível retomar o projeto.'); }
  }
}

async function loadTeamGeometries(resumeData){
  teamState.status = 'syncing'; renderTeamCard();
  try{
    const geojson = await downloadTeamGeoJSON(resumeData);
    clearLocalProjectState();
    clearMapLayerState();
    featureCounter = 0;
    restoreLayerSchemasFromGeoJSON(geojson);
    if(!geojson.features || geojson.features.length === 0){
      teamState.status = 'idle'; renderTeamCard();
      showTeamToast('Projeto retomado. Ainda não há geometrias guardadas.');
      return;
    }
    importGeoJSONFeatures(geojson);
    ensureActiveLayerForImportedProject();
    finalizeLoadedProjectState();
    teamState.status = 'idle';
    renderTeamCard();
    showTeamToast('Projeto retomado e geometrias carregadas.');
  }catch(err){
    console.error('Erro ao carregar geometrias do projeto:', err);
    clearMapLayerState();
    clearLocalProjectState();
    teamState.status = 'idle';
    renderTeamCard();
    showTeamToast('Projeto retomado, mas falhou o carregamento das geometrias.');
  }
}

async function downloadTeamGeoJSON(resumeData){
  if(resumeData.geojson) return resumeData.geojson;

  const chunkCount = Array.isArray(resumeData.manifest?.chunks)
    ? resumeData.manifest.chunks.length
    : (resumeData.manifest?.chunkCount || 0);
  if(!chunkCount || chunkCount <= 0){
    return {type:'FeatureCollection', features:[], __deletedFids:[]};
  }

  let text = '';
  for(let index = 0; index < chunkCount; index++){
    const chunkResponse = await apiRequest('GET', `/api/projects/${encodeURIComponent(teamState.slug)}/chunk/${index}`, undefined, {'X-Project-Password': teamState.password});
    if(typeof chunkResponse === 'string'){
      text += chunkResponse;
    } else if(chunkResponse.data){
      text += chunkResponse.data;
    } else {
      throw new Error('Resposta inválida ao carregar bloco ' + index);
    }
  }
  return JSON.parse(text);
}

/*
 * Junta o estado local com o estado atual do servidor, geometria a geometria (por __fid):
 * - geometrias só locais ou só no servidor entram sempre no resultado
 * - geometrias eliminadas (localmente ou já removidas no servidor) ficam de fora
 * - geometrias presentes em ambos: fica a versão com __updatedAt mais recente
 * Isto permite que dois utilizadores sincronizem quase ao mesmo tempo sem perderem
 * o trabalho um do outro, desde que não editem exatamente a mesma geometria.
 */
function mergeTeamGeoJSON(localGeojson, serverGeojson){
  const deleted = new Set(serverGeojson.__deletedFids || []);
  teamState.deletedFids.forEach((ts, fid)=> deleted.add(fid));

  const byFid = new Map();

  (serverGeojson.features || []).forEach(f=>{
    const fid = f.properties && f.properties.__fid;
    if(!fid || deleted.has(fid)) return;
    byFid.set(fid, f);
  });

  (localGeojson.features || []).forEach(f=>{
    const fid = f.properties && f.properties.__fid;
    if(!fid || deleted.has(fid)) return;
    const existing = byFid.get(fid);
    if(!existing){
      byFid.set(fid, f);
    } else {
      const localTs = f.properties.__updatedAt || 0;
      const serverTs = (existing.properties && existing.properties.__updatedAt) || 0;
      if(localTs >= serverTs) byFid.set(fid, f);
    }
  });

  const mergedLayers = (localGeojson.__layers && localGeojson.__layers.length)
    ? localGeojson.__layers
    : (serverGeojson.__layers || []);

  return {
    type: 'FeatureCollection',
    features: [...byFid.values()],
    __deletedFids: [...deleted],
    __layers: mergedLayers,
    __activeLayerId: localGeojson.__activeLayerId || serverGeojson.__activeLayerId || undefined
  };
}

function splitTextToChunks(text, maxBytes){
  const encoder = new TextEncoder();
  const chunks = [];
  let pos = 0;
  while(pos < text.length){
    let end = Math.min(text.length, pos + 16384);
    let slice = text.slice(pos, end);
    while(encoder.encode(slice).length > maxBytes){
      end = pos + Math.floor((end - pos) / 2);
      if(end <= pos) break;
      slice = text.slice(pos, end);
    }
    if(!slice.length){ throw new Error('Não foi possível criar os blocos de sincronização.'); }
    chunks.push(slice);
    pos += slice.length;
  }
  return chunks;
}

async function syncTeamProject(){
  if(!teamState.connected){ alert('Retoma ou cria um projeto de equipa antes de sincronizar.'); return; }
  if(teamState.status === 'syncing'){ return; } // evita chamadas repetidas (duplo clique) enquanto já está a sincronizar
  if(featuresData.size === 0 && teamState.deletedFids.size === 0){ alert('Ainda não tens geometrias para sincronizar.'); return; }
  teamState.status = 'syncing';
  updateOnlineSyncButtonVisibility();
  renderTeamCard();
  renderCloudMenu();

  try{
    // 1. buscar o estado atual do servidor (pode ter sido alterado por outra pessoa entretanto)
    const resumeData = await apiRequest('POST', '/api/projects/resume', {name: teamState.name, password: teamState.password});
    const serverGeojson = await downloadTeamGeoJSON(resumeData);

    // 2. juntar com o que temos localmente, geometria a geometria
    const localGeojson = buildGeoJSON(true);
    const merged = mergeTeamGeoJSON(localGeojson, serverGeojson);

    // 3. enviar o resultado do merge
    const text = JSON.stringify(merged);
    const chunks = splitTextToChunks(text, 2.5 * 1024 * 1024);

    for(let index = 0; index < chunks.length; index++){
      await apiRequest('POST', `/api/projects/${encodeURIComponent(teamState.slug)}/chunk`, {
        index,
        data: chunks[index],
        password: teamState.password,
        totalChunks: chunks.length
      });
    }

    await apiRequest('POST', `/api/projects/${encodeURIComponent(teamState.slug)}/finalize`, {
      password: teamState.password,
      totalChunks: chunks.length
    });

    // 4. atualizar o mapa local com o resultado já unido (pode incluir geometrias de outra pessoa)
    clearMapLayerState();
    featureCounter = 0;
    restoreLayerSchemasFromGeoJSON(merged);
    importGeoJSONFeatures(merged);
    finalizeLoadedProjectState();
    teamState.deletedFids.clear();

    teamState.usedBytes = new TextEncoder().encode(text).length;
    teamState.lastSync = Date.now();
    teamState.status = 'idle';
    saveTeamProject();
    renderTeamCard();
    updateOnlineSyncButtonVisibility();
    renderCloudMenu();
    showTeamToast('Sincronização concluída (com o trabalho de todos).');
  }catch(err){
    console.error(err);
    clearMapLayerState();
    teamState.status = 'idle';
    renderTeamCard();
    updateOnlineSyncButtonVisibility();
    renderCloudMenu();
    alert('Falha na sincronização. O estado anterior foi limpo para evitar inconsistências.');
  }
}

async function fetchTeamProjectGeoJSON(){
  const resumeData = await apiRequest('POST', '/api/projects/resume', {name: teamState.name, password: teamState.password});
  updateTeamMetadata(resumeData);
  return downloadTeamGeoJSON(resumeData);
}

async function downloadTeamProject(){
  if(!teamState.connected){ alert('Retoma ou cria um projeto de equipa antes de descarregar.'); return; }
  if(teamState.status === 'syncing'){ return; } // evita chamadas repetidas (duplo clique) enquanto já está a descarregar
  teamState.status = 'syncing'; renderTeamCard();

  try{
    const geojson = await fetchTeamProjectGeoJSON();
    clearLocalProjectState();
    clearMapLayerState();
    featureCounter = 0;
    restoreLayerSchemasFromGeoJSON(geojson);
    importGeoJSONFeatures(geojson);
    ensureActiveLayerForImportedProject();
    finalizeLoadedProjectState();
    teamState.status = 'idle'; // corrige bug: o estado nunca voltava a 'idle' após sucesso, o que bloqueava sincronizações futuras
    renderTeamCard();
    showTeamToast('Projeto descarregado e atualizado com sucesso.');
  }catch(err){
    console.error(err);
    teamState.status = 'idle';
    renderTeamCard();
    alert('Falha ao descarregar o projeto.');
  }
}

function leaveTeamProject(){
  if(!requestConfirmation('Sais do projeto de equipa? O nome do projeto será removido localmente.')) return;
  clearTeamProject();
  clearCloudSyncState();
  renderTeamCard();
  updateTeamSyncSupportVisibility();
  updateProjectStatusUI();
  renderCloudMenu();
  showTeamToast('Saíste do projeto de equipa.');

  teamPanelVisible = false;
  const block = document.getElementById('team-block');
  if(block) block.classList.add('hidden');
}

async function deleteTeamProjectFromServer(projectName, password){
  const candidates = [
    {method:'POST', path:'/api/projects/delete', data:{name: projectName, password}},
    {method:'POST', path:`/api/projects/${encodeURIComponent(projectName)}/delete`, data:{password}},
    {method:'DELETE', path:`/api/projects/${encodeURIComponent(projectName)}`, extraHeaders:{'X-Project-Password': password}}
  ];

  let lastError = null;
  for(const candidate of candidates){
    try{
      return await apiRequest(candidate.method, candidate.path, candidate.data, candidate.extraHeaders);
    }catch(err){
      lastError = err;
      if(err && (err.status === 404 || err.status === 405)) continue;
      throw err;
    }
  }
  throw lastError || new Error('Não foi possível eliminar o projeto.');
}

function showTeamPanel(){
  teamPanelVisible = true;
  const block = document.getElementById('team-block');
  if(block) block.classList.add('hidden');
  const wizard = document.getElementById('wizard-overlay');
  if(wizard) wizard.classList.add('hidden');
  openCloudMenu();
}

function hideTeamPanel(){
  teamPanelVisible = false;
  closeCloudMenu();
  const block = document.getElementById('team-block');
  if(block) block.classList.add('hidden');
}
document.getElementById('team-card-close').addEventListener('click', hideTeamPanel);
document.getElementById('cloud-menu-close')?.addEventListener('click', hideTeamPanel);

document.getElementById('btn-sync-online')?.addEventListener('click', ()=>{
  if(cloudSyncMode === 'team'){
    syncTeamProject();
  } else if(cloudSyncMode === 'personal'){
    showTeamToast('A sincronização do projeto pessoal está preparada para o próximo passo.');
  }
});

function updateTeamSyncSupportVisibility(){
  const connectCard = document.getElementById('team-sync-support');
  const connectedNote = document.getElementById('team-sync-connected-note');
  const nameSpan = document.getElementById('team-sync-connected-name');
  if(!connectCard || !connectedNote) return;
  if(teamState.connected){
    connectCard.classList.add('hidden');
    connectedNote.classList.remove('hidden');
    if(nameSpan) nameSpan.textContent = teamState.name || '';
  } else {
    connectCard.classList.remove('hidden');
    connectedNote.classList.add('hidden');
  }
}

function initTeamUI(){
  document.getElementById('btn-open-team-panel')?.addEventListener('click', showTeamPanel);
  document.getElementById('btn-open-team-panel-connected')?.addEventListener('click', showTeamPanel);
  loadSavedTeam();
  renderCloudMenu();
  renderTeamCard();
  updateTeamSyncSupportVisibility();
  updateOnlineSyncButtonVisibility();
}

const WGS84_WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const PTTM06_WKT = 'PROJCS["ETRS89 / Portugal TM06",GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",39.66825833333333],PARAMETER["central_meridian",-8.133108333333334],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]';

/* reprojeta recursivamente um array de coordenadas GeoJSON (WGS84 -> destino) */
function reprojectCoords(coords, fromCrs, toCrs){
  if(typeof coords[0] === 'number'){
    const [x, y] = proj4(fromCrs, toCrs, [coords[0], coords[1]]);
    return coords.length > 2 ? [x, y, coords[2]] : [x, y];
  }
  return coords.map(c => reprojectCoords(c, fromCrs, toCrs));
}

/* devolve uma cópia da FeatureCollection com as geometrias reprojetadas de WGS84
   para o CRS pedido (usado apenas na exportação — o projeto continua sempre
   guardado internamente em WGS84/EPSG:4326). */
function reprojectGeoJSON(gj, toCrs){
  if(toCrs === 'EPSG:4326') return gj;
  return {
    ...gj,
    crs: { type:'name', properties:{ name: 'urn:ogc:def:crs:' + toCrs.replace(':', '::') } },
    features: gj.features.map(f => ({
      ...f,
      geometry: f.geometry ? { ...f.geometry, coordinates: reprojectCoords(f.geometry.coordinates, 'EPSG:4326', toCrs) } : f.geometry
    }))
  };
}

function downloadGeoJSON(gj, filename){
  const blob = new Blob([JSON.stringify(gj, null, 2)], {type:'application/geo+json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------
   Correção de winding order para Shapefile.
   GeoJSON (RFC 7946) exige anel exterior CCW e buracos CW.
   O formato Shapefile (ESRI) exige o oposto: anel exterior CW e
   buracos CCW. Se isto não for garantido antes de escrever o
   .shp, o ArcGIS pode interpretar o anel exterior como um buraco
   e o polígono não é desenhado.
   ------------------------------------------------------------ */
function ringSignedArea(ring){
  let area = 0;
  for(let i=0; i<ring.length; i++){
    const [x1,y1] = ring[i];
    const [x2,y2] = ring[(i+1) % ring.length];
    area += (x1*y2 - x2*y1);
  }
  return area / 2;
}

function rewindRing(ring, clockwise){
  const isClockwise = ringSignedArea(ring) < 0;
  if(isClockwise === clockwise) return ring;
  return ring.slice().reverse();
}

function rewindPolygonCoords(coords){
  // coords[0] = anel exterior -> deve ficar CW para Shapefile
  // coords[1..] = buracos -> devem ficar CCW para Shapefile
  return coords.map((ring, i) => rewindRing(ring, i === 0));
}

function rewindGeometryForShapefile(geom){
  if(!geom) return geom;
  if(geom.type === 'Polygon'){
    return { ...geom, coordinates: rewindPolygonCoords(geom.coordinates) };
  }
  if(geom.type === 'MultiPolygon'){
    return { ...geom, coordinates: geom.coordinates.map(rewindPolygonCoords) };
  }
  return geom;
}

function rewindGeoJSONForShapefile(gj){
  return {
    ...gj,
    features: gj.features.map(f => ({
      ...f,
      geometry: rewindGeometryForShapefile(f.geometry)
    }))
  };
}

async function exportShapefileZip(gj, folderName, btn, prjWkt){
  const originalText = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = '⏳ A gerar…'; }
  try{
    if(typeof shpwrite === 'undefined'){
      throw new Error('A biblioteca shp-write não carregou (verifica a ligação à internet ou bloqueadores de scripts/anúncios).');
    }
    if(typeof JSZip === 'undefined'){
      throw new Error('A biblioteca JSZip não carregou.');
    }
    if(!gj || !Array.isArray(gj.features) || gj.features.length === 0){
      throw new Error(`Não há geometrias para exportar${folderName ? ` em "${folderName}"` : ''} — o ficheiro Shapefile ficaria vazio.`);
    }
    const gjForShp = rewindGeoJSONForShapefile(gj);
    const prjText = prjWkt || WGS84_WKT;

    /* CORREÇÃO DE BUG DA BIBLIOTECA shp-write@0.4.3:
       o justType('LineString'/'MultiLineString', 'POLYLINE') em geojson.js
       embrulha SEMPRE as geometrias numa camada extra de array, ao contrário
       de POLYGON/POINT. Quando shpwrite.zip() combina os grupos "line" e
       "multiline" (via flatMap em zip.js) e um deles está vazio — o caso
       normal, já que desenhamos LineString simples — sobra uma entrada
       fantasma [] que faz crashar poly.js:parts(). Por isso as linhas nunca
       chegavam a ser escritas. Contorna-se separando as linhas do resto e
       escrevendo-as com shpwrite.write() de baixo nível, que não passa por
       esse caminho defeituoso. */
    const lineFeatures  = gjForShp.features.filter(f => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'));
    const otherFeatures = gjForShp.features.filter(f => !(f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')));

    const zip = new JSZip();

    if(otherFeatures.length){
      const otherGj = { ...gjForShp, features: otherFeatures };
      const partialBlob = await shpwrite.zip(otherGj, {
        folder: folderName,
        types: { point:'pontos', polygon:'poligonos', polyline:'linhas' },
        prj: prjText,
        outputType: 'blob'
      });
      const partialZip = await JSZip.loadAsync(partialBlob);
      for(const [name, entry] of Object.entries(partialZip.files)){
        if(entry.dir) continue;
        const data = await entry.async('uint8array');
        // corrige também aqui o .prj (o bundle da CDN ignora options.prj)
        zip.file(name, name.toLowerCase().endsWith('.prj') ? prjText : data, { binary: !name.toLowerCase().endsWith('.prj') });
      }
    }

    if(lineFeatures.length){
      const rows = lineFeatures.map(f => f.properties || {});
      /* IMPORTANTE: a função interna de escrita da shp-write trata "coords.length"
         como "número de partes" — o que só é correto se coords já for uma lista
         de partes (como um MultiLineString, ou como um Polygon em GeoJSON, cujos
         anéis já vêm nesse formato). Um LineString simples vem em GeoJSON como
         uma lista plana de pontos, sem esse nível extra, o que fazia a biblioteca
         confundir "número de pontos" com "número de partes" e gravar a linha
         como várias partes degeneradas (por isso não aparecia no ArcGIS mesmo
         depois de contornar o crash anterior). Por isso embrulha-se o LineString
         como se fosse um MultiLineString de uma única parte antes de escrever. */
      const geometries = lineFeatures.map(f => f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates);
      const lineFiles = await new Promise((resolve, reject) => {
        shpwrite.write(rows, 'POLYLINE', geometries, (err, files) => err ? reject(err) : resolve(files));
      });
      const base = folderName + '/linhas';
      zip.file(base + '.shp', lineFiles.shp.buffer, { binary: true });
      zip.file(base + '.shx', lineFiles.shx.buffer, { binary: true });
      zip.file(base + '.dbf', lineFiles.dbf.buffer, { binary: true });
      zip.file(base + '.prj', prjText);
    }

    const finalBlob = await zip.generateAsync({ type: 'blob' });

    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = url; a.download = folderName + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }catch(err){
    console.error('Erro ao exportar shapefile:', err);
    alert('Não foi possível gerar a shape , esta ferramenta ainda está em desenvolvimento, apenas está disponivel exportação em Geojson. Pedimos desculpa por qualquer incómodo :( .');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = originalText; }
  }
}

/* ============================================================
   MENU DE EXPORTAÇÃO / DOWNLOAD (camadas)
   ============================================================ */
function getExportableLayers(){
  const exportables = [];
  const allLayerIds = layers.map(l=>l.id).concat(config.geometryType ? [activeLayerId] : []);
  allLayerIds.forEach(id=>{
    if(countLayerFeatures(id) === 0) return;
    const schema = getLayerSchema(id);
    const safeName = (schema.name || 'camada').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'camada';
    exportables.push({
      id: 'layer_' + id,
      label: schema.name || 'Shape sem nome',
      filename: 'engenh_' + safeName,
      getGeoJSON: () => buildGeoJSON(false, false, id)
    });
  });
  if(typeof lastBufferFeatures !== 'undefined' && lastBufferFeatures.length > 0){
    exportables.push({
      id: 'buffer',
      label: 'Resultado do buffer',
      filename: 'engenh_buffer',
      getGeoJSON: () => ({type:'FeatureCollection', features: lastBufferFeatures})
    });
  }
  if(typeof lastIntersectFeatures !== 'undefined' && lastIntersectFeatures.length > 0){
    exportables.push({
      id: 'intersect',
      label: 'Resultado da interseção',
      filename: 'engenh_intersect',
      getGeoJSON: () => ({type:'FeatureCollection', features: lastIntersectFeatures})
    });
  }
  if(typeof lastUnionFeatures !== 'undefined' && lastUnionFeatures.length > 0){
    exportables.push({
      id: 'union',
      label: 'Resultado da união',
      filename: 'engenh_union',
      getGeoJSON: () => ({type:'FeatureCollection', features: lastUnionFeatures})
    });
  }
  if(typeof lastDifferenceFeatures !== 'undefined' && lastDifferenceFeatures.length > 0){
    exportables.push({
      id: 'difference',
      label: 'Resultado da diferença',
      filename: 'engenh_difference',
      getGeoJSON: () => ({type:'FeatureCollection', features: lastDifferenceFeatures})
    });
  }
  return exportables;
}

function openExportMenu(onlyLayerId){
  const layers = getExportableLayers();
  const emptyEl = document.getElementById('export-menu-empty');
  const bodyEl = document.getElementById('export-menu-body');
  const listEl = document.getElementById('export-layer-list');
  const downloadBtn = document.getElementById('export-menu-download');

  listEl.innerHTML = '';

  if(layers.length === 0){
    emptyEl.classList.remove('hidden');
    bodyEl.classList.add('hidden');
    downloadBtn.style.display = 'none';
  } else {
    emptyEl.classList.add('hidden');
    bodyEl.classList.remove('hidden');
    downloadBtn.style.display = '';

    layers.forEach(l=>{
      const row = document.createElement('label');
      const isChecked = onlyLayerId ? (l.id === onlyLayerId) : true;
      row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--line); border-radius:var(--radius-sm); cursor:pointer; font-size:13.5px;';
      row.innerHTML = `<input type="checkbox" data-layer-id="${l.id}" ${isChecked ? 'checked' : ''} style="width:16px; height:16px;"><span>${l.label}</span>`;
      listEl.appendChild(row);
    });
  }

  document.getElementById('export-menu-overlay').classList.remove('hidden');
}

function closeExportMenu(){
  document.getElementById('export-menu-overlay').classList.add('hidden');
}

document.getElementById('btn-open-export-menu').addEventListener('click', openExportMenu);
document.getElementById('export-menu-cancel').addEventListener('click', closeExportMenu);
document.getElementById('export-menu-close-x').addEventListener('click', closeExportMenu);
document.getElementById('export-menu-overlay').addEventListener('click', (e)=>{
  if(e.target.id === 'export-menu-overlay') closeExportMenu();
});

['export-format-geojson-label','export-format-shp-label'].forEach(id=>{
  const label = document.getElementById(id);
  const input = label.querySelector('input');
  const sync = () => label.classList.toggle('selected', input.checked);
  input.addEventListener('change', ()=>{
    document.getElementById('export-format-geojson-label').classList.toggle('selected', document.getElementById('export-format-geojson').checked);
    document.getElementById('export-format-shp-label').classList.toggle('selected', document.getElementById('export-format-shp').checked);
  });
  sync();
});

document.getElementById('export-menu-download').addEventListener('click', async ()=>{
  const layers = getExportableLayers();
  const checkedIds = Array.from(document.querySelectorAll('#export-layer-list input[type=checkbox]:checked')).map(cb=>cb.dataset.layerId);
  if(checkedIds.length === 0){ alert('Seleciona pelo menos uma camada para download.'); return; }
  const format = document.querySelector('input[name="export-format"]:checked').value;
  const crs = document.getElementById('export-crs-select').value; // 'EPSG:3763' (predefinido) ou 'EPSG:4326'
  const prjWkt = crs === 'EPSG:3763' ? PTTM06_WKT : WGS84_WKT;

  const downloadBtn = document.getElementById('export-menu-download');
  const originalText = downloadBtn.textContent;
  downloadBtn.disabled = true;

  for(const id of checkedIds){
    const layer = layers.find(l=>l.id === id);
    if(!layer) continue;
    const gj = reprojectGeoJSON(layer.getGeoJSON(), crs);
    if(format === 'geojson'){
      downloadGeoJSON(gj, layer.filename + '.geojson');
    } else {
      downloadBtn.textContent = `⏳ A gerar ${layer.label}…`;
      await exportShapefileZip(gj, layer.filename, null, prjWkt);
    }
  }

  downloadBtn.disabled = false;
  downloadBtn.textContent = originalText;
  closeExportMenu();
});

/* ============================================================
   ANÁLISE ESPACIAL — BUFFER
   ============================================================ */
let analysisMap = null;
let analysisSourceLayer = null;
let bufferLayerGroup = null;
let analysisSelection = new Set();   // ids (L.Util.stamp) das geometrias incluídas no buffer
let lastBufferFeatures = [];          // resultado do último buffer gerado, para exportação
let bufferDebounceTimer = null;

// ---------- overlay: intersect / union / difference ----------
let intersectLayerGroup = null, unionLayerGroup = null, differenceLayerGroup = null;
let intersectSelection = new Set();
let unionSelection = new Set();
let diffBaseId = null;
let diffSubtractSelection = new Set();
let lastIntersectFeatures = [];
let lastUnionFeatures = [];
let lastDifferenceFeatures = [];

function buildAnalysisFeatureList(){
  const arr = [];
  featuresData.forEach(entry=>{
    const gj = entry.layer.toGeoJSON();
    gj.properties = {...entry.props, _origem: entry.label};
    arr.push({id: entry.id, label: entry.label, geojson: gj, layerId: entry.layerId});
  });
  return arr;
}

/* ============================================================
   Painel de análise espacial — agrupamento das listas de
   geometria por camada (só apresentação; a seleção continua a
   guardar ids de geometria exatamente como antes)
   ============================================================ */

// agrupa os items (já construídos por buildAnalysisFeatureList) pela
// respetiva camada, respeitando a ordem visível no painel de camadas
function groupAnalysisItemsByLayer(items){
  const groups = new Map(); // layerId -> {name, color, items:[]}
  items.forEach(it=>{
    const key = it.layerId != null ? it.layerId : '__sem_camada__';
    if(!groups.has(key)){
      const schema = it.layerId != null ? getLayerSchema(it.layerId) : null;
      groups.set(key, {
        name: (schema && schema.name) || 'Sem camada',
        color: (schema && schema.baseColor) || DEFAULT_COLOR,
        items: []
      });
    }
    groups.get(key).items.push(it);
  });
  const ordered = [];
  (layerOrder || []).forEach(id=>{
    if(groups.has(id)){ ordered.push(groups.get(id)); groups.delete(id); }
  });
  groups.forEach(g=>ordered.push(g)); // sobras (ex: "sem camada")
  return ordered;
}

// renderiza uma lista <ul id="..."> agrupada por camada. `options` define
// o tipo de input (checkbox/radio), o nome do grupo radio (se aplicável),
// se cada item está marcado, e o callback ao alterar.
function renderAnalysisGroupedList(list, items, options){
  if(!list) return;
  list.innerHTML = '';
  if(!items.length){
    const empty = document.createElement('li');
    empty.className = 'analysis-geom-empty';
    empty.textContent = 'Sem geometrias disponíveis.';
    list.appendChild(empty);
    return;
  }
  const groups = groupAnalysisItemsByLayer(items);
  groups.forEach(group=>{
    const groupLi = document.createElement('li');
    groupLi.className = 'analysis-geom-group';

    const header = document.createElement('div');
    header.className = 'analysis-geom-group-header';
    const swatch = document.createElement('span');
    swatch.className = 'analysis-geom-group-swatch';
    swatch.style.background = group.color;
    const name = document.createElement('span');
    name.className = 'analysis-geom-group-name';
    name.textContent = group.name;
    name.title = group.name;
    const count = document.createElement('span');
    count.className = 'analysis-geom-group-count';
    count.textContent = group.items.length;
    header.append(swatch, name, count);
    groupLi.appendChild(header);

    const innerUl = document.createElement('ul');
    innerUl.className = 'analysis-geom-group-items';
    group.items.forEach(it=>{
      const li = document.createElement('li');
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = options.inputType;
      if(options.radioName) input.name = options.radioName;
      input.dataset.id = it.id;
      input.checked = !!options.isChecked(it);
      const span = document.createElement('span');
      span.className = 'analysis-geom-name';
      span.textContent = it.label;
      label.append(input, span);
      li.appendChild(label);
      input.addEventListener('change', e=>{ options.onChange(it, e.target.checked); });
      innerUl.appendChild(li);
    });
    groupLi.appendChild(innerUl);
    list.appendChild(groupLi);
  });
}

// aplica a classe visual (sucesso/aviso) às mensagens de estado das 4
// ferramentas, consoante o prefixo já usado no texto (✓ / ⚠). Não altera
// quando nem o que cada ferramenta escreve, só o estilo do resultado.
function styleAnalysisStatusEl(el){
  if(!el) return;
  el.classList.remove('is-ok', 'is-warn');
  const t = el.textContent || '';
  if(t.startsWith('✓')) el.classList.add('is-ok');
  else if(t.startsWith('⚠')) el.classList.add('is-warn');
}
['buffer-status','intersect-status','union-status','difference-status'].forEach(id=>{
  const el = document.getElementById(id);
  if(!el) return;
  const obs = new MutationObserver(()=>styleAnalysisStatusEl(el));
  obs.observe(el, {childList:true, characterData:true, subtree:true});
});

function openAnalysisPanel(){
  if(featuresData.size === 0){
    alert('Ainda não desenhaste nenhuma geometria para analisar. Desenha pelo menos uma antes de abrir a análise espacial.');
    return;
  }
  document.getElementById('analysis-overlay').classList.add('open');
  if(!analysisMap){
    initAnalysisMap();
  } else {
    syncAnalysisSourceLayer();
  }
  renderAnalysisGeomList();
  renderCheckboxGeomList('analysis-geom-list-intersect', intersectSelection);
  renderCheckboxGeomList('analysis-geom-list-union', unionSelection);
  renderDiffLists();
  setTimeout(()=>{ if(analysisMap) analysisMap.invalidateSize(); }, 480);
}

function closeAnalysisPanel(){
  document.getElementById('analysis-overlay').classList.remove('open');
}

document.getElementById('btn-open-analysis').addEventListener('click', openAnalysisPanel);

/* ============================================================
   LIMITES DE MUNICÍPIO (CAOP preview via GitHub raw)
   ============================================================ */
let municipioBoundariesGroup = null;
const municipioLayers = new Map(); // chave "Município|Distrito" -> {layer, entry}

function normalizeAccents(s){
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function getBoundaryColor(){
  return '#2D6FE0';
}

function openMunicipiosPanel(){
  document.getElementById('municipios-panel').classList.remove('hidden');
  const search = document.getElementById('municipios-search');
  search.value = '';
  document.getElementById('municipios-results').innerHTML = '';
  document.getElementById('municipios-status').textContent = '';
  search.focus();
}

function closeMunicipiosPanel(){
  document.getElementById('municipios-panel').classList.add('hidden');
}

document.getElementById('btn-open-municipios').addEventListener('click', e=>{
  e.stopPropagation();
  const panel = document.getElementById('municipios-panel');
  if(panel.classList.contains('hidden')) openMunicipiosPanel();
  else closeMunicipiosPanel();
});
document.getElementById('municipios-panel-close').addEventListener('click', closeMunicipiosPanel);
document.getElementById('municipios-panel').addEventListener('click', e=> e.stopPropagation());
document.addEventListener('click', ()=> closeMunicipiosPanel());
document.addEventListener('keydown', e=>{
  if(e.key === 'Escape') closeMunicipiosPanel();
});

document.getElementById('municipios-search').addEventListener('input', e=>{
  const q = normalizeAccents(e.target.value.trim());
  const resultsEl = document.getElementById('municipios-results');
  resultsEl.innerHTML = '';
  if(q.length === 0) return;

  const matches = MUNICIPIOS_INDEX
    .filter(it => normalizeAccents(it.m).includes(q))
    .slice(0, 8);

  if(matches.length === 0){
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.innerHTML = `<span>Nenhum município encontrado.</span>`;
    resultsEl.appendChild(li);
    return;
  }

  matches.forEach(it=>{
    const li = document.createElement('li');
    li.innerHTML = `<span>${it.m}</span><span class="distrito">${it.d}</span>`;
    li.addEventListener('click', ()=> loadMunicipioBoundary(it));
    resultsEl.appendChild(li);
  });
});

async function loadMunicipioBoundary(entry){
  const statusEl = document.getElementById('municipios-status');
  const key = entry.m + '|' + entry.d;

  if(municipioLayers.has(key)){
    try{ map.fitBounds(municipioLayers.get(key).layer.getBounds(), {padding:[30,30]}); }catch(err){ /* ignora */ }
    return;
  }

  if(!municipioBoundariesGroup){ municipioBoundariesGroup = L.layerGroup().addTo(map); }

  statusEl.textContent = `A carregar ${entry.m}…`;
  try{
    const res = await fetch(MUNICIPIOS_GITHUB_RAW_BASE + entry.p);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const gj = await res.json();

    const layer = L.geoJSON(gj, {
      style: ()=>({color:getBoundaryColor(), weight:4, opacity:1, fill:false}),
      onEachFeature: (feature, lyr)=>{
        lyr.bindTooltip(entry.m, {permanent:true, direction:'center', className:'geom-label-tooltip', opacity:.85});
      }
    }).addTo(municipioBoundariesGroup);

    municipioLayers.set(key, {layer, entry});
    try{ map.fitBounds(layer.getBounds(), {padding:[30,30]}); }catch(err){ /* bounds inválidos, ignora */ }

    document.getElementById('municipios-search').value = '';
    document.getElementById('municipios-results').innerHTML = '';
    statusEl.textContent = '';
    renderLoadedMunicipiosList();
  }catch(err){
    console.error('Erro ao carregar limite de município:', err);
    statusEl.textContent = `⚠ Não foi possível carregar o limite de ${entry.m}.`;
  }
}

function removeMunicipioBoundary(key){
  const entryData = municipioLayers.get(key);
  if(!entryData) return;
  municipioBoundariesGroup.removeLayer(entryData.layer);
  municipioLayers.delete(key);
  renderLoadedMunicipiosList();
}

function renderLoadedMunicipiosList(){
  const list = document.getElementById('municipios-loaded-list');
  const emptyMsg = document.getElementById('municipios-empty-msg');
  list.innerHTML = '';

  if(municipioLayers.size === 0){
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  municipioLayers.forEach((data, key)=>{
    const li = document.createElement('li');
    li.innerHTML = `<span>${data.entry.m}</span>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Remover';
    btn.setAttribute('aria-label', 'Remover ' + data.entry.m);
    btn.textContent = '✕';
    btn.addEventListener('click', ()=> removeMunicipioBoundary(key));
    li.appendChild(btn);
    li.addEventListener('click', (e)=>{
      if(e.target === btn) return;
      try{ map.fitBounds(data.layer.getBounds(), {padding:[30,30]}); }catch(err){ /* ignora */ }
    });
    list.appendChild(li);
  });
}
document.getElementById('analysis-close').addEventListener('click', closeAnalysisPanel);

document.querySelectorAll('.tool-drawer-header[data-drawer-toggle]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    btn.closest('.tool-drawer').classList.toggle('open');
  });
});

function initAnalysisMap(){
  analysisMap = L.map('analysis-map', {zoomControl:true, attributionControl:false, maxZoom: 24});
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:24, maxNativeZoom:19
  }).addTo(analysisMap);

  analysisSourceLayer = L.geoJSON(null, {
    pointToLayer:(f, latlng)=> L.circleMarker(latlng, {radius:6, color:DEFAULT_COLOR, weight:2, fillColor:DEFAULT_COLOR, fillOpacity:.85}),
    style: ()=>({color:DEFAULT_COLOR, weight:3, fillColor:DEFAULT_COLOR, fillOpacity:.2}),
    onEachFeature: (feature, layer)=>{
      const t = feature.geometry && feature.geometry.type;
      if(t !== 'LineString' && t !== 'MultiLineString' && t !== 'Polygon' && t !== 'MultiPolygon') return;
      const label = feature.properties && feature.properties._origem;
      if(!label) return;
      layer.bindTooltip(label, {
        permanent: true,
        direction: 'center',
        className: 'geom-label-tooltip',
        opacity: .85
      });
    }
  }).addTo(analysisMap);

  bufferLayerGroup = L.layerGroup().addTo(analysisMap);
  intersectLayerGroup = L.layerGroup().addTo(analysisMap);
  unionLayerGroup = L.layerGroup().addTo(analysisMap);
  differenceLayerGroup = L.layerGroup().addTo(analysisMap);

  syncAnalysisSourceLayer();

  // sliders de distância (range + número sincronizados)
  const rangeEl = document.getElementById('buffer-distance-range');
  const numEl = document.getElementById('buffer-distance-number');
  rangeEl.addEventListener('input', ()=>{
    numEl.value = rangeEl.value;
    scheduleBufferUpdate();
  });
  numEl.addEventListener('input', ()=>{
    const v = Number(numEl.value);
    if(Number.isNaN(v) || v < 0) return;
    if(v > Number(rangeEl.max)) rangeEl.max = v; // estica o slider se o utilizador escrever um valor maior
    rangeEl.value = v;
    scheduleBufferUpdate();
  });

  document.getElementById('btn-apply-buffer').addEventListener('click', applyBuffer);
  document.getElementById('btn-clear-buffer').addEventListener('click', ()=>{
    bufferLayerGroup.clearLayers();
    lastBufferFeatures = [];
    const statusEl = document.getElementById('buffer-status');
    if(statusEl) statusEl.textContent = '';
  });

  document.getElementById('btn-export-buffer-geojson').addEventListener('click', ()=>{
    if(lastBufferFeatures.length === 0){ alert('Gera primeiro um buffer para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastBufferFeatures}, 'engenh_buffer.geojson');
  });
  document.getElementById('btn-export-buffer-shp').addEventListener('click', async ()=>{
    if(lastBufferFeatures.length === 0){ alert('Gera primeiro um buffer para poderes exportar.'); return; }
    const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastBufferFeatures}, 'EPSG:3763');
    await exportShapefileZip(
      gj,
      'engenh_buffer',
      document.getElementById('btn-export-buffer-shp'),
      PTTM06_WKT
    );
  });

  // ---- intersect ----
  document.getElementById('btn-run-intersect').addEventListener('click', runIntersect);
  document.getElementById('btn-clear-intersect').addEventListener('click', ()=>{
    intersectLayerGroup.clearLayers();
    lastIntersectFeatures = [];
    document.getElementById('intersect-status').textContent = '';
  });
  document.getElementById('btn-export-intersect-geojson').addEventListener('click', ()=>{
    if(lastIntersectFeatures.length === 0){ alert('Gera primeiro uma interseção para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastIntersectFeatures}, 'engenh_intersect.geojson');
  });
  document.getElementById('btn-export-intersect-shp').addEventListener('click', async ()=>{
    if(lastIntersectFeatures.length === 0){ alert('Gera primeiro uma interseção para poderes exportar.'); return; }
    const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastIntersectFeatures}, 'EPSG:3763');
    await exportShapefileZip(
      gj,
      'engenh_intersect',
      document.getElementById('btn-export-intersect-shp'),
      PTTM06_WKT
    );
  });

  // ---- union ----
  document.getElementById('btn-run-union').addEventListener('click', runUnion);
  document.getElementById('btn-clear-union').addEventListener('click', ()=>{
    unionLayerGroup.clearLayers();
    lastUnionFeatures = [];
    document.getElementById('union-status').textContent = '';
  });
  document.getElementById('btn-export-union-geojson').addEventListener('click', ()=>{
    if(lastUnionFeatures.length === 0){ alert('Gera primeiro uma união para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastUnionFeatures}, 'engenh_union.geojson');
  });
  document.getElementById('btn-export-union-shp').addEventListener('click', async ()=>{
    if(lastUnionFeatures.length === 0){ alert('Gera primeiro uma união para poderes exportar.'); return; }
    const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastUnionFeatures}, 'EPSG:3763');
    await exportShapefileZip(
      gj,
      'engenh_union',
      document.getElementById('btn-export-union-shp'),
      PTTM06_WKT
    );
  });

  // ---- difference ----
  document.getElementById('btn-run-difference').addEventListener('click', runDifference);
  document.getElementById('btn-clear-difference').addEventListener('click', ()=>{
    differenceLayerGroup.clearLayers();
    lastDifferenceFeatures = [];
    document.getElementById('difference-status').textContent = '';
  });
  document.getElementById('btn-export-difference-geojson').addEventListener('click', ()=>{
    if(lastDifferenceFeatures.length === 0){ alert('Gera primeiro uma diferença para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastDifferenceFeatures}, 'engenh_difference.geojson');
  });
  document.getElementById('btn-export-difference-shp').addEventListener('click', async ()=>{
    if(lastDifferenceFeatures.length === 0){ alert('Gera primeiro uma diferença para poderes exportar.'); return; }
    const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastDifferenceFeatures}, 'EPSG:3763');
    await exportShapefileZip(
      gj,
      'engenh_difference',
      document.getElementById('btn-export-difference-shp'),
      PTTM06_WKT
    );
  });
}

function syncAnalysisSourceLayer(){
  analysisSourceLayer.clearLayers();
  const items = buildAnalysisFeatureList();
  items.forEach(it => analysisSourceLayer.addData(it.geojson));
  if(items.length){
    try{ analysisMap.fitBounds(analysisSourceLayer.getBounds(), {padding:[30,30], maxZoom:17}); }
    catch(err){ /* uma única geometria muito pequena pode não ter bounds válidos */ }
  }
}

function renderAnalysisGeomList(){
  const list = document.getElementById('analysis-geom-list');
  const items = buildAnalysisFeatureList();

  // por defeito, qualquer geometria nova entra selecionada; remove as que já não existem
  items.forEach(it => analysisSelection.add(it.id));
  [...analysisSelection].forEach(id=>{
    if(!items.find(it=>it.id===id)) analysisSelection.delete(id);
  });

  renderAnalysisGroupedList(list, items, {
    inputType: 'checkbox',
    isChecked: it => analysisSelection.has(it.id),
    onChange: (it, checked)=>{
      if(checked) analysisSelection.add(it.id);
      else analysisSelection.delete(it.id);
      scheduleBufferUpdate();
    }
  });
}

// lista genérica de checkboxes, reutilizada por intersect e union
function renderCheckboxGeomList(listId, selectionSet){
  const list = document.getElementById(listId);
  if(!list) return;
  const items = buildAnalysisFeatureList();

  items.forEach(it => selectionSet.add(it.id));
  [...selectionSet].forEach(id=>{
    if(!items.find(it=>it.id===id)) selectionSet.delete(id);
  });

  renderAnalysisGroupedList(list, items, {
    inputType: 'checkbox',
    isChecked: it => selectionSet.has(it.id),
    onChange: (it, checked)=>{
      if(checked) selectionSet.add(it.id);
      else selectionSet.delete(it.id);
    }
  });
}

// listas da ferramenta difference: uma geometria base (radio) + várias a subtrair (checkboxes)
function renderDiffLists(){
  const items = buildAnalysisFeatureList();

  if(!diffBaseId || !items.find(it=>it.id === diffBaseId)){
    diffBaseId = items.length ? items[0].id : null;
  }
  [...diffSubtractSelection].forEach(id=>{
    if(!items.find(it=>it.id===id) || id===diffBaseId) diffSubtractSelection.delete(id);
  });

  const baseList = document.getElementById('analysis-geom-list-diff-base');
  if(baseList){
    renderAnalysisGroupedList(baseList, items, {
      inputType: 'radio',
      radioName: 'diff-base',
      isChecked: it => diffBaseId === it.id,
      onChange: (it)=>{
        diffBaseId = it.id;
        diffSubtractSelection.delete(it.id);
        renderDiffLists();
      }
    });
  }

  const subList = document.getElementById('analysis-geom-list-diff-subtract');
  if(subList){
    const subItems = items.filter(it => it.id !== diffBaseId);
    renderAnalysisGroupedList(subList, subItems, {
      inputType: 'checkbox',
      isChecked: it => diffSubtractSelection.has(it.id),
      onChange: (it, checked)=>{
        if(checked) diffSubtractSelection.add(it.id);
        else diffSubtractSelection.delete(it.id);
      }
    });
  }
}

function isPolygonal(geojson){
  const t = geojson && geojson.geometry && geojson.geometry.type;
  return t === 'Polygon' || t === 'MultiPolygon';
}

function runIntersect(){
  const statusEl = document.getElementById('intersect-status');
  if(typeof turf === 'undefined'){ statusEl.textContent = '⚠ A biblioteca Turf.js não carregou.'; return; }
  intersectLayerGroup.clearLayers();
  lastIntersectFeatures = [];

  const items = buildAnalysisFeatureList().filter(it => intersectSelection.has(it.id));
  const polyItems = items.filter(it => isPolygonal(it.geojson));

  if(items.length < 2){ statusEl.textContent = 'Seleciona pelo menos 2 geometrias à esquerda.'; return; }
  if(polyItems.length < 2){ statusEl.textContent = '⚠ A interseção só funciona com polígonos (mín. 2 selecionados).'; return; }

  let result = polyItems[0].geojson;
  for(let i=1; i<polyItems.length; i++){
    try{ result = turf.intersect(result, polyItems[i].geojson); }
    catch(err){ console.error('Erro ao intersetar', err); result = null; }
    if(!result) break;
  }

  if(!result){ statusEl.textContent = '⚠ Estas geometrias não se intersetam entre si.'; return; }

  result.properties = {...result.properties, origem: 'intersect', geometrias: polyItems.map(it=>it.label).join(' + ')};
  lastIntersectFeatures = [result];

  const layer = L.geoJSON(result, {
    style: ()=>({color:getHighlightColor(), weight:2, dashArray:'6 4', fillColor:ensureResultHatchPattern(), fillOpacity:.55})
  }).addTo(intersectLayerGroup);
  try{ analysisMap.fitBounds(layer.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }

  statusEl.textContent = `✓ Interseção gerada a partir de ${polyItems.length} geometria(s).`;
}

function runUnion(){
  const statusEl = document.getElementById('union-status');
  if(typeof turf === 'undefined'){ statusEl.textContent = '⚠ A biblioteca Turf.js não carregou.'; return; }
  unionLayerGroup.clearLayers();
  lastUnionFeatures = [];

  const items = buildAnalysisFeatureList().filter(it => unionSelection.has(it.id));
  const polyItems = items.filter(it => isPolygonal(it.geojson));

  if(items.length < 2){ statusEl.textContent = 'Seleciona pelo menos 2 geometrias à esquerda.'; return; }
  if(polyItems.length < 2){ statusEl.textContent = '⚠ A união só funciona com polígonos (mín. 2 selecionados).'; return; }

  let result = polyItems[0].geojson;
  for(let i=1; i<polyItems.length; i++){
    try{ result = turf.union(result, polyItems[i].geojson); }
    catch(err){ console.error('Erro ao unir', err); }
  }

  if(!result){ statusEl.textContent = '⚠ Não foi possível unir estas geometrias.'; return; }

  result.properties = {...result.properties, origem: 'union', geometrias: polyItems.map(it=>it.label).join(' + ')};
  lastUnionFeatures = [result];

  const layer = L.geoJSON(result, {
    style: ()=>({color:getHighlightColor(), weight:2, dashArray:'6 4', fillColor:ensureResultHatchPattern(), fillOpacity:.55})
  }).addTo(unionLayerGroup);
  try{ analysisMap.fitBounds(layer.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }

  statusEl.textContent = `✓ União gerada a partir de ${polyItems.length} geometria(s).`;
}

function runDifference(){
  const statusEl = document.getElementById('difference-status');
  if(typeof turf === 'undefined'){ statusEl.textContent = '⚠ A biblioteca Turf.js não carregou.'; return; }
  differenceLayerGroup.clearLayers();
  lastDifferenceFeatures = [];

  const items = buildAnalysisFeatureList();
  const base = items.find(it => it.id === diffBaseId);

  if(!base){ statusEl.textContent = 'Escolhe uma geometria base à esquerda.'; return; }
  if(!isPolygonal(base.geojson)){ statusEl.textContent = '⚠ A geometria base tem de ser um polígono.'; return; }

  const subtractItems = items.filter(it => diffSubtractSelection.has(it.id) && it.id !== diffBaseId && isPolygonal(it.geojson));
  if(subtractItems.length === 0){ statusEl.textContent = 'Seleciona pelo menos uma geometria a subtrair.'; return; }

  let result = base.geojson;
  for(const it of subtractItems){
    try{ result = turf.difference(result, it.geojson); }
    catch(err){ console.error('Erro ao subtrair', err); result = null; }
    if(!result) break;
  }

  if(!result){ statusEl.textContent = '⚠ Resultado vazio: a subtração cobre toda a geometria base.'; return; }

  result.properties = {...result.properties, origem: 'difference', base: base.label, subtraidas: subtractItems.map(it=>it.label).join(' + ')};
  lastDifferenceFeatures = [result];

  const layer = L.geoJSON(result, {
    style: ()=>({color:getHighlightColor(), weight:2, dashArray:'6 4', fillColor:ensureResultHatchPattern(), fillOpacity:.55})
  }).addTo(differenceLayerGroup);
  try{ analysisMap.fitBounds(layer.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }

  statusEl.textContent = `✓ Diferença gerada: ${base.label} − ${subtractItems.length} geometria(s).`;
}

function scheduleBufferUpdate(){
  clearTimeout(bufferDebounceTimer);
  bufferDebounceTimer = setTimeout(applyBuffer, 120);
}

function applyBuffer(){
  const statusEl = document.getElementById('buffer-status');
  if(typeof turf === 'undefined'){
    if(statusEl) statusEl.textContent = '⚠ A biblioteca Turf.js não carregou.';
    return;
  }
  bufferLayerGroup.clearLayers();
  lastBufferFeatures = [];

  const distance = Number(document.getElementById('buffer-distance-range').value);
  const items = buildAnalysisFeatureList().filter(it => analysisSelection.has(it.id));

  if(items.length === 0){
    if(statusEl) statusEl.textContent = 'Seleciona pelo menos uma geometria à esquerda.';
    return;
  }
  if(distance <= 0){
    if(statusEl) statusEl.textContent = 'Define uma distância maior que 0 m.';
    return;
  }

  items.forEach(it=>{
    try{
      const buffered = turf.buffer(it.geojson, distance, {units:'meters'});
      if(!buffered) return;
      buffered.properties = {...buffered.properties, origem: it.label, distancia_m: distance};
      lastBufferFeatures.push(buffered);
    }catch(err){
      console.error('Erro ao gerar buffer para', it.label, err);
    }
  });

  if(lastBufferFeatures.length === 0){
    if(statusEl) statusEl.textContent = '⚠ Não foi possível gerar o buffer para estas geometrias.';
    return;
  }

  const bufferGeoLayer = L.geoJSON({type:'FeatureCollection', features:lastBufferFeatures}, {
    style: ()=>({color:getHighlightColor(), weight:2, dashArray:'6 4', fillColor:ensureResultHatchPattern(), fillOpacity:.55})
  }).addTo(bufferLayerGroup);

  // ajusta sempre o zoom ao resultado: um buffer pequeno sobre uma geometria
  // grande pode ficar impercetível se o mapa ficar no enquadramento anterior
  try{ analysisMap.fitBounds(bufferGeoLayer.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }

  if(statusEl) statusEl.textContent = `✓ Buffer gerado: ${items.length} geometria(s), ${distance} m`;
}
