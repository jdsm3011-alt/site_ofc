/* ============================================================
   SISTEMAS DE COORDENADAS — WGS84 (mapa/exportação) e
   ETRS89 / PT-TM06 (EPSG:3763, referência oficial em Portugal)
   ============================================================ */
proj4.defs('EPSG:3763', '+proj=tmerc +lat_0=39.66825833333333 +lon_0=-8.133108333333334 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

var coordMode = 'wgs84'; // 'wgs84' | 'pttm06'
const crsSwitchBtn = document.getElementById('crs-switch');
const coordValueEl = document.getElementById('coord-value');

crsSwitchBtn.addEventListener('click', ()=>{
  coordMode = coordMode === 'wgs84' ? 'pttm06' : 'wgs84';
  const label = coordMode === 'wgs84' ? 'PT-TM06' : 'WGS84';
  crsSwitchBtn.textContent = label;
  if(coordMode === 'wgs84'){
    crsSwitchBtn.title = 'Alternar para ETRS89 / PT-TM06';
  } else {
    crsSwitchBtn.title = 'Alternar para WGS84';
  }
});

function updateCoordBar(lat, lng){
  if(coordMode === 'wgs84'){
    coordValueEl.innerHTML = `<b>${lat.toFixed(5)}, ${lng.toFixed(5)}</b> WGS84`;
  } else {
    const [x, y] = proj4('EPSG:4326', 'EPSG:3763', [lng, lat]);
    coordValueEl.innerHTML = `<b>${x.toFixed(1)}, ${y.toFixed(1)}</b> m PT-TM06`;
  }
}
