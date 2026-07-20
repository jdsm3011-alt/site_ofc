/* === MÓDULO: OFFLINE === */
/* Offline area drawing, estimate dialog, download tiles,
   offline areas menu (render, open, close), ruler tool */
/* Origem: 05-app-main.js — ver remoções correspondentes */
(function(){

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

function startRulerDrawing(){
  if(rulerDrawing) return;
  closeOfflineAreasMenu();
  if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
  rulerDrawing = true;
  document.getElementById('ruler-banner').style.display = 'flex';
  document.getElementById('btn-ruler').classList.add('is-active');
  map.pm.enableDraw('Line');
}
document.getElementById('btn-ruler').addEventListener('click', (e)=>{
  e.stopPropagation();
  if(rulerDrawing){
    /* clique para cancelar */
    if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
    rulerDrawing = false;
    document.getElementById('ruler-banner').style.display = 'none';
    document.getElementById('btn-ruler').classList.remove('is-active');
    return;
  }
  startRulerDrawing();
});
document.getElementById('ruler-cancel').addEventListener('click', ()=>{
  if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
  rulerDrawing = false;
  document.getElementById('ruler-banner').style.display = 'none';
  document.getElementById('btn-ruler').classList.remove('is-active');
});

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
    try{
      document.getElementById('offline-overlay').classList.add('hidden');
      await downloadOfflineArea(bounds, minZoom, maxZoom, layerInfos);
    }catch(err){
      console.error('[offline-download]', err);
      showAppAlert('Erro ao descarregar área offline.', {error: true});
    }
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
  showAppAlert('Área offline guardada com sucesso. Já podes usar este mapa sem ligação à internet, dentro desta área.');
}

document.getElementById('offline-progress-cancel').addEventListener('click', ()=>{
  offlineCancelDownload = true;
});

/* ---------- estado / gestão: menu de áreas guardadas (no cabeçalho) ---------- */
async function renderOfflineAreasMenu(){
  try{
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
        try{ await idbDeleteMeta(meta.id); }catch(err){ console.error('[idbDeleteMeta]', err); }
        renderOfflineAreasMenu();
      });
      list.appendChild(item);
    });
  }catch(err){
    console.error('[renderOfflineAreasMenu]', err);
  }
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

/* expor funções usadas por outros módulos */
window.setupOfflineMapEvents = setupOfflineMapEvents;
window.setupRulerMapEvents = setupRulerMapEvents;
window.renderOfflineAreasMenu = renderOfflineAreasMenu;
window.openOfflineAreasMenu = openOfflineAreasMenu;
window.closeOfflineAreasMenu = closeOfflineAreasMenu;

})();
