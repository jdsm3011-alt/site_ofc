/* ============================================================
   LIGAR AO PORTAL — ponte entre o Engenh e o portal DataGis
   (https://datagispt.gispt.workers.dev/).

   Fluxo: pesquisar município -> lista de conteúdos disponíveis para
   esse município -> importar. Cada importação cria uma CAMADA NOVA
   (nunca sobrescreve nada que já exista no projeto).

   FONTE DOS DADOS: `data/municipios.json` (no mesmo repositório GitHub
   já usado pelo painel "Limites de município" — MUNICIPIOS_GITHUB_RAW_BASE,
   definido em js/05-app-main.js). Esse ficheiro tem, por município, os
   campos caop_preview / cos_preview / bgri_preview / osm_previews: caminhos
   para GeoJSON servidos via raw.githubusercontent.com, que devolve
   "access-control-allow-origin: *" — por isso o browser consegue fazer
   fetch() e importar diretamente.

   DADOS COMPLETOS, NÃO PRÉ-VISUALIZAÇÕES: caop_zip / cos_zip / bgri_zip /
   osm_zips (em municipios.json) apontam para GitHub Releases com o
   Shapefile completo em alta resolução. Essas respostas não têm cabeçalho
   CORS, por isso o browser bloqueia o fetch() direto. Para contornar isto,
   o Worker `datagis-equipa` (TEAM_API_BASE, definido em js/05-app-main.js)
   expõe agora a rota `GET /api/download?url=<zip>`, que faz de intermediário
   (corre no servidor, não está sujeito a CORS) e devolve a resposta com
   `Access-Control-Allow-Origin`. O .zip devolvido é parseado no browser
   com `shpjs` (window.shp), já incluído em engenh.html.

   O MDT é um raster (.tif), não um vetor — não há forma de o trazer como
   camada editável do Engenh da mesma maneira, por isso fica por implementar
   (ver PB_DATASETS abaixo).

   Para atualizar o endpoint de qualquer dataset, mexe apenas em
   PB_DATASETS e em pbImportZip() / showOsmView() abaixo.
   ============================================================ */
if(typeof normalizeAccents !== 'function'){
  var normalizeAccents = function(s){ return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); };
}

/* ---------- criação de camada nova a partir de um FeatureCollection ----------
   Replica exatamente o padrão já usado em "Selecionar por atributos" (criação
   de camada nova a partir de uma seleção): regista o schema em `layers`,
   avança o `layerCounter`, e usa a função de importação já existente
   (importGeoJSONFeatures) com um resolver fixo para o novo id. Isto garante
   que a camada resultante se comporta exactamente como qualquer outra do
   projeto (aparece no painel de camadas, é exportável, tem simbologia, etc.). */
function pbCreateLayerFromFeatureCollection(geojson, layerName){
  const features = Array.isArray(geojson && geojson.features)
    ? geojson.features.filter(f => f && f.geometry)
    : [];
  if(!features.length){
    throw new Error('Sem geometrias válidas para importar.');
  }

  const firstType = baseGeomType(features[0].geometry.type);
  const newLayerId = ++layerCounter;
  const finalName = (layerName && layerName.trim()) || 'Camada do portal';

  layers.push({
    id: newLayerId,
    name: finalName,
    geometryType: firstType,
    mode: 'atributos',
    attributes: [],
    colorAttr: null,
    baseColor: null,
    opacity: null,
    symbology: defaultSymbology()
  });

  const res = importGeoJSONFeatures(
    {type: 'FeatureCollection', features},
    () => newLayerId,
    /* silent */ true
  );

  renderLayersPanel();
  markProjectDirty();

  if(res.imported > 0){
    try{ map.fitBounds(drawnGroup.getBounds(), {padding:[40,40], maxZoom:18}); }
    catch(err){ /* bounds inválidos, ignora */ }
  }

  return {newLayerId, ...res};
}

/* ---------- conteúdos disponíveis por município ----------
   Espelha a lista que já mostras no portal (CAOP, COS Nível 4, BGRI 2021,
   MDT, OSM). Só o CAOP tem, para já, um endpoint confirmado (o mesmo do
   painel "Limites de município"). Os restantes ficam marcados como
   "em breve" e abrem o portal — assim que tiveres o endpoint de cada um,
   basta trocar available:false -> true e escrever a função de fetch
   (segue exatamente o padrão de pbImportCaop). */
const PB_DATASETS = [
  {
    key: 'caop',
    label: 'CAOP — Limite administrativo',
    field: 'caop_zip',
    desc: 'Shapefile completo, como camada editável',
    available: true
  },
  {
    key: 'cos',
    label: 'COS Nível 4 — Uso e ocupação do solo',
    field: 'cos_zip',
    desc: 'Shapefile completo, como camada editável',
    available: true
  },
  {
    key: 'bgri',
    label: 'BGRI 2021 — Base geográfica de referenciação',
    field: 'bgri_zip',
    desc: 'Shapefile completo, como camada editável',
    available: true
  },
  {
    key: 'osm',
    label: 'OSM — Vias, edifícios e outros',
    field: 'osm_zips',
    desc: 'Escolher uma camada OSM (vias, edifícios, água…)',
    available: true,
    isGroup: true
  },
  {
    key: 'mdt',
    label: 'MDT — Modelo digital do terreno',
    field: null,
    desc: 'Raster — ainda não suportado como camada no Engenh',
    available: false
  }
];

/* nomes amigáveis para as sub-camadas OSM, tal como já usas no portal */
const PB_OSM_META = {
  'gis_osm_buildings_a_free_1': { nome: 'Edifícios', meta: 'Polígonos' },
  'gis_osm_landuse_a_free_1': { nome: 'Uso do Solo', meta: 'Polígonos' },
  'gis_osm_natural_a_free_1': { nome: 'Natureza (áreas)', meta: 'Polígonos' },
  'gis_osm_natural_free_1': { nome: 'Natureza (pontos)', meta: 'Pontos' },
  'gis_osm_places_a_free_1': { nome: 'Lugares (áreas)', meta: 'Polígonos' },
  'gis_osm_places_free_1': { nome: 'Lugares (pontos)', meta: 'Pontos' },
  'gis_osm_pofw_a_free_1': { nome: 'Culto (áreas)', meta: 'Polígonos' },
  'gis_osm_pofw_free_1': { nome: 'Culto (pontos)', meta: 'Pontos' },
  'gis_osm_pois_a_free_1': { nome: 'POI (áreas)', meta: 'Polígonos' },
  'gis_osm_pois_free_1': { nome: 'POI (pontos)', meta: 'Pontos' },
  'gis_osm_protected_areas_a_free_1': { nome: 'Áreas Protegidas', meta: 'Polígonos' },
  'gis_osm_railways_free_1': { nome: 'Caminhos de ferro', meta: 'Linhas' },
  'gis_osm_roads_free_1': { nome: 'Estradas', meta: 'Linhas' },
  'gis_osm_traffic_a_free_1': { nome: 'Tráfego (áreas)', meta: 'Polígonos' },
  'gis_osm_traffic_free_1': { nome: 'Tráfego (pontos)', meta: 'Pontos' },
  'gis_osm_transport_a_free_1': { nome: 'Transportes (áreas)', meta: 'Polígonos' },
  'gis_osm_transport_free_1': { nome: 'Transportes (pontos)', meta: 'Pontos' },
  'gis_osm_water_a_free_1': { nome: 'Água (áreas)', meta: 'Polígonos' },
  'gis_osm_waterways_free_1': { nome: 'Cursos de água', meta: 'Linhas' }
};

function pbOsmLayerName(layerName){
  const meta = PB_OSM_META[layerName];
  if(meta) return meta.nome;
  return layerName.replace('gis_osm_', '').replace(/_a_free_1|_free_1/g, '').replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
}

const PB_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9l5-6 8 2 4 6-2 9-11 1-4-5z"/></svg>';

/* ---------- data/municipios.json: fonte real dos caminhos de pré-visualização ----------
   Carregado uma vez e mantido em memória (~1MB, 260+ municípios). */
let pbMunicipiosData = null;
let pbMunicipiosByName = null;
let pbMunicipiosLoadingPromise = null;

async function pbLoadMunicipiosData(){
  if(pbMunicipiosByName) return pbMunicipiosByName;
  if(pbMunicipiosLoadingPromise) return pbMunicipiosLoadingPromise;

  pbMunicipiosLoadingPromise = (async () => {
    const res = await fetch(MUNICIPIOS_GITHUB_RAW_BASE + 'data/municipios.json');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    pbMunicipiosData = list;
    pbMunicipiosByName = {};
    list.forEach(m => { pbMunicipiosByName[normalizeAccents(m.municipio)] = m; });
    return pbMunicipiosByName;
  })();

  try{
    return await pbMunicipiosLoadingPromise;
  }catch(err){
    pbMunicipiosLoadingPromise = null; // permite nova tentativa se falhar
    throw err;
  }
}

/* ---------- importar um Shapefile completo (CAOP / COS / BGRI / OSM sub-camada) ----------
   zipUrl vem de municipios.json (caop_zip/cos_zip/bgri_zip/osm_zips), e aponta
   para um GitHub Release. Como essas respostas não têm CORS, passamos sempre
   pelo proxy do worker (TEAM_API_BASE + /api/download?url=...), que devolve o
   .zip com o cabeçalho certo. O parsing do Shapefile é feito no browser com
   shpjs (window.shp), já incluído em engenh.html. */
async function pbImportZip(zipUrl, layerName, statusEl){
  statusEl.textContent = `A descarregar ${layerName}…`;
  try{
    const proxyUrl = `${TEAM_API_BASE}/api/download?url=${encodeURIComponent(zipUrl)}`;
    const res = await fetch(proxyUrl);
    if(!res.ok){
      let msg = 'HTTP ' + res.status;
      try{ const body = await res.json(); if(body && body.error) msg = body.error; }catch(e){ /* ignora */ }
      throw new Error(msg);
    }
    const buffer = await res.arrayBuffer();

    statusEl.textContent = `A processar "${layerName}"…`;
    let parsed = await shp(buffer);
    // shpjs devolve um FeatureCollection, ou um array deles se o .zip tiver
    // mais do que um Shapefile lá dentro — juntamos tudo numa única camada.
    const geojson = Array.isArray(parsed)
      ? {type:'FeatureCollection', features: parsed.flatMap(fc => (fc && fc.features) || [])}
      : parsed;

    const result = pbCreateLayerFromFeatureCollection(geojson, layerName);
    statusEl.textContent = `✓ Camada "${layerName}" criada com ${result.imported} geometria(s).`;
  }catch(err){
    console.error('Erro ao importar do portal:', err);
    statusEl.textContent = `⚠ Não foi possível carregar "${layerName}" (${err.message || 'erro desconhecido'}).`;
  }
}

/* ============================================================
   UI — abrir/fechar painel, pesquisa de município, lista de conteúdos,
   lista de sub-camadas OSM
   ============================================================ */
(function wirePortalBridgeUI(){
  const btn = document.getElementById('btn-portal-bridge');
  const panel = document.getElementById('portal-bridge-panel');
  if(!btn || !panel) return;

  let selectedEntry = null;   // {m, d} vindo da pesquisa
  let selectedMunData = null; // registo correspondente em municipios.json (pode ser null)

  function positionPanel(){
    const rect = btn.getBoundingClientRect();
    const width = panel.offsetWidth || 320;
    let left = rect.right - width;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    let top = rect.bottom + 8;
    const maxTop = window.innerHeight - 80;
    if(top > maxTop) top = maxTop;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function showView(name){
    ['search', 'contents', 'osm'].forEach(v=>{
      panel.querySelector(`[data-pb-view="${v}"]`).classList.toggle('hidden', v !== name);
    });
  }

  function showSearchView(){
    selectedEntry = null;
    selectedMunData = null;
    showView('search');
    const search = document.getElementById('pb-caop-search');
    search.value = '';
    document.getElementById('pb-caop-results').innerHTML = '';
    search.focus();
  }

  async function showContentsView(entry){
    selectedEntry = entry;
    showView('contents');
    document.getElementById('pb-selected-municipio').textContent = `${entry.m} · ${entry.d}`;
    const statusEl = document.getElementById('pb-content-status');
    statusEl.textContent = 'A carregar conteúdos…';
    document.getElementById('pb-content-list').innerHTML = '';

    try{
      const byName = await pbLoadMunicipiosData();
      selectedMunData = byName[normalizeAccents(entry.m)] || null;
      statusEl.textContent = selectedMunData ? '' : `Sem dados no portal para ${entry.m}.`;
    }catch(err){
      console.error('Erro ao carregar municipios.json:', err);
      statusEl.textContent = '⚠ Não foi possível ligar ao portal (municipios.json).';
    }
    renderContentList();
  }

  function renderContentList(){
    const list = document.getElementById('pb-content-list');
    list.innerHTML = PB_DATASETS.map(ds => {
      const hasData = ds.available && selectedMunData && (ds.isGroup
        ? selectedMunData[ds.field] && Object.keys(selectedMunData[ds.field]).length > 0
        : !!selectedMunData[ds.field]);
      const tag = !ds.available ? 'Em breve' : (hasData ? (ds.isGroup ? 'Ver camadas' : 'Importar') : 'Sem dados');
      const disabled = !ds.available || !hasData;
      return `
        <li class="portal-bridge-content-item${disabled ? ' is-disabled' : ''}" data-pb-dataset="${ds.key}">
          <span class="portal-bridge-content-icon">${PB_ICON}</span>
          <span class="portal-bridge-content-text">
            <b>${ds.label}</b>
            <span>${ds.desc}</span>
          </span>
          <span class="portal-bridge-content-tag">${tag}</span>
        </li>
      `;
    }).join('');

    list.querySelectorAll('.portal-bridge-content-item').forEach(li=>{
      li.addEventListener('click', ()=>{
        const ds = PB_DATASETS.find(d => d.key === li.dataset.pbDataset);
        if(!ds) return;

        const hasData = ds.available && selectedMunData && (ds.isGroup
          ? selectedMunData[ds.field] && Object.keys(selectedMunData[ds.field]).length > 0
          : !!selectedMunData[ds.field]);

        if(!ds.available || !hasData){
          window.open('https://datagispt.gispt.workers.dev/', '_blank', 'noopener');
          return;
        }

        if(ds.isGroup){
          showOsmView(ds);
        } else {
          const layerName = `${ds.label.split(' — ')[0]} – ${selectedEntry.m}`;
          pbImportZip(selectedMunData[ds.field], layerName, document.getElementById('pb-content-status'));
        }
      });
    });
  }

  function showOsmView(ds){
    showView('osm');
    document.getElementById('pb-osm-title').textContent = `OSM · ${selectedEntry.m}`;
    const statusEl = document.getElementById('pb-osm-status');
    statusEl.textContent = '';

    const zipUrls = selectedMunData[ds.field] || {};
    const list = document.getElementById('pb-osm-list');
    const entries = Object.keys(zipUrls);

    if(!entries.length){
      list.innerHTML = '';
      statusEl.textContent = `Sem camadas OSM disponíveis para ${selectedEntry.m}.`;
      return;
    }

    list.innerHTML = entries.map(layerKey => `
      <li class="portal-bridge-content-item" data-pb-osm-layer="${layerKey}">
        <span class="portal-bridge-content-icon">${PB_ICON}</span>
        <span class="portal-bridge-content-text">
          <b>${pbOsmLayerName(layerKey)}</b>
          <span>${(PB_OSM_META[layerKey] && PB_OSM_META[layerKey].meta) || 'Shapefile'}</span>
        </span>
        <span class="portal-bridge-content-tag">Importar</span>
      </li>
    `).join('');

    list.querySelectorAll('.portal-bridge-content-item').forEach(li=>{
      li.addEventListener('click', ()=>{
        const layerKey = li.dataset.pbOsmLayer;
        const zipUrl = zipUrls[layerKey];
        const layerName = `OSM ${pbOsmLayerName(layerKey)} – ${selectedEntry.m}`;
        pbImportZip(zipUrl, layerName, statusEl);
      });
    });
  }

  function openPanel(){
    panel.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    positionPanel();
    showSearchView();
  }

  function closePanel(){
    panel.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', e=>{
    e.stopPropagation();
    if(panel.classList.contains('hidden')) openPanel();
    else closePanel();
  });

  document.getElementById('portal-bridge-close').addEventListener('click', closePanel);
  document.getElementById('pb-back-btn').addEventListener('click', showSearchView);
  document.getElementById('pb-osm-back-btn').addEventListener('click', ()=> showContentsView(selectedEntry));
  panel.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', closePanel);
  document.addEventListener('keydown', e=>{
    if(e.key === 'Escape') closePanel();
  });
  window.addEventListener('resize', ()=>{
    if(!panel.classList.contains('hidden')) positionPanel();
  });

  /* pesquisa de município (mesma lógica do painel "Limites de município") */
  const caopSearch = document.getElementById('pb-caop-search');
  caopSearch.addEventListener('input', e=>{
    const q = normalizeAccents(e.target.value.trim());
    const resultsEl = document.getElementById('pb-caop-results');
    resultsEl.innerHTML = '';
    if(!q) return;

    const matches = MUNICIPIOS_INDEX
      .filter(it => normalizeAccents(it.m).includes(q))
      .slice(0, 8);

    if(matches.length === 0){
      const li = document.createElement('li');
      li.style.cursor = 'default';
      li.innerHTML = '<span>Nenhum município encontrado.</span>';
      resultsEl.appendChild(li);
      return;
    }

    matches.forEach(it=>{
      const li = document.createElement('li');
      li.innerHTML = `<span>${it.m}</span><span class="distrito">${it.d}</span>`;
      li.addEventListener('click', ()=> showContentsView(it));
      resultsEl.appendChild(li);
    });
  });
})();
