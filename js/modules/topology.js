/* === MÓDULO: TOPOLOGIA === */
/* Polygon overlap detection, visual warnings, topology toggle button */
/* Origem: 05-app-main.js linhas 4897-5009 */
(function(){

function checkAllTopology(){
  if(typeof turf === 'undefined') return;

  // 1. Agrupar polígonos por camada para evitar comparações cross-layer
  const byLayer = new Map(); // layerId → [{entry, gj, bbox}]
  featuresData.forEach(entry=>{
    if(!entry.layer.toGeoJSON) return;
    const gj = entry.layer.toGeoJSON();
    if(gj.geometry.type !== 'Polygon') return;
    entry.hasOverlap = false;
    entry.overlapsWith = [];
    let bbox = null;
    try{ bbox = turf.bbox(gj); }catch(err){ bbox = null; }
    const rec = { entry, gj, bbox };
    let arr = byLayer.get(entry.layerId);
    if(!arr){ arr = []; byLayer.set(entry.layerId, arr); }
    arr.push(rec);
  });

  // 2. Só comparar pares dentro da mesma camada (O(n²) reduzido por camada)
  byLayer.forEach(arr=>{
    if(arr.length < 2) return; // layer com 1 polígono: sem sobreposições possíveis
    for(let i=0; i<arr.length; i++){
      const a = arr[i];
      for(let j=i+1; j<arr.length; j++){
        const b = arr[j];

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
          overlaps = false;
        }
        if(overlaps){
          a.entry.hasOverlap = true; a.entry.overlapsWith.push(b.entry.label);
          b.entry.hasOverlap = true; b.entry.overlapsWith.push(a.entry.label);
        }
      }
    }
  });

  featuresData.forEach(entry=>{
    if(entry.hasOverlap){
      applyTopologyVisual(entry);
      refreshStatsIfOpen(entry);
    }
  });

  refreshFeatList();
  updateTopologyWarnButton();
}

function getWarnColor(){
  const v = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
  return v || '#B5472B';
}

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
  for(const e of featuresData.values()){
    if(e.hasOverlap){ hasAnyOverlap = true; break; }
  }
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
    const schema = getLayerSchema(entry.layerId);
    styleLayerByClass(entry);
    const hasClassifiedSymbology = schema && schema.symbology && (schema.symbology.mode === 'unicos' || schema.symbology.mode === 'graduado');
    if(!hasClassifiedSymbology && !(schema && schema.mode === 'atributos')){ styleLayerDefault(entry.layer, entry.layerId); }
  }
}

function dataGisMarkerIcon(color, size){
  color = color || DEFAULT_COLOR;
  size = Number(size) || 18;
  const half = size / 2;
  const border = Math.max(2, Math.round(size * 0.17));
  return L.divIcon({
    className:'datagis-point-marker',
    html:`<span style="
      display:block; width:${size}px; height:${size}px; border-radius:50%;
      background:${color}; border:${border}px solid var(--paper-elevated, #fff);
      box-shadow:0 1px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.12);
    "></span>`,
    iconSize:[size,size], iconAnchor:[half,half]
  });
}

window.checkAllTopology = checkAllTopology;
window.applyTopologyVisual = applyTopologyVisual;
window.toggleTopologyWarnings = toggleTopologyWarnings;
window.updateTopologyWarnButton = updateTopologyWarnButton;
window.dataGisMarkerIcon = dataGisMarkerIcon;
Object.defineProperty(window, 'topologyWarningsEnabled', {
  get: function(){ return topologyWarningsEnabled; },
  set: function(v){ topologyWarningsEnabled = v; }
});

})();
