(function(){
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

window.geometryStatsHTML = geometryStatsHTML;
window.showStatsPopup = showStatsPopup;
window.refreshStatsIfOpen = refreshStatsIfOpen;
window.flashHighlight = flashHighlight;
window.getHighlightColor = getHighlightColor;
window.ensureResultHatchPattern = ensureResultHatchPattern;
})();
