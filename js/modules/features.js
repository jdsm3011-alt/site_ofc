(function(){
window.formEntryRef = null;
window.attrTableLayerId = null; // qual camada a tabela de atributos está a mostrar de momento
window.formIsNewFeature = false;
const GEOM_TYPE_LABELS = {Point:'Ponto', LineString:'Linha', Polygon:'Polígono'};

/* ---------- Índice layerId→Set<featureId> ----------
   Permite consultas O(1) por featureId de uma camada, eliminando
   scans lineares repetidos do featuresData. */
const _layerFeatureIndex = new Map(); // layerId → Set<id>

function addToLayerIndex(entry){
  if(entry == null) return;
  let s = _layerFeatureIndex.get(entry.layerId);
  if(!s){ s = new Set(); _layerFeatureIndex.set(entry.layerId, s); }
  s.add(entry.id);
}

function removeFromLayerIndex(entry){
  if(entry == null) return;
  const s = _layerFeatureIndex.get(entry.layerId);
  if(s) s.delete(entry.id);
}

function getFeatureIdsForLayer(layerId){
  return _layerFeatureIndex.get(layerId) || _emptySet;
}
const _emptySet = new Set();

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
let _refreshFeatListTimer = null;
function refreshFeatList(){
  if(_refreshFeatListTimer) return;
  _refreshFeatListTimer = requestAnimationFrame(()=>{
    _refreshFeatListTimer = null;
    updateFeatSummary();
  });
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
  const s = _layerFeatureIndex.get(layerId);
  return s ? s.size : 0;
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

window.draggedLayerRowId = null;

/* painel: uma linha por camada (arquivadas + a ativa, se já tiver tipo de geometria definido),
   cada uma com interruptor de visibilidade, menu de contexto (botão direito) e arrastar
   para reordenar — a ordem das linhas no painel passa a definir qual camada fica por
   cima/por baixo das outras no mapa. */
/* cores (e etiquetas) a mostrar na mini-legenda por baixo da camada ativa no painel */
function swatchHTML(color, geomType){
  const c = escapeHtml(color);
  if(geomType === 'Point'){
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${c};border:1.5px solid rgba(0,0,0,.25);"></span></span>`;
  }
  if(geomType === 'LineString'){
    return `<span style="display:inline-flex;align-items:center;width:20px;height:20px;min-width:20px;"><span style="display:inline-block;width:16px;height:3px;border-radius:2px;background:${c};"></span></span>`;
  }
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;"><span style="display:inline-block;width:14px;height:11px;border-radius:2px;background:${c};border:1.5px solid rgba(0,0,0,.2);"></span></span>`;
}

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

  allIds.forEach(id=>{ if(!layerOrder.includes(id)) layerOrder.unshift(id); });
  layerOrder = layerOrder.filter(id=>allIds.includes(id));

  const _counts = new Map();
  featuresData.forEach(e=>{ _counts.set(e.layerId, (_counts.get(e.layerId)||0)+1); });

  list.innerHTML = layerOrder.map(id=>{
    const schema = getLayerSchema(id);
    if(!schema) return '';
    const visible = layerVisible.get(id) !== false;
    const isActive = id === activeLayerId;
    const count = _counts.get(id) || 0;
    const rowHTML = `
      <li class="layer-row ${isActive ? 'is-active' : ''} ${visible ? '' : 'is-hidden-layer'}" data-layer-id="${id}" draggable="true" title="Arrasta para reordenar · clica para tornar ativa (editável) · botão direito para mais opções">
        <span class="layer-drag-handle" title="Arrastar para reordenar">⠿</span>
        <span class="layer-name">${escapeHtml(schema.name || 'Shape sem nome')} <span style="color:var(--stone); font-weight:400;">(${count})</span></span>
        ${isActive ? '<span class="layer-active-tag">ativa</span>' : ''}
      </li>`;
    if(!isActive) return rowHTML;
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
              ${swatchHTML(s.color, schema.geometryType)}
              <span class="layer-legend-label" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${s.label!=null ? escapeHtml(String(s.label)) : '—'}</span>
            </li>`).join('')}
          ${extraCount > 0 ? `<li class="layer-legend-item layer-legend-more" style="font-size:11px; color:var(--stone, #8a8478); padding-left:17px;">+ ${extraCount} classe(s)</li>` : ''}
        </ul>`
      : swatches.map(s=>swatchHTML(s.color, schema.geometryType)).join('');

    const legendHTML = `
      <li class="layer-legend-row" data-legend-for="${id}" title="Clica para abrir a Simbologia">
        ${legendInnerHTML}
      </li>`;
    return rowHTML + legendHTML;
  }).join('') || '';

  if(!list._delegated){
    list._delegated = true;
    list.addEventListener('click', (e)=>{
      const legendRow = e.target.closest('.layer-legend-row');
      if(legendRow){
        e.stopPropagation();
        symbologyLayerId = Number(legendRow.dataset.legendFor);
        renderSymbologyPanel();
        return;
      }
      const row = e.target.closest('.layer-row');
      if(row) switchActiveLayer(Number(row.dataset.layerId));
    });
    list.addEventListener('contextmenu', (e)=>{
      const row = e.target.closest('.layer-row');
      if(!row) return;
      e.preventDefault();
      openLayerContextMenu(e.clientX, e.clientY, Number(row.dataset.layerId));
    });
    list.addEventListener('dragstart', (e)=>{
      const row = e.target.closest('.layer-row');
      if(!row) return;
      draggedLayerRowId = Number(row.dataset.layerId);
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try{ e.dataTransfer.setData('text/plain', row.dataset.layerId); }catch(err){}
    });
    list.addEventListener('dragend', ()=>{
      draggedLayerRowId = null;
      list.querySelectorAll('.layer-row').forEach(r=>r.classList.remove('is-dragging','drag-over-top','drag-over-bottom'));
    });
    list.addEventListener('dragover', (e)=>{
      const row = e.target.closest('.layer-row');
      if(!row || draggedLayerRowId === null) return;
      const targetId = Number(row.dataset.layerId);
      if(draggedLayerRowId === targetId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drag-over-top', before);
      row.classList.toggle('drag-over-bottom', !before);
    });
    list.addEventListener('dragleave', (e)=>{
      const row = e.target.closest('.layer-row');
      if(row) row.classList.remove('drag-over-top','drag-over-bottom');
    });
    list.addEventListener('drop', (e)=>{
      const row = e.target.closest('.layer-row');
      if(!row) return;
      e.preventDefault();
      const targetId = Number(row.dataset.layerId);
      row.classList.remove('drag-over-top','drag-over-bottom');
      if(draggedLayerRowId === null || draggedLayerRowId === targetId) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      reorderLayer(draggedLayerRowId, targetId, before);
    });
  }

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
  if(typeof getFeatureIdsForLayer === 'function'){
    // Bloqueia tudo de uma vez, depois desbloqueia só a camada ativa
    featuresData.forEach(entry=>{
      if(entry.layer.options) entry.layer.options.pmIgnore = true;
    });
    const activeIds = getFeatureIdsForLayer(activeLayerId);
    activeIds.forEach(id=>{
      const entry = featuresData.get(id);
      if(entry && entry.layer.options) entry.layer.options.pmIgnore = false;
    });
  } else {
    featuresData.forEach(entry=>{
      if(entry.layer.options) entry.layer.options.pmIgnore = (entry.layerId !== activeLayerId);
    });
  }
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
  const ids = getFeatureIdsForLayer(layerId);
  ids.forEach(id=>{
    const entry = featuresData.get(id);
    if(!entry) return;
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

  const ids = getFeatureIdsForLayer(layerId);
  ids.forEach(id=>{
    const entry = featuresData.get(id);
    if(!entry) return;
    if(entry.fid){ teamState.deletedFids.set(entry.fid, Date.now()); }
    clearPolygonMeasures(entry);
    drawnGroup.removeLayer(entry.layer);
    featuresData.delete(id);
  });
  _layerFeatureIndex.delete(layerId);

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
window.ctxMenuLayerId = null;
function openLayerContextMenu(x, y, layerId){
  ctxMenuLayerId = layerId;
  const menu = document.getElementById('layer-context-menu');
  menu.classList.remove('hidden');
  const visBtn = document.getElementById('layer-ctx-visibility');
  if(visBtn){
    const visible = layerVisible.get(layerId) !== false;
    visBtn.textContent = visible ? '👁 Ocultar camada' : '🙈 Mostrar camada';
  }
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
window.ctxMenuFeatureEntry = null;
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
  const ids = getFeatureIdsForLayer(layerId);
  ids.forEach(id=>{
    const entry = featuresData.get(id);
    if(entry) group.addLayer(entry.layer);
  });
  if(group.getLayers().length === 0){
    showAppAlert('Esta camada ainda não tem geometrias para dar zoom.');
    return;
  }
  try{ map.fitBounds(group.getBounds(), {padding:[40,40], maxZoom:18}); }
  catch(err){ /* bounds inválidos, ignora em segurança */ }
}

document.getElementById('layer-ctx-zoom').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  zoomToLayer(ctxMenuLayerId);
});
document.getElementById('layer-ctx-visibility').addEventListener('click', ()=>{
  if(ctxMenuLayerId === null) return;
  toggleLayerVisibility(ctxMenuLayerId);
  closeLayerContextMenu();
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
let _lastSymbRenderId = null;
let _lastSymbRenderSig = '';
function renderSymbologyPanel(){
  const row = document.getElementById('shape-color-attr-row');
  const nameLabel = document.getElementById('symbology-layer-name');
  const body = document.getElementById('symbology-body');

  if(symbologyLayerId === null){
    row.classList.add('hidden');
    _lastSymbRenderId = null;
    return;
  }

  const schema = getLayerSchema(symbologyLayerId);
  if(!schema){
    symbologyLayerId = null;
    row.classList.add('hidden');
    _lastSymbRenderId = null;
    return;
  }

  const sig = symbologyLayerId + '|' + (schema.symbology && schema.symbology.mode) + '|' + (schema.symbology && schema.symbology.attr) + '|' + (schema.symbology && schema.symbology.classCount) + '|' + (schema.opacity||0) + '|' + (schema.symbology && JSON.stringify(schema.symbology.uniqueValues && schema.symbology.uniqueValues.length)) + '|' + (schema.symbology && JSON.stringify(schema.symbology.breaks && schema.symbology.breaks.length));
  if(symbologyLayerId === _lastSymbRenderId && sig === _lastSymbRenderSig) return;
  _lastSymbRenderId = symbologyLayerId;
  _lastSymbRenderSig = sig;

  row.classList.remove('hidden');
  nameLabel.textContent = `Simbologia — ${schema.name || 'Shape sem nome'}`;

  const sym = ensureSymbology(schema);
  const allAttrs = schema.mode === 'atributos' ? (schema.attributes || []) : [];
  const numericAttrs = allAttrs.filter(a=>a.type === 'numero');
  const canGraduate = numericAttrs.length > 0;
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

  if(!body._delegated){
    body._delegated = true;
    body.addEventListener('click', (e)=>{
      const tab = e.target.closest('[data-sym-mode]');
      if(tab && !tab.disabled){
        setLayerSymbologyMode(symbologyLayerId, tab.dataset.symMode);
        renderSymbologyPanel();
      }
    });
    body.addEventListener('input', (e)=>{
      if(e.target.id === 'shape-opacity-input'){
        const valEl = document.getElementById('shape-opacity-value');
        if(valEl) valEl.textContent = e.target.value + '%';
        setLayerOpacity(symbologyLayerId, e.target.value);
      } else if(e.target.id === 'shape-base-color-input'){
        setLayerBaseColor(symbologyLayerId, e.target.value);
      } else if(e.target.dataset.uniqueIdx != null){
        const curSym = ensureSymbology(getLayerSchema(symbologyLayerId));
        const item = curSym.uniqueValues[Number(e.target.dataset.uniqueIdx)];
        if(item) setUniqueValueColor(symbologyLayerId, item.value, e.target.value);
      } else if(e.target.dataset.breakColorIdx != null){
        setGraduatedBreakColor(symbologyLayerId, Number(e.target.dataset.breakColorIdx), e.target.value);
      }
    });
    body.addEventListener('change', (e)=>{
      if(e.target.id === 'symbology-attr-select'){
        const curSym = ensureSymbology(getLayerSchema(symbologyLayerId));
        if(curSym.mode === 'unicos') setLayerSymbologyUniqueAttr(symbologyLayerId, e.target.value);
        else setLayerSymbologyGraduatedAttr(symbologyLayerId, e.target.value);
        renderSymbologyPanel();
      } else if(e.target.id === 'symbology-method-select'){
        setLayerSymbologyMethod(symbologyLayerId, e.target.value);
        renderSymbologyPanel();
      } else if(e.target.id === 'symbology-classcount-input'){
        const n = Math.max(2, Math.min(12, parseInt(e.target.value, 10) || 5));
        setLayerSymbologyClassCount(symbologyLayerId, n);
        renderSymbologyPanel();
      } else if(e.target.dataset.breakBoundIdx != null){
        setGraduatedBreakBound(symbologyLayerId, Number(e.target.dataset.breakBoundIdx), e.target.value);
        renderSymbologyPanel();
      }
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

const ATTR_TABLE_PAGE_SIZE = 200;
let _attrTableEntries = [];
let _attrTablePage = 0;
let _attrTableSchema = null;

function _buildAttrRow(entry, i, attrCols, schema, isActiveLayer){
  const attrCells = attrCols.map(a=>{
    const { attrs, html } = formatAttrCellHtml(a, entry.props[a.name]);
    return `<td ${attrs}>${html}</td>`;
  }).join('');
  const showOverlap = entry.hasOverlap && window.topologyWarningsEnabled;
  const overlapBadge = showOverlap
    ? `<span class="overlap-badge" title="Esta geometria sobrepõe-se a outra">${ATTR_ACTION_ICONS.overlap}</span>`
    : '';
  return `<tr data-row-id="${entry.id}" class="${showOverlap ? 'has-overlap' : ''}">` +
    `<td class="id-cell"><span class="id-cell-inner"><span class="id-badge">${i}</span>${overlapBadge}</span></td>` +
    attrCells +
    `<td class="actions-cell">` +
      `<button data-highlight title="Realçar e mostrar popup">${ATTR_ACTION_ICONS.highlight}</button>` +
      `<button data-focus title="Centrar no mapa">${ATTR_ACTION_ICONS.focus}</button>` +
      `${(schema.mode === 'atributos' && isActiveLayer) ? `<button data-edit title="Editar atributos">${ATTR_ACTION_ICONS.edit}</button>` : ''}` +
      `<button data-delete class="danger" title="Apagar">${ATTR_ACTION_ICONS.delete}</button>` +
    `</td></tr>`;
}

function _renderAttrPage(page){
  const body = document.getElementById('attr-table-body');
  if(!body) return;
  const schema = _attrTableSchema || {mode:null, attributes:[]};
  const isActiveLayer = attrTableLayerId === activeLayerId;
  const attrCols = schema.mode === 'atributos' ? schema.attributes : [];
  const start = page * ATTR_TABLE_PAGE_SIZE;
  const end = Math.min(start + ATTR_TABLE_PAGE_SIZE, _attrTableEntries.length);

  if(page === 0){
    body.innerHTML = '';
  }

  const frag = document.createDocumentFragment();
  const wrapper = document.createElement('tbody');
  let rows = '';
  for(let idx = start; idx < end; idx++){
    rows += _buildAttrRow(_attrTableEntries[idx], idx + 1, attrCols, schema, isActiveLayer);
  }
  wrapper.innerHTML = rows;
  while(wrapper.firstChild) frag.appendChild(wrapper.firstChild);

  const loadMore = body.querySelector('.attr-load-more-row');
  if(loadMore) loadMore.remove();
  body.appendChild(frag);

  _attrTablePage = page;

  if(end < _attrTableEntries.length){
    const remaining = _attrTableEntries.length - end;
    const loadMoreTr = document.createElement('tr');
    loadMoreTr.className = 'attr-load-more-row';
    loadMoreTr.innerHTML = `<td colspan="${attrCols.length + 2}" style="text-align:center; padding:10px;">` +
      `<button class="attr-load-more-btn" style="padding:6px 18px; border:1px solid var(--border); border-radius:6px; background:var(--paper); cursor:pointer; font-size:13px; color:var(--text);">` +
      `Mostrar mais (${remaining} restantes)</button></td>`;
    body.appendChild(loadMoreTr);
  }
}

function renderAttrTable(layerId){
  if(layerId === undefined || layerId === null) layerId = activeLayerId;
  attrTableLayerId = layerId;

  const schema = getLayerSchema(layerId) || {name:null, mode:null, attributes:[]};
  _attrTableSchema = schema;
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

  const entries = getFeatureIdsForLayer(layerId);
  _attrTableEntries = [];
  entries.forEach(id=>{ const e = featuresData.get(id); if(e) _attrTableEntries.push(e); });

  if(_attrTableEntries.length === 0){
    body.innerHTML = `<tr><td colspan="${attrCols.length + 2}" id="attr-table-empty">Ainda não desenhaste nenhuma geometria nesta camada.</td></tr>`;
    if(countPill){ countPill.textContent = ''; countPill.classList.remove('has-overlap-warn'); }
    return;
  }

  let overlapCount = 0;
  if(window.topologyWarningsEnabled){
    _attrTableEntries.forEach(e=>{ if(e.hasOverlap) overlapCount++; });
  }
  if(countPill){
    countPill.textContent = _attrTableEntries.length === 1 ? '1 geometria' : `${_attrTableEntries.length} geometrias`;
    if(overlapCount > 0){
      countPill.textContent += ` · ${overlapCount} com sobreposição`;
      countPill.classList.add('has-overlap-warn');
    } else {
      countPill.classList.remove('has-overlap-warn');
    }
  }

  _renderAttrPage(0);

  if(!body._delegated){
    body._delegated = true;
    body.addEventListener('click', (e)=>{
      const loadMoreBtn = e.target.closest('.attr-load-more-btn');
      if(loadMoreBtn){
        _renderAttrPage(_attrTablePage + 1);
        return;
      }
      const tr = e.target.closest('tr[data-row-id]');
      if(!tr) return;
      const entry = featuresData.get(Number(tr.dataset.rowId));
      if(!entry) return;
      const btn = e.target.closest('button[data-action], button[data-highlight], button[data-focus], button[data-edit], button[data-delete]');
      if(!btn) return;
      if(btn.dataset.focus){
        if(entry.layer.getBounds) map.fitBounds(entry.layer.getBounds(), {maxZoom:16});
        else if(entry.layer.getLatLng) map.setView(entry.layer.getLatLng(), 16);
      } else if(btn.dataset.highlight){
        showStatsPopup(entry);
        flashHighlight(entry);
      } else if(btn.dataset.edit){
        openAttrForm(entry);
      } else if(btn.dataset.delete){
        historyRemoveFeature(entry.layer, entry);
        pushHistoryAction({type:'remove', layer: entry.layer, entry});
      }
    });
  }
}

document.getElementById('attr-table-close').addEventListener('click', ()=>{
  document.getElementById('attr-table-overlay').classList.add('hidden');
});

window.addToLayerIndex = addToLayerIndex;
window.removeFromLayerIndex = removeFromLayerIndex;
window.getFeatureIdsForLayer = getFeatureIdsForLayer;
window.formEntryRef = formEntryRef;
window.attrTableLayerId = attrTableLayerId;
window.formIsNewFeature = formIsNewFeature;
window.ctxMenuLayerId = ctxMenuLayerId;
window.ctxMenuFeatureEntry = ctxMenuFeatureEntry;
window.draggedLayerRowId = draggedLayerRowId;
window.openAttrForm = openAttrForm;
window.refreshFeatList = refreshFeatList;
window.updateFeatSummary = updateFeatSummary;
window.getLayerSchema = getLayerSchema;
window.countLayerFeatures = countLayerFeatures;
window.ensureLayerPane = ensureLayerPane;
window.assignLayerPane = assignLayerPane;
window.applyLayerZOrder = applyLayerZOrder;
window.layerSwatchColors = layerSwatchColors;
window.renderLayersPanel = renderLayersPanel;
window.reorderLayer = reorderLayer;
window.switchActiveLayer = switchActiveLayer;
window.refreshLayerEditability = refreshLayerEditability;
window.toggleLayerVisibility = toggleLayerVisibility;
window.removeLayerEntirely = removeLayerEntirely;
window.openLayerContextMenu = openLayerContextMenu;
window.closeLayerContextMenu = closeLayerContextMenu;
window.bindFeatureContextMenu = bindFeatureContextMenu;
window.openFeatureContextMenu = openFeatureContextMenu;
window.closeFeatureContextMenu = closeFeatureContextMenu;
window.flattenPolygonRings = flattenPolygonRings;
window.renderPolygonMeasures = renderPolygonMeasures;
window.clearPolygonMeasures = clearPolygonMeasures;
window.togglePolygonMeasures = togglePolygonMeasures;
window.zoomToLayer = zoomToLayer;
window.setLayerBaseColor = setLayerBaseColor;
window.setLayerOpacity = setLayerOpacity;
window.ensureSymbology = ensureSymbology;
window.setLayerSymbologyMode = setLayerSymbologyMode;
window.generateUniqueValueClasses = generateUniqueValueClasses;
window.setLayerSymbologyUniqueAttr = setLayerSymbologyUniqueAttr;
window.setUniqueValueColor = setUniqueValueColor;
window.generateGraduatedClasses = generateGraduatedClasses;
window.setLayerSymbologyGraduatedAttr = setLayerSymbologyGraduatedAttr;
window.setLayerSymbologyMethod = setLayerSymbologyMethod;
window.setLayerSymbologyClassCount = setLayerSymbologyClassCount;
window.setGraduatedBreakColor = setGraduatedBreakColor;
window.setGraduatedBreakBound = setGraduatedBreakBound;
window.SYMBOLOGY_METHOD_LABELS = SYMBOLOGY_METHOD_LABELS;
window.fmtBreakNumber = fmtBreakNumber;
window.renderSymbologyPanel = renderSymbologyPanel;
window.restyleAllLayers = restyleAllLayers;
window.ATTR_ACTION_ICONS = ATTR_ACTION_ICONS;
window.formatAttrCellHtml = formatAttrCellHtml;
window.renderAttrTable = renderAttrTable;
window.GEOM_TYPE_LABELS = GEOM_TYPE_LABELS;
})();
