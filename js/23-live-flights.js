/* ============================================================
   LIVE FLIGHTS — Tráfego aéreo ao vivo (OpenSky Network)
   Usa IPC do Electron (main process) para contornar CORS.
   Em browser, usa fetch direto (pode falhar por CORS).
   ============================================================ */
(function(){
  'use strict';

  // ---- Configuração ---------------------------------------------------

  var WORKER_URL = 'https://dgt-proxy.gispt.workers.dev/opensky';
  var DIRECT_URL = 'https://opensky-network.org/api/states/all';

  function getApiUrl(){
    return WORKER_URL;
  }

  var BBOX = {
    lamin: 36.8,
    lamax: 42.2,
    lomin: -9.6,
    lomax: -6.0,
  };

  var REFRESH_INTERVAL_MS = 20000;
  var REQUEST_TIMEOUT_MS = 15000;

  // ---- Estado interno ---------------------------------------------------

  var _map = null;
  var _layerGroup = null;
  var _enabled = false;
  var _pollTimer = null;
  var _countdownTimer = null;
  var _timerControl = null;
  var _nextRefreshSeconds = Math.ceil(REFRESH_INTERVAL_MS / 1000);
  var _markersByIcao = new Map();
  var _inFlightRequest = false;

  // ---- Utilitários --------------------------------------------------

  function notify(message, type){
    if(typeof window.showNotification === 'function'){
      window.showNotification(message, {type: type || 'info'});
    } else {
      console.warn('[LiveFlights]', message);
    }
  }

  function buildUrl(){
    var base = getApiUrl();
    return base + '?lamin=' + BBOX.lamin + '&lamax=' + BBOX.lamax +
           '&lomin=' + BBOX.lomin + '&lomax=' + BBOX.lomax;
  }

  function fetchJson(url){
    return fetch(url, {cache: 'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- Ícone do avião (SVG rotativo por heading) --------------------

  function buildPlaneIcon(headingDeg, onGround){
    var rotation = Number.isFinite(headingDeg) ? headingDeg : 0;
    var fill = onGround ? '#9ca3af' : '#2563eb';

    var svg =
      '<div style="transform:rotate(' + rotation + 'deg);width:24px;height:24px;">' +
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="' + fill + '" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' +
        '</svg>' +
      '</div>';

    return L.divIcon({
      className: 'live-flight-icon',
      html: svg,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  // ---- Parsing dos state vectors --------------------------------------

  var FIELD = {
    ICAO24: 0, CALLSIGN: 1, ORIGIN_COUNTRY: 2,
    LONGITUDE: 5, LATITUDE: 6, BARO_ALTITUDE: 7,
    ON_GROUND: 8, VELOCITY: 9, TRUE_TRACK: 10,
    VERTICAL_RATE: 11, GEO_ALTITUDE: 13,
  };

  function parseState(state){
    var lat = state[FIELD.LATITUDE];
    var lon = state[FIELD.LONGITUDE];
    if(lat == null || lon == null) return null;
    return {
      icao24: state[FIELD.ICAO24],
      callsign: (state[FIELD.CALLSIGN] || '').trim() || '\u2014',
      originCountry: state[FIELD.ORIGIN_COUNTRY],
      lat: lat, lon: lon,
      baroAltitude: state[FIELD.BARO_ALTITUDE],
      geoAltitude: state[FIELD.GEO_ALTITUDE],
      onGround: Boolean(state[FIELD.ON_GROUND]),
      velocity: state[FIELD.VELOCITY],
      heading: state[FIELD.TRUE_TRACK],
      verticalRate: state[FIELD.VERTICAL_RATE],
    };
  }

  function formatPopup(f){
    var altM = f.baroAltitude != null ? f.baroAltitude : f.geoAltitude;
    var altText = altM != null ? Math.round(altM) + ' m' : 'n/d';
    var speedKmh = f.velocity != null ? Math.round(f.velocity * 3.6) : null;
    var speedText = speedKmh != null ? speedKmh + ' km/h' : 'n/d';
    var headingText = f.heading != null ? Math.round(f.heading) + '\u00b0' : 'n/d';
    var statusText = f.onGround ? 'Em solo' : 'Em voo';
    return '<div style="font-size:13px;line-height:1.5;">' +
      '<strong>' + f.callsign + '</strong><br>' +
      'Pa\u00eds: ' + (f.originCountry || 'n/d') + '<br>' +
      'Estado: ' + statusText + '<br>' +
      'Altitude: ' + altText + '<br>' +
      'Velocidade: ' + speedText + '<br>' +
      'Rumo: ' + headingText + '<br>' +
      '<span style="opacity:.6;font-size:11px;">ICAO24: ' + f.icao24 + '</span>' +
    '</div>';
  }

  // ---- Ciclo de atualização --------------------------------------------

  function refresh(){
    if(!_enabled || _inFlightRequest) return;
    _inFlightRequest = true;

    var url = buildUrl();

    fetchJson(url).then(function(data){
      var states = data.states || [];
      var flights = states.map(parseState).filter(Boolean);
      console.log('[LiveFlights] API OK —', states.length, 'states,', flights.length, 'flights');
      renderFlights(flights);
    })['catch'](function(err){
      if(err && err.name === 'AbortError'){
        console.warn('[LiveFlights] Pedido excedeu o tempo limite.');
      } else {
        var detail = err && err.message ? err.message : String(err);
        console.error('[LiveFlights] Erro:', detail);
        notify('Erro ao obter tr\u00e1fego a\u00e9reo: ' + detail, 'error');
      }
    }).then(function(){
      _inFlightRequest = false;
      resetCountdown();
    });
  }

  function renderFlights(flights){
    if(!_layerGroup){ console.warn('[LiveFlights] _layerGroup is null'); return; }
    var seenIcao = new Set();
    console.log('[LiveFlights] renderFlights:', flights.length, 'aviões');

    flights.forEach(function(flight){
      seenIcao.add(flight.icao24);
      var existing = _markersByIcao.get(flight.icao24);

      if(existing){
        var old = existing.getLatLng();
        existing.setLatLng([flight.lat, flight.lon]);
        existing.setPopupContent(formatPopup(flight));
      } else {
        var icon = buildPlaneIcon(flight.heading, flight.onGround);
        var marker = L.marker([flight.lat, flight.lon], { icon: icon })
          .bindPopup(formatPopup(flight));
        marker.addTo(_layerGroup);
        _markersByIcao.set(flight.icao24, marker);
      }
    });

    for(var entry of _markersByIcao.entries()){
      if(!seenIcao.has(entry[0])){
        _layerGroup.removeLayer(entry[1]);
        _markersByIcao.delete(entry[0]);
      }
    }
  }

  function clearAll(){
    if(_layerGroup) _layerGroup.clearLayers();
    _markersByIcao.clear();
  }

  // ---- Timer de contagem regressiva -----------------------------------

  function createTimerControl(){
    var control = L.control({position: 'bottomleft'});
    control.onAdd = function(){
      var el = L.DomUtil.create('div', 'live-data-timer leaflet-bar leaflet-control');
      el.id = 'live-data-refresh-timer';
      el.textContent = _nextRefreshSeconds + 's';
      L.DomEvent.disableClickPropagation(el);
      return el;
    };
    return control;
  }

  function updateCountdownDisplay(){
    var el = document.getElementById('live-data-refresh-timer');
    if(!el) return;
    el.textContent = _enabled ? (_nextRefreshSeconds + 's') : 'off';
  }

  function startCountdown(){
    stopCountdown();
    _nextRefreshSeconds = Math.ceil(REFRESH_INTERVAL_MS / 1000);
    updateCountdownDisplay();
    _countdownTimer = setInterval(function(){
      if(!_enabled) return;
      _nextRefreshSeconds = Math.max(0, _nextRefreshSeconds - 1);
      updateCountdownDisplay();
    }, 1000);
  }

  function stopCountdown(){
    if(_countdownTimer){ clearInterval(_countdownTimer); _countdownTimer = null; }
  }

  function resetCountdown(){
    if(!_enabled) return;
    _nextRefreshSeconds = Math.ceil(REFRESH_INTERVAL_MS / 1000);
    updateCountdownDisplay();
  }

  // ---- Botão no header + dropdown ------------------------------------

  function updateButton(){
    var btn = document.getElementById('btn-live-flights');
    if(btn){
      btn.classList.toggle('is-active', _enabled);
      btn.setAttribute('aria-pressed', String(_enabled));
    }
    var mainBtn = document.getElementById('btn-live-data');
    if(mainBtn) mainBtn.classList.toggle('is-active', _enabled);
  }

  function closeDropdown(){
    var menu = document.getElementById('live-data-menu');
    var btn = document.getElementById('btn-live-data');
    if(menu) menu.classList.add('hidden');
    if(btn) btn.setAttribute('aria-expanded', 'false');
  }

  function positionDropdown(){
    var btn = document.getElementById('btn-live-data');
    var menu = document.getElementById('live-data-menu');
    if(!btn || !menu) return;
    var rect = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 200)) + 'px';
    menu.style.minWidth = Math.max(160, rect.width) + 'px';
  }

  function handleVisibilityChange(){
    if(document.hidden){
      if(_pollTimer){ clearInterval(_pollTimer); _pollTimer = null; }
      stopCountdown();
    } else if(_enabled && !_pollTimer){
      refresh();
      startCountdown();
      _pollTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
    }
  }

  // ---- API pública --------------------------------------------------

  function init(mapInstance){
    if(!mapInstance){
      console.error('[LiveFlights] init() precisa de uma inst\u00e2ncia Leaflet v\u00e1lida.');
      return;
    }
    _map = mapInstance;
    _layerGroup = L.layerGroup();
    _timerControl = createTimerControl();

    // Botão principal: abre/fecha dropdown
    var mainBtn = document.getElementById('btn-live-data');
    if(mainBtn){
      mainBtn.addEventListener('click', function(e){
        e.stopPropagation();
        var menu = document.getElementById('live-data-menu');
        if(!menu) return;
        var isOpen = !menu.classList.contains('hidden');
        if(isOpen){
          closeDropdown();
        } else {
          menu.classList.remove('hidden');
          mainBtn.setAttribute('aria-expanded', 'true');
          positionDropdown();
        }
      });
    }

    // Fecha dropdown ao clicar fora
    document.addEventListener('click', function(e){
      var menu = document.getElementById('live-data-menu');
      if(!menu || menu.classList.contains('hidden')) return;
      if(e.target.closest('#live-data-menu') || e.target.closest('#btn-live-data')) return;
      closeDropdown();
    });

    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape') closeDropdown();
    });

    window.addEventListener('resize', function(){
      var menu = document.getElementById('live-data-menu');
      if(menu && !menu.classList.contains('hidden')) positionDropdown();
    });
  }

  function enable(){
    if(!_map || !_layerGroup){
      console.error('[LiveFlights] Chama LiveFlights.init(map) antes de enable().');
      return;
    }
    if(_enabled) return;

    _enabled = true;
    _layerGroup.addTo(_map);
    if(_timerControl && _map) _timerControl.addTo(_map);
    console.log('[LiveFlights] enabled — layerGroup added to map, map layers:', Object.keys(_map._layers).length);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    refresh();
    startCountdown();
    _pollTimer = setInterval(refresh, REFRESH_INTERVAL_MS);

    updateButton();
    closeDropdown();
    notify('Tr\u00e1fego a\u00e9reo ao vivo ativado.', 'success');
  }

  function disable(){
    if(!_enabled) return;
    _enabled = false;

    if(_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
    stopCountdown();
    if(_timerControl && _map) _map.removeControl(_timerControl);
    updateCountdownDisplay();

    document.removeEventListener('visibilitychange', handleVisibilityChange);

    if(_map && _layerGroup) _map.removeLayer(_layerGroup);
    clearAll();

    updateButton();
    notify('Tr\u00e1fego a\u00e9reo ao vivo desativado.', 'info');
  }

  function toggle(){
    if(_enabled) disable(); else enable();
  }

  function isEnabled(){ return _enabled; }

  window.LiveFlights = { init: init, enable: enable, disable: disable, toggle: toggle, isEnabled: isEnabled };

})();
