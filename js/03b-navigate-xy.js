(function(){
  'use strict';

  var overlay = document.getElementById('coord-xy-overlay');
  var modal = document.getElementById('coord-xy-modal');
  var latInput = document.getElementById('coord-xy-lat');
  var lngInput = document.getElementById('coord-xy-lng');
  var crsLabel = document.getElementById('coord-xy-crs');
  var errorEl = document.getElementById('coord-xy-error');
  var goBtn = document.getElementById('coord-xy-go');
  var cancelBtn = document.getElementById('coord-xy-cancel');
  var closeBtn = document.getElementById('coord-xy-close');
  var xyBtn = document.getElementById('coord-xy-btn');
  var markerLayer = null;
  var pulseTimer = null;

  function openModal(){
    if(typeof coordMode === 'undefined') coordMode = 'wgs84';
    var isPttm06 = coordMode === 'pttm06';
    crsLabel.textContent = isPttm06
      ? 'ETRS89 / PT-TM06 (metros)'
      : 'WGS84 (latitude, longitude)';
    latInput.placeholder = isPttm06 ? 'ex: 130000.0' : 'ex: 39.5573';
    lngInput.placeholder = isPttm06 ? 'ex: -85000.0' : 'ex: -8.1095';
    latInput.value = '';
    lngInput.value = '';
    errorEl.classList.add('hidden');
    overlay.classList.remove('hidden');
    setTimeout(function(){ latInput.focus(); }, 100);
  }

  function closeModal(){
    overlay.classList.add('hidden');
  }

  function showError(msg){
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  function parseCoord(val){
    val = val.trim().replace(',', '.');
    if(val === '') return NaN;
    var n = Number(val);
    if(!Number.isFinite(n)) return NaN;
    return n;
  }

  function goToCoord(){
    if(typeof map === 'undefined' || !map){
      showError('Mapa ainda não está pronto.');
      return;
    }

    var latRaw = latInput.value;
    var lngRaw = lngInput.value;
    var lat = parseCoord(latRaw);
    var lng = parseCoord(lngRaw);

    if(isNaN(lat) || isNaN(lng)){
      showError('Introduz valores numéricos válidos para ambas as coordenadas.');
      return;
    }

    var isPttm06 = typeof coordMode !== 'undefined' && coordMode === 'pttm06';
    var targetLat, targetLng;

    if(isPttm06){
      if(lng < -200000 || lng > 400000 || lat < -200000 || lat > 400000){
        showError('Coordenadas PT-TM06 fora do intervalo esperado para Portugal Continental.');
        return;
      }
      var converted = proj4('EPSG:3763', 'EPSG:4326', [lng, lat]);
      targetLng = converted[0];
      targetLat = converted[1];
    } else {
      if(lat < -90 || lat > 90){
        showError('Latitude deve estar entre -90 e 90.');
        return;
      }
      if(lng < -180 || lng > 180){
        showError('Longitude deve estar entre -180 e 180.');
        return;
      }
      targetLat = lat;
      targetLng = lng;
    }

    if(!Number.isFinite(targetLat) || !Number.isFinite(targetLng)){
      showError('Conversão de coordenadas falhou. Verifica os valores.');
      return;
    }

    errorEl.classList.add('hidden');
    placeTemporaryMarker(targetLat, targetLng);
    map.setView([targetLat, targetLng], Math.max(map.getZoom(), 16));
    closeModal();
  }

  function placeTemporaryMarker(lat, lng){
    if(pulseTimer){ clearTimeout(pulseTimer); pulseTimer = null; }
    if(markerLayer && map.hasLayer(markerLayer)){ map.removeLayer(markerLayer); markerLayer = null; }

    var pulseIcon = L.divIcon({
      className: 'coord-pulse-marker',
      html: '<span class="coord-pulse-inner"></span><span class="coord-pulse-ring"></span>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    markerLayer = L.marker([lat, lng], { icon: pulseIcon, interactive: false }).addTo(map);

    pulseTimer = setTimeout(function(){
      if(markerLayer && map.hasLayer(markerLayer)){
        map.removeLayer(markerLayer);
        markerLayer = null;
      }
    }, 7000);
  }

  function handleKeydown(e){
    if(e.key === 'Enter' && !overlay.classList.contains('hidden')){
      goToCoord();
    }
    if(e.key === 'Escape' && !overlay.classList.contains('hidden')){
      closeModal();
    }
  }

  xyBtn.addEventListener('click', openModal);
  goBtn.addEventListener('click', goToCoord);
  cancelBtn.addEventListener('click', closeModal);
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e){
    if(e.target === overlay) closeModal();
  });
  document.addEventListener('keydown', handleKeydown);

})();
