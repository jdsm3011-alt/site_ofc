/* === MÓDULO: CONECTIVIDADE === */
/* Online/offline detection, offline session enter/exit,
   connectivity overlay menu, exit/reload handling */
/* Origem: 05-app-main.js linhas 439-647 */
(function(){

/* ---------- online/offline toast ---------- */
function showReconnectedToast(){
  const toast = document.getElementById('connectivity-restored-toast');
  if(!toast) return;
  clearTimeout(toast._hideTimer);
  toast.classList.remove('is-leaving');
  void toast.offsetWidth;
  toast.classList.add('is-visible');
  toast._hideTimer = setTimeout(()=>{
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
  }, 3200);
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

// pendingExitAction e suppressProjectRestoreErrorAlert ficam como globals em 05-app-main.js

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

window.addEventListener('beforeunload', (e)=>{
  if(hasUnsavedChanges()){
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

/* ---------- connectivity offline menu ---------- */
async function renderConnectivityOfflineMenu(){
  try{
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
  }catch(err){
    console.error('[renderConnectivityOfflineMenu]', err);
  }
}

document.getElementById('connectivity-enter-offline-btn').addEventListener('click', async ()=>{
  try{
    const menu = document.getElementById('connectivity-offline-menu');
    const willShow = menu.classList.contains('hidden');
    if(willShow) await renderConnectivityOfflineMenu();
    menu.classList.toggle('hidden', !willShow);
  }catch(err){
    console.error('[connectivity-offline]', err);
  }
});

/* ---------- offline session enter/exit ---------- */
function enterOfflineSession(meta){
  offlineSessionActive = true;
  document.getElementById('connectivity-overlay').classList.add('hidden');
  document.getElementById('connectivity-offline-menu').classList.add('hidden');

  const banner = document.getElementById('connectivity-active-banner');
  document.getElementById('connectivity-active-banner-area').textContent = ` — área "${meta.name || meta.layerKey}"`;
  banner.classList.remove('hidden');

  const b = L.latLngBounds(meta.bounds[0], meta.bounds[1]);
  map.fitBounds(b);
  map.setMaxBounds(b.pad(0.15));

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

/* expor funções usadas por outros módulos */
window.renderConnectivityOfflineMenu = renderConnectivityOfflineMenu;
window.enterOfflineSession = enterOfflineSession;
window.exitOfflineSession = exitOfflineSession;
window.updateConnectivityUI = updateConnectivityUI;
window.requestExit = requestExit;
window.hasUnsavedChanges = hasUnsavedChanges;

})();
