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
    showAppAlert('Ainda não desenhaste nenhuma geometria para analisar. Desenha pelo menos uma antes de abrir a análise espacial.');
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

document.getElementById('btn-open-analysis')?.addEventListener('click', openAnalysisPanel);

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
    if(lastBufferFeatures.length === 0){ showAppAlert('Gera primeiro um buffer para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastBufferFeatures}, 'engenh_buffer.geojson');
  });
  document.getElementById('btn-export-buffer-shp').addEventListener('click', async ()=>{
    try{
      if(lastBufferFeatures.length === 0){ showAppAlert('Gera primeiro um buffer para poderes exportar.'); return; }
      const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastBufferFeatures}, 'EPSG:3763');
      await exportShapefileZip(gj, 'engenh_buffer', document.getElementById('btn-export-buffer-shp'), PTTM06_WKT);
    }catch(err){
      console.error('[export-buffer-shp]', err);
      showAppAlert('Erro ao exportar buffer.', {error: true});
    }
  });

  // ---- intersect ----
  document.getElementById('btn-run-intersect').addEventListener('click', runIntersect);
  document.getElementById('btn-clear-intersect').addEventListener('click', ()=>{
    intersectLayerGroup.clearLayers();
    lastIntersectFeatures = [];
    document.getElementById('intersect-status').textContent = '';
  });
  document.getElementById('btn-export-intersect-geojson').addEventListener('click', ()=>{
    if(lastIntersectFeatures.length === 0){ showAppAlert('Gera primeiro uma interseção para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastIntersectFeatures}, 'engenh_intersect.geojson');
  });
  document.getElementById('btn-export-intersect-shp').addEventListener('click', async ()=>{
    try{
      if(lastIntersectFeatures.length === 0){ showAppAlert('Gera primeiro uma interseção para poderes exportar.'); return; }
      const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastIntersectFeatures}, 'EPSG:3763');
      await exportShapefileZip(gj, 'engenh_intersect', document.getElementById('btn-export-intersect-shp'), PTTM06_WKT);
    }catch(err){
      console.error('[export-intersect-shp]', err);
      showAppAlert('Erro ao exportar interseção.', {error: true});
    }
  });

  // ---- union ----
  document.getElementById('btn-run-union').addEventListener('click', runUnion);
  document.getElementById('btn-clear-union').addEventListener('click', ()=>{
    unionLayerGroup.clearLayers();
    lastUnionFeatures = [];
    document.getElementById('union-status').textContent = '';
  });
  document.getElementById('btn-export-union-geojson').addEventListener('click', ()=>{
    if(lastUnionFeatures.length === 0){ showAppAlert('Gera primeiro uma união para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastUnionFeatures}, 'engenh_union.geojson');
  });
  document.getElementById('btn-export-union-shp').addEventListener('click', async ()=>{
    try{
      if(lastUnionFeatures.length === 0){ showAppAlert('Gera primeiro uma união para poderes exportar.'); return; }
      const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastUnionFeatures}, 'EPSG:3763');
      await exportShapefileZip(gj, 'engenh_union', document.getElementById('btn-export-union-shp'), PTTM06_WKT);
    }catch(err){
      console.error('[export-union-shp]', err);
      showAppAlert('Erro ao exportar união.', {error: true});
    }
  });

  // ---- difference ----
  document.getElementById('btn-run-difference').addEventListener('click', runDifference);
  document.getElementById('btn-clear-difference').addEventListener('click', ()=>{
    differenceLayerGroup.clearLayers();
    lastDifferenceFeatures = [];
    document.getElementById('difference-status').textContent = '';
  });
  document.getElementById('btn-export-difference-geojson').addEventListener('click', ()=>{
    if(lastDifferenceFeatures.length === 0){ showAppAlert('Gera primeiro uma diferença para poderes exportar.'); return; }
    downloadGeoJSON({type:'FeatureCollection', features:lastDifferenceFeatures}, 'engenh_difference.geojson');
  });
  document.getElementById('btn-export-difference-shp').addEventListener('click', async ()=>{
    try{
      if(lastDifferenceFeatures.length === 0){ showAppAlert('Gera primeiro uma diferença para poderes exportar.'); return; }
      const gj = reprojectGeoJSON({type:'FeatureCollection', features:lastDifferenceFeatures}, 'EPSG:3763');
      await exportShapefileZip(gj, 'engenh_difference', document.getElementById('btn-export-difference-shp'), PTTM06_WKT);
    }catch(err){
      console.error('[export-difference-shp]', err);
      showAppAlert('Erro ao exportar diferença.', {error: true});
    }
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

/* --- exposição global --- */
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
