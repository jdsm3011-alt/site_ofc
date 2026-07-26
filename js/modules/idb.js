/* === MÓDULO: IndexedDB & Tile Utils === */
/* IndexedDB wrapper (idbOpen, idbPutTile, idbGetTile, idbSetMeta,
   idbGetAllMeta, idbDeleteMeta), OfflineTileLayer, OfflineWMSTileLayer,
   tile math (tile3857BBox, buildWmsTileUrl, lonLatToTile, tileRangeForBounds,
   buildTilePlan) */
/* Origem: 05-app-main.js — ver remoções correspondentes */
(function(){

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
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction('tiles', 'readwrite');
      tx.objectStore('tiles').put(blob, key);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
  } catch(err) {
    console.error('[IDB] putTile failed:', err);
    return null;
  }
}
async function idbGetTile(key){
  try {
    const db = await idbOpen();
    return new Promise((resolve)=>{
      const tx = db.transaction('tiles', 'readonly');
      const req = tx.objectStore('tiles').get(key);
      req.onsuccess = ()=> resolve(req.result || null);
      req.onerror = ()=> resolve(null);
    });
  } catch(err) {
    console.error('[IDB] getTile failed:', err);
    return null;
  }
}

async function idbSetMeta(meta){
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(meta, meta.id);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
  } catch(err) {
    console.error('[IDB] setMeta failed:', err);
    return null;
  }
}

async function idbGetAllMeta(){
  try {
    const db = await idbOpen();
    return new Promise((resolve)=>{
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').getAll();
      req.onsuccess = ()=> resolve((req.result || []).sort((a,b)=> b.savedAt - a.savedAt));
      req.onerror = ()=> resolve([]);
    });
  } catch(err) {
    console.error('[IDB] getAllMeta failed:', err);
    return [];
  }
}
async function idbDeleteMeta(id){
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').delete(id);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
    });
  } catch(err) {
    console.error('[IDB] deleteMeta failed:', err);
    return null;
  }
}

/* ---------- camada de tiles com cache offline ---------- */
window.OfflineTileLayer = L.TileLayer.extend({
  createTile: function(coords, done){
    const tile = document.createElement('img');
    tile.alt = '';
    const z = coords.z, x = coords.x, y = coords.y;
    const offlineKey = this.options.offlineKey + '_' + z + '_' + x + '_' + y;

    idbGetTile(offlineKey).then(blob=>{
      // a camada pode ter sido removida do mapa enquanto esta consulta ao
      // IndexedDB estava pendente (zoom rápido, troca de basemap ao entrar
      // no modo de georreferenciação, etc.) — nesse caso this._map já é
      // null, e tanto getTileUrl() (TileLayer.WMS) como qualquer uso futuro
      // desta tile por parte do Leaflet rebentam ao tentar fazer unproject()
      // num mapa que já não existe. Sem esta guarda, a exceção escapa de
      // dentro da promise e nunca é apanhada em lado nenhum.
      if(!this._map){
        done(null, tile);
        return;
      }
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
window.OfflineWMSTileLayer = L.TileLayer.WMS.extend({
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
window.lonLatToTile = function(lon, lat, z){
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2 * n);
  return {x, y};
};
window.tileRangeForBounds = function(bounds, z){
  const nw = lonLatToTile(bounds.getWest(), bounds.getNorth(), z);
  const se = lonLatToTile(bounds.getEast(), bounds.getSouth(), z);
  return {minX: Math.min(nw.x, se.x), maxX: Math.max(nw.x, se.x), minY: Math.min(nw.y, se.y), maxY: Math.max(nw.y, se.y)};
};
window.buildTilePlan = function(bounds, minZoom, maxZoom){
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
};

/* expor funções IDB para uso por módulos offline/equipa */
window.idbPutTile = idbPutTile;
window.idbGetTile = idbGetTile;
window.idbSetMeta = idbSetMeta;
window.idbGetAllMeta = idbGetAllMeta;
window.idbDeleteMeta = idbDeleteMeta;

})();
