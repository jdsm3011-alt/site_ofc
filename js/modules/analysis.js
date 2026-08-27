/* === MÓDULO: ANÁLISE ESPACIAL === */
/* Buffer, intersect, union, difference — state, helpers,
   analysis panel (open/close/init), analysis map, render lists,
   run operations, schedule/apply buffer */
/* Origem: 05-app-main.js linhas 4903-5587 */
(function(){
/* ============================================================
   ANÁLISE ESPACIAL — BUFFER
   ============================================================ */
let analysisMap = null;
let analysisSourceLayer = null;
let bufferLayerGroup = null;
let analysisSelection = new Set();   // ids (L.Util.stamp) das geometrias incluídas no buffer
window.lastBufferFeatures = window.lastBufferFeatures || [];  // resultado do último buffer gerado, para exportação
let bufferDebounceTimer = null;
let _analysisFeatureCache = null;   // cache de buildAnalysisFeatureList (invalidado a cada build)
let _analysisFeatureCacheVersion = 0;
let activeAnalysisTool = null;

// ---------- overlay: intersect / union / difference ----------
let intersectLayerGroup = null, unionLayerGroup = null, differenceLayerGroup = null;
let intersectSelection = new Set();
let unionSelection = new Set();
let diffBaseId = null;
let diffSubtractSelection = new Set();
window.lastIntersectFeatures = window.lastIntersectFeatures || [];
window.lastUnionFeatures = window.lastUnionFeatures || [];
window.lastDifferenceFeatures = window.lastDifferenceFeatures || [];

function buildAnalysisFeatureList(){
  if(_analysisFeatureCache) return _analysisFeatureCache;
  const arr = [];
  featuresData.forEach(entry=>{
    const gj = entry.layer.toGeoJSON();
    gj.properties = {...entry.props, _origem: entry.label};
    arr.push({id: entry.id, label: entry.label, geojson: gj, layerId: entry.layerId});
  });
  _analysisFeatureCache = arr;
  return arr;
}

function invalidateAnalysisCache(){
  _analysisFeatureCache = null;
}

function getAnalysisLayerRecords(){
  const records = [];
  const seen = new Set();
  const add = (id, schema)=>{
    if(id == null || seen.has(id) || !schema || !countLayerFeatures(id)) return;
    seen.add(id);
    records.push({id, name: schema.name || 'Camada sem nome', schema});
  };
  (layerOrder || []).forEach(id => add(id, getLayerSchema(id)));
  (layers || []).forEach(rec => add(rec.id, rec));
  if(typeof config !== 'undefined' && config.geometryType){
    add(activeLayerId, getLayerSchema(activeLayerId));
  }
  return records;
}

function setAnalysisLayerOptions(select, records, placeholder){
  if(!select) return;
  const previous = select.value;
  select.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  records.forEach(rec=>{
    const option = document.createElement('option');
    option.value = rec.id;
    option.textContent = rec.name;
    select.appendChild(option);
  });
  if(records.some(rec => String(rec.id) === previous)) select.value = previous;
}

function renderAnalysisLayerControls(){
  const records = getAnalysisLayerRecords();
  const bufferSelect = document.getElementById('buffer-layer-select');
  const previousBuffer = bufferSelect && bufferSelect.value;
  setAnalysisLayerOptions(bufferSelect, records, 'Seleciona uma camada');
  if(bufferSelect && !bufferSelect.value && records.length){
    bufferSelect.value = previousBuffer || String(activeLayerId);
    if(!bufferSelect.value || !records.some(rec => String(rec.id) === bufferSelect.value)) bufferSelect.value = String(records[0].id);
  }
  updateBufferAttributeOptions();
  const bufferOutput = document.getElementById('buffer-output-name');
  const bufferSchema = bufferSelect && bufferSelect.value ? getLayerSchema(Number(bufferSelect.value)) : null;
  if(bufferOutput && bufferOutput.dataset.edited !== 'true' && bufferSchema){
    bufferOutput.value = `${bufferSchema.name}_buffer`;
  }

  setAnalysisLayerOptions(document.getElementById('intersect-layer-a'), records, 'Seleciona uma camada');
  setAnalysisLayerOptions(document.getElementById('intersect-layer-b'), records, 'Seleciona uma camada');
  const selectA = document.getElementById('intersect-layer-a');
  const selectB = document.getElementById('intersect-layer-b');
  if(selectA && !selectA.value && records.length) selectA.value = String(records[0].id);
  if(selectB && !selectB.value && records.length > 1) selectB.value = String(records[1].id);
  const output = document.getElementById('intersect-output-name');
  if(output && !output.value && selectA && selectB && selectA.value && selectB.value){
    const a = records.find(rec => String(rec.id) === selectA.value);
    const b = records.find(rec => String(rec.id) === selectB.value);
    output.value = `${a ? a.name : 'camada'}_${b ? b.name : 'camada'}_intersect`;
  }
}

function updateBufferAttributeOptions(){
  const layerSelect = document.getElementById('buffer-layer-select');
  const attributeSelect = document.getElementById('buffer-attribute-select');
  if(!layerSelect || !attributeSelect) return;
  const schema = getLayerSchema(Number(layerSelect.value));
  const names = new Set((schema && schema.attributes || []).map(attr => attr.name));
  buildAnalysisFeatureList().filter(it => it.layerId === Number(layerSelect.value)).forEach(it=>{
    Object.keys(it.geojson.properties || {}).forEach(name=>{ if(!name.startsWith('_')) names.add(name); });
  });
  const previous = attributeSelect.value;
  attributeSelect.innerHTML = '<option value="">Manter todos os atributos</option>';
  [...names].sort().forEach(name=>{
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    attributeSelect.appendChild(option);
  });
  if(names.has(previous)) attributeSelect.value = previous;
}

function createAnalysisLayer(features, name){
  if(typeof pbCreateLayerFromFeatureCollection !== 'function') throw new Error('A API de criação de camadas não está disponível.');
  const result = pbCreateLayerFromFeatureCollection({type:'FeatureCollection', features}, name);
  invalidateAnalysisCache();
  renderAnalysisLayerControls();
  return result;
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

  if(!list._delegated){
    list._delegated = true;
    list.addEventListener('change', (e)=>{
      const input = e.target.closest('input[data-id]');
      if(!input) return;
      const id = Number(input.dataset.id);
      const opts = list._analysisOptions;
      const currentItems = list._analysisItems;
      if(!opts || !currentItems) return;
      const item = currentItems.find(it=>it.id === id);
      if(item) opts.onChange(item, input.checked);
    });
  }
  list._analysisOptions = options;
  list._analysisItems = items;

  const groups = groupAnalysisItemsByLayer(items);
  const frag = document.createDocumentFragment();
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
      innerUl.appendChild(li);
    });
    groupLi.appendChild(innerUl);
    frag.appendChild(groupLi);
  });
  list.appendChild(frag);
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

function openAnalysisPanel(tool){
  _analysisFeatureCache = null; // invalida cache antes de usar
  const overlay = document.getElementById('analysis-overlay');
  if(!overlay) return;
  const selectedTool = tool || 'buffer';
  activeAnalysisTool = selectedTool;
  const toolLabels = {buffer:'Buffer', intersect:'Intersect', union:'Union', difference:'Clip'};
  const toolDescriptions = {
    buffer: 'Criar uma camada a partir de uma distância',
    intersect: 'Criar uma camada com a área comum',
    union: 'Unir geometrias numa nova camada',
    difference: 'Recortar uma geometria com outra'
  };
  const title = document.getElementById('analysis-title-text');
  const subtitle = document.getElementById('analysis-subtitle-text');
  if(title) title.textContent = toolLabels[selectedTool] || selectedTool;
  if(subtitle) subtitle.textContent = toolDescriptions[selectedTool] || '';
  document.querySelectorAll('#analysis-overlay .tool-drawer').forEach(drawer=>{
    const active = drawer.dataset.tool === selectedTool;
    drawer.hidden = !active;
    drawer.classList.toggle('open', active);
  });
  overlay.classList.add('open');
  const button = document.getElementById('btn-open-analysis');
  if(button){ button.setAttribute('aria-expanded', 'true'); }
  if(!analysisMap){
    initAnalysisMap();
  } else {
    syncAnalysisSourceLayer();
  }
  setAnalysisLabelsVisible(selectedTool !== 'buffer');
  renderAnalysisLayerControls();
  renderCheckboxGeomList('analysis-geom-list-union', unionSelection);
  renderDiffLists();
}

function closeAnalysisPanel(){
  const overlay = document.getElementById('analysis-overlay');
  if(!overlay) return;
  overlay.classList.remove('open');
  const button = document.getElementById('btn-open-analysis');
  if(button){ button.setAttribute('aria-expanded', 'false'); }
  if(activeAnalysisTool === 'buffer') setAnalysisLabelsVisible(false);
  activeAnalysisTool = null;
}

function openAnalysisToolsMenu(){
  const menu = document.getElementById('analysis-tools-menu');
  const button = document.getElementById('btn-open-analysis');
  if(!menu || !button) return;
  const rect = button.getBoundingClientRect();
  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8))}px`;
  button.setAttribute('aria-expanded', 'true');
}

function closeAnalysisToolsMenu(){
  const menu = document.getElementById('analysis-tools-menu');
  const button = document.getElementById('btn-open-analysis');
  if(menu) menu.hidden = true;
  if(button) button.setAttribute('aria-expanded', 'false');
}

function bindAnalysisButton(){
  const analysisButton = document.getElementById('btn-open-analysis');
  const toolsMenu = document.getElementById('analysis-tools-menu');
  if(!analysisButton){
    console.warn('[Analysis] btn-open-analysis not found yet.');
    return;
  }
  analysisButton.addEventListener('click', function(e){
    e.stopPropagation();
    const menu = document.getElementById('analysis-tools-menu');
    if(menu && menu.hidden) openAnalysisToolsMenu();
    else closeAnalysisToolsMenu();
  });
  if(toolsMenu){
    toolsMenu.querySelectorAll('[data-analysis-tool]').forEach(item=>{
      item.addEventListener('click', function(e){
        e.stopPropagation();
        closeAnalysisToolsMenu();
        openAnalysisPanel(item.dataset.analysisTool);
      });
    });
  }
}

if(document.readyState !== 'loading'){
  bindAnalysisButton();
} else {
  document.addEventListener('DOMContentLoaded', bindAnalysisButton);
}

document.addEventListener('click', function(e){
  const overlay = document.getElementById('analysis-overlay');
  const button = document.getElementById('btn-open-analysis');
  const menu = document.getElementById('analysis-tools-menu');
  if(menu && !menu.hidden && !menu.contains(e.target) && (!button || !button.contains(e.target))){
    closeAnalysisToolsMenu();
  }
  if(!overlay || !overlay.classList.contains('open') || !button) return;
  if(overlay.contains(e.target) || button.contains(e.target) || (menu && menu.contains(e.target))) return;
  closeAnalysisPanel();
});

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

const municipiosOpenButton = document.getElementById('btn-open-municipios');
if(municipiosOpenButton){
municipiosOpenButton.addEventListener('click', e=>{
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

let _municipioSearchTimer = null;
document.getElementById('municipios-search').addEventListener('input', e=>{
  clearTimeout(_municipioSearchTimer);
  const val = e.target.value;
  _municipioSearchTimer = setTimeout(()=>{
    const q = normalizeAccents(val.trim());
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
  }, 180);
});
}

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
  analysisMap = (typeof window !== 'undefined' && window.map) ? window.map : (typeof map !== 'undefined' ? map : null);
  if(!analysisMap){
    console.warn('[Analysis] Mapa principal não encontrado. Não é possível inicializar o painel de análise.');
    return;
  }

  if(!analysisSourceLayer){
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
  }

  bufferLayerGroup = bufferLayerGroup || L.layerGroup().addTo(analysisMap);
  intersectLayerGroup = intersectLayerGroup || L.layerGroup().addTo(analysisMap);
  unionLayerGroup = unionLayerGroup || L.layerGroup().addTo(analysisMap);
  differenceLayerGroup = differenceLayerGroup || L.layerGroup().addTo(analysisMap);

  syncAnalysisSourceLayer();
}

  // sliders de distância (range + número sincronizados)
  const rangeEl = document.getElementById('buffer-distance-range');
  const numEl = document.getElementById('buffer-distance-number');
  const bufferLayerSelect = document.getElementById('buffer-layer-select');
  const bufferOutputName = document.getElementById('buffer-output-name');
  const bufferDissolve = document.getElementById('buffer-dissolve');
  const intersectLayerA = document.getElementById('intersect-layer-a');
  const intersectLayerB = document.getElementById('intersect-layer-b');
  const intersectOutputName = document.getElementById('intersect-output-name');
  rangeEl.addEventListener('input', ()=>{
    numEl.value = rangeEl.value;
  });
  numEl.addEventListener('input', ()=>{
    const v = Number(numEl.value);
    if(Number.isNaN(v) || v < 0) return;
    if(v > Number(rangeEl.max)) rangeEl.max = v; // estica o slider se o utilizador escrever um valor maior
    rangeEl.value = v;
  });
  bufferLayerSelect.addEventListener('change', ()=>{
    updateBufferAttributeOptions();
    const schema = getLayerSchema(Number(bufferLayerSelect.value));
    if(bufferOutputName && bufferOutputName.dataset.edited !== 'true'){
      bufferOutputName.value = schema ? `${schema.name}_buffer` : '';
    }
  });
  bufferOutputName.addEventListener('input', ()=>{ bufferOutputName.dataset.edited = 'true'; });
  intersectLayerA.addEventListener('change', ()=>{
    if(intersectOutputName.dataset.edited === 'true') return;
    const a = getLayerSchema(Number(intersectLayerA.value));
    const b = getLayerSchema(Number(intersectLayerB.value));
    if(a && b) intersectOutputName.value = `${a.name}_${b.name}_intersect`;
  });
  intersectLayerB.addEventListener('change', ()=>{
    if(intersectOutputName.dataset.edited === 'true') return;
    const a = getLayerSchema(Number(intersectLayerA.value));
    const b = getLayerSchema(Number(intersectLayerB.value));
    if(a && b) intersectOutputName.value = `${a.name}_${b.name}_intersect`;
  });
  intersectOutputName.addEventListener('input', ()=>{ intersectOutputName.dataset.edited = 'true'; });

  document.getElementById('btn-apply-buffer').addEventListener('click', applyBuffer);

  // ---- intersect ----
  document.getElementById('btn-run-intersect').addEventListener('click', runIntersect);

  // ---- union ----
  document.getElementById('btn-run-union').addEventListener('click', runUnion);

  // ---- difference ----
  document.getElementById('btn-run-difference').addEventListener('click', runDifference);

function syncAnalysisSourceLayer(){
  analysisSourceLayer.clearLayers();
  const items = buildAnalysisFeatureList();
  if(items.length){
    analysisSourceLayer.addData({type:'FeatureCollection', features: items.map(it=>it.geojson)});
    try{ analysisMap.fitBounds(analysisSourceLayer.getBounds(), {padding:[30,30], maxZoom:17}); }
    catch(err){ /* uma única geometria muito pequena pode não ter bounds válidos */ }
  }
}

function setAnalysisLabelsVisible(visible){
  if(!analysisSourceLayer) return;
  if(!visible){
    analysisSourceLayer.eachLayer(layer=>layer.unbindTooltip());
    return;
  }
  syncAnalysisSourceLayer();
}

function renderAnalysisGeomList(){
  const list = document.getElementById('analysis-geom-list');
  const items = buildAnalysisFeatureList();
  const itemIds = new Set(items.map(it=>it.id));

  // por defeito, qualquer geometria nova entra selecionada; remove as que já não existem
  items.forEach(it => analysisSelection.add(it.id));
  [...analysisSelection].forEach(id=>{
    if(!itemIds.has(id)) analysisSelection.delete(id);
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
  const itemIds = new Set(items.map(it=>it.id));

  items.forEach(it => selectionSet.add(it.id));
  [...selectionSet].forEach(id=>{
    if(!itemIds.has(id)) selectionSet.delete(id);
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
  const itemIds = new Set(items.map(it=>it.id));

  if(!diffBaseId || !itemIds.has(diffBaseId)){
    diffBaseId = items.length ? items[0].id : null;
  }
  [...diffSubtractSelection].forEach(id=>{
    if(!itemIds.has(id) || id===diffBaseId) diffSubtractSelection.delete(id);
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

  const layerA = Number(document.getElementById('intersect-layer-a').value);
  const layerB = Number(document.getElementById('intersect-layer-b').value);
  const items = buildAnalysisFeatureList().filter(it => it.layerId === layerA || it.layerId === layerB);
  const polyItems = items.filter(it => isPolygonal(it.geojson));

  if(!layerA || !layerB || layerA === layerB){ statusEl.textContent = 'Seleciona duas camadas diferentes.'; return; }
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

  try{
    const outputName = document.getElementById('intersect-output-name').value.trim() || 'camada_intersect';
    createAnalysisLayer(lastIntersectFeatures, outputName);
    intersectLayerGroup.clearLayers();
    statusEl.textContent = `✓ Camada "${outputName}" criada com a interseção.`;
  }catch(err){
    console.error('[analysis-intersect]', err);
    statusEl.textContent = '⚠ A interseção foi calculada, mas não foi possível criar a camada.';
  }
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
  const layerId = Number(document.getElementById('buffer-layer-select').value);
  const attributeName = document.getElementById('buffer-attribute-select').value;
  const items = buildAnalysisFeatureList().filter(it => it.layerId === layerId);

  if(items.length === 0){
    if(statusEl) statusEl.textContent = 'Seleciona uma camada com geometrias.';
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
      if(attributeName && Object.prototype.hasOwnProperty.call(it.geojson.properties || {}, attributeName)){
        buffered.properties.atributo_buffer = it.geojson.properties[attributeName];
      }
      lastBufferFeatures.push(buffered);
    }catch(err){
      console.error('Erro ao gerar buffer para', it.label, err);
    }
  });

  if(bufferDissolve.checked && lastBufferFeatures.length > 1){
    let dissolved = lastBufferFeatures[0];
    for(let i=1; i<lastBufferFeatures.length; i++){
      try{
        const merged = turf.union(dissolved, lastBufferFeatures[i]);
        if(merged) dissolved = merged;
      }catch(err){
        console.error('Erro ao dissolver buffers', err);
      }
    }
    dissolved.properties = {
      ...dissolved.properties,
      origem: items.map(it=>it.label).join(' + '),
      distancia_m: distance,
      dissolvido: true
    };
    lastBufferFeatures = [dissolved];
  }

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

  try{
    const outputName = document.getElementById('buffer-output-name').value.trim() || `${getLayerSchema(layerId).name}_buffer`;
    createAnalysisLayer(lastBufferFeatures, outputName);
    bufferLayerGroup.clearLayers();
    if(statusEl) statusEl.textContent = `✓ Camada "${outputName}" criada com ${lastBufferFeatures.length} polígono(s).`;
  }catch(err){
    console.error('[analysis-buffer]', err);
    if(statusEl) statusEl.textContent = '⚠ O buffer foi calculado, mas não foi possível criar a camada.';
  }
}

/* --- exposição global --- */
window.invalidateAnalysisCache = invalidateAnalysisCache;
window.buildAnalysisFeatureList = buildAnalysisFeatureList;
window.groupAnalysisItemsByLayer = groupAnalysisItemsByLayer;
window.renderAnalysisGroupedList = renderAnalysisGroupedList;
window.styleAnalysisStatusEl = styleAnalysisStatusEl;
window.openAnalysisPanel = openAnalysisPanel;
window.closeAnalysisPanel = closeAnalysisPanel;
window.normalizeAccents = normalizeAccents;
window.getBoundaryColor = getBoundaryColor;
window.openMunicipiosPanel = openMunicipiosPanel;
window.closeMunicipiosPanel = closeMunicipiosPanel;
window.loadMunicipioBoundary = loadMunicipioBoundary;
window.removeMunicipioBoundary = removeMunicipioBoundary;
window.renderLoadedMunicipiosList = renderLoadedMunicipiosList;
window.initAnalysisMap = initAnalysisMap;
window.syncAnalysisSourceLayer = syncAnalysisSourceLayer;
window.renderAnalysisGeomList = renderAnalysisGeomList;
window.renderCheckboxGeomList = renderCheckboxGeomList;
window.renderDiffLists = renderDiffLists;
window.isPolygonal = isPolygonal;
window.runIntersect = runIntersect;
window.runUnion = runUnion;
window.runDifference = runDifference;
window.scheduleBufferUpdate = scheduleBufferUpdate;
window.applyBuffer = applyBuffer;
})();
