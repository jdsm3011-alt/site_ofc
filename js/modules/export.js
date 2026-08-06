/* ============================================================
   EXPORTAÇÃO
   ============================================================ */
(function(){
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
  showNotification(message, {type:'success', timeout: 3200});
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
    createTeamProject();
  });
  container.querySelector('#team-resume-btn')?.addEventListener('click', resumeTeamProject);
  container.querySelector('#team-delete-btn')?.addEventListener('click', ()=>{
    const projectName = normalizeTeamProjectName(document.getElementById('team-project-name')?.value || teamState.name);
    const promptText = projectName
      ? `Eliminar o projeto "${projectName}" guardado localmente?`
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
  if(!projectName || !password){ showAppAlert('Fornece um nome de projeto e password.'); return; }

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
      showAppAlert('Já existe um projeto com esse nome. Escolhe outro nome.', {error: true});
    } else {
      console.error('Erro ao criar projeto de equipa:', err);
      showAppAlert('Não foi possível criar o projeto. ' + (err.message || 'Verifica a ligação ao servidor.'), {error: true});
    }
  }
}

async function resumeTeamProject(){
  const nameInput = document.getElementById('team-project-name');
  const passInput = document.getElementById('team-project-password');
  const projectName = normalizeTeamProjectName(nameInput?.value || teamState.name);
  const password = passInput?.value || '';
  if(!projectName || !password){ showAppAlert('Fornece o nome do projeto e a password para retomar.'); return; }

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
    if(err.status === 401){ showAppAlert('Password incorreta.', {error: true}); }
    else { console.error(err); showAppAlert('Não foi possível retomar o projeto.', {error: true}); }
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
  try{
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
  }catch(err){
    console.error('[downloadTeamGeoJSON]', err);
    throw err;
  }
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
  if(!teamState.connected){ showAppAlert('Retoma ou cria um projeto de equipa antes de sincronizar.'); return; }
  if(teamState.status === 'syncing'){ return; } // evita chamadas repetidas (duplo clique) enquanto já está a sincronizar
  if(featuresData.size === 0 && teamState.deletedFids.size === 0){ showAppAlert('Ainda não tens geometrias para sincronizar.'); return; }
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
    showAppAlert('Falha na sincronização. O estado anterior foi limpo para evitar inconsistências.', {error: true});
  }
}

async function fetchTeamProjectGeoJSON(){
  try{
    const resumeData = await apiRequest('POST', '/api/projects/resume', {name: teamState.name, password: teamState.password});
    updateTeamMetadata(resumeData);
    return downloadTeamGeoJSON(resumeData);
  }catch(err){
    console.error('[fetchTeamProjectGeoJSON]', err);
    throw err;
  }
}

async function downloadTeamProject(){
  if(!teamState.connected){ showAppAlert('Retoma ou cria um projeto de equipa antes de descarregar.'); return; }
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
    showAppAlert('Falha ao descarregar o projeto.', {error: true});
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
    showAppAlert('Não foi possível gerar a shape , esta ferramenta ainda está em desenvolvimento, apenas está disponivel exportação em Geojson. Pedimos desculpa por qualquer incómodo :( .', {error: true});
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
  try{
    const layers = getExportableLayers();
    const checkedIds = Array.from(document.querySelectorAll('#export-layer-list input[type=checkbox]:checked')).map(cb=>cb.dataset.layerId);
    if(checkedIds.length === 0){ showAppAlert('Seleciona pelo menos uma camada para download.'); return; }
    const format = document.querySelector('input[name="export-format"]:checked').value;
    const crs = document.getElementById('export-crs-select').value;
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
  }catch(err){
    console.error('[export-download]', err);
    showAppAlert('Erro ao exportar camadas.', {error: true});
    const downloadBtn = document.getElementById('export-menu-download');
    if(downloadBtn){ downloadBtn.disabled = false; downloadBtn.textContent = 'Descarregar'; }
    closeExportMenu();
  }
});

window.buildGeoJSON = buildGeoJSON;
window.loadSavedTeam = loadSavedTeam;
window.saveTeamProject = saveTeamProject;
window.clearTeamProject = clearTeamProject;
window.showTeamToast = showTeamToast;
window.TEAM_API_BASE = TEAM_API_BASE;
window.API_REQUEST_TIMEOUT_MS = API_REQUEST_TIMEOUT_MS;
window.apiRequest = apiRequest;
window.normalizeTeamProjectName = normalizeTeamProjectName;
window.renderTeamCard = renderTeamCard;
window.updateTeamMetadata = updateTeamMetadata;
window.createTeamProject = createTeamProject;
window.resumeTeamProject = resumeTeamProject;
window.loadTeamGeometries = loadTeamGeometries;
window.downloadTeamGeoJSON = downloadTeamGeoJSON;
window.mergeTeamGeoJSON = mergeTeamGeoJSON;
window.splitTextToChunks = splitTextToChunks;
window.syncTeamProject = syncTeamProject;
window.fetchTeamProjectGeoJSON = fetchTeamProjectGeoJSON;
window.downloadTeamProject = downloadTeamProject;
window.leaveTeamProject = leaveTeamProject;
window.deleteTeamProjectFromServer = deleteTeamProjectFromServer;
window.showTeamPanel = showTeamPanel;
window.hideTeamPanel = hideTeamPanel;
window.updateTeamSyncSupportVisibility = updateTeamSyncSupportVisibility;
window.initTeamUI = initTeamUI;
window.WGS84_WKT = WGS84_WKT;
window.PTTM06_WKT = PTTM06_WKT;
window.reprojectCoords = reprojectCoords;
window.reprojectGeoJSON = reprojectGeoJSON;
window.downloadGeoJSON = downloadGeoJSON;
window.ringSignedArea = ringSignedArea;
window.rewindRing = rewindRing;
window.rewindPolygonCoords = rewindPolygonCoords;
window.rewindGeometryForShapefile = rewindGeometryForShapefile;
window.rewindGeoJSONForShapefile = rewindGeoJSONForShapefile;
window.exportShapefileZip = exportShapefileZip;
window.getExportableLayers = getExportableLayers;
window.openExportMenu = openExportMenu;
window.closeExportMenu = closeExportMenu;
})();
