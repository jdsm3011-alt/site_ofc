/* ============================================================
   LIVE LAYERS — Dados ao vivo no mapa (sismos, meteorologia, incêndios, voos)
   USGS: chamada direta (CORS aberto, sem key).
   IPMA e FIRMS: proxy via Cloudflare Worker.
   Voos: delega para módulo 23-live-flights.js.
   ============================================================ */
(function(){
  'use strict';

  var WORKER_BASE = 'https://dgt-proxy.gispt.workers.dev';
  var USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';
  var IPMA_DEFAULT = 'lisboa';

  var BBOX = { lamin: 36.8, lamax: 42.2, lomin: -9.6, lomax: -6.0 };

  var CONFIG = {
    flights: { refreshMs: 20000, name: 'Voos' },
    quakes:  { refreshMs: 60000, name: 'Sismos' },
    weather: { refreshMs: 15 * 60000, name: 'Meteorologia (IPMA)' },
    fires:   { refreshMs: 20 * 60000, name: 'Incêndios' },
  };

  var _map = null;
  var _layers = {};
  var _intervals = {};
  var _enabled = {};

  function notify(msg, type){
    if(typeof window.showNotification === 'function'){
      window.showNotification(msg, {type: type || 'info'});
    }
  }

  function setDot(key, state){
    var btn = document.querySelector('.live-data-toggle[data-layer="'+key+'"]');
    if(!btn) return;
    var dot = btn.querySelector('.ld-status-dot');
    if(dot) dot.setAttribute('data-state', state);
  }

  function updateMainButton(){
    var anyOn = false;
    for(var k in _enabled){
      if(_enabled[k]){ anyOn = true; break; }
    }
    var mainBtn = document.getElementById('btn-live-data');
    if(mainBtn) mainBtn.classList.toggle('is-active', anyOn);
  }

  function currentBbox(){ return BBOX; }

  /* ---------- USGS Sismos (direto, GeoJSON) ---------- */
  function loadQuakes(){
    return fetch(USGS_URL, {cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(geojson){
      if(_layers.quakes) _map.removeLayer(_layers.quakes);
      _layers.quakes = L.geoJSON(geojson, {
        pointToLayer: function(feature, latlng){
          var mag = feature.properties.mag || 0;
          var radius = Math.max(3, mag * 3);
          var color = mag >= 5 ? '#dc2626' : mag >= 4 ? '#f59e0b' : '#3b82f6';
          return L.circleMarker(latlng, {
            radius: radius, fillColor: color, color: '#fff',
            weight: 1, fillOpacity: 0.8
          });
        },
        onEachFeature: function(feature, layer){
          var p = feature.properties;
          layer.bindPopup(
            '<div style="font-size:13px;line-height:1.5;">' +
            '<strong>' + (p.place || 'Sismo') + '</strong><br>' +
            'Magnitude: ' + (p.mag || '?') + '<br>' +
            'Profundidade: ' + Math.round(feature.geometry.coordinates[2]) + ' km<br>' +
            '<span style="opacity:.6;font-size:11px;">' + new Date(p.time).toLocaleString('pt-PT') + '</span>' +
            '</div>'
          );
        }
      });
      _layers.quakes.addTo(_map);
    });
  }

  /* ---------- IPMA Meteorologia (via Worker) ---------- */
  function loadWeather(){
    var municipio = IPMA_DEFAULT;
    var url = WORKER_BASE + '/api/weather?municipio=' + encodeURIComponent(municipio);
    return fetch(url, {cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(data){
      if(!data.data || !data.data.length) return;
      if(_layers.weather) _map.removeLayer(_layers.weather);
      _layers.weather = L.layerGroup();

      var today = data.data[0];
      var lat = parseFloat(data.data[0].latitude);
      var lon = parseFloat(data.data[0].longitude);
      var tempMax = today.tMax;
      var tempMin = today.tMin;
      var desc = today.weatherDesc || 'Sem dados';
      var precip = today.precipitaProb;
      var windDir = today.predWindDir;

      var forecastHtml = data.data.slice(0, 3).map(function(d){
        return '<div style="margin-top:4px;">' +
          '<strong>' + d.forecastDate + '</strong>: ' +
          d.tMin + '°C – ' + d.tMax + '°C, ' +
          (d.weatherDesc || '?') +
          (d.precipitaProb > 0 ? ' (' + d.precipitaProb + '% chuva)' : '') +
          '</div>';
      }).join('');

      var popupHtml =
        '<div style="font-size:13px;line-height:1.5;">' +
        '<strong>Meteorologia — Lisboa (IPMA)</strong><br>' +
        'Hoje: ' + tempMin + '°C – ' + tempMax + '°C<br>' +
        desc + '<br>' +
        'Prob. chuva: ' + precip + '%<br>' +
        'Vento: ' + windDir +
        '<hr style="margin:6px 0;border:none;border-top:1px solid #eee;">' +
        '<strong>Previsão 3 dias:</strong>' +
        forecastHtml +
        '</div>';

      var icon = weatherEmoji(today.idWeatherType);
      var marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'live-weather-icon',
          html: '<div style="font-size:22px;text-shadow:0 1px 3px rgba(0,0,0,.4);">' + icon + '</div>',
          iconSize: [28, 28], iconAnchor: [14, 14]
        })
      }).bindPopup(popupHtml);
      marker.addTo(_layers.weather);
      _layers.weather.addTo(_map);
    });
  }

  function weatherEmoji(code){
    if(code <= 1) return '☀';
    if(code <= 3) return '⛅';
    if(code <= 5) return '☁';
    if(code >= 6 && code <= 14) return '🌧';
    if(code === 15) return '🌦';
    if(code >= 16 && code <= 17) return '🌫';
    if(code === 18) return '❄';
    if(code >= 19 && code <= 21) return '⛈';
    if(code === 22) return '🥶';
    if(code >= 28) return '🌨';
    return '🌤';
  }

  /* ---------- FIRMS Incêndios (via Worker) ---------- */
  function loadFires(){
    var bb = currentBbox();
    var url = WORKER_BASE + '/api/fires?lamin=' + bb.lamin + '&lamax=' + bb.lamax +
              '&lomin=' + bb.lomin + '&lomax=' + bb.lomax;
    return fetch(url, {cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(geojson){
      if(!geojson || !geojson.features || !geojson.features.length) return;
      if(_layers.fires) _map.removeLayer(_layers.fires);
      _layers.fires = L.geoJSON(geojson, {
        pointToLayer: function(feature, latlng){
          var frp = feature.properties.frp || 0;
          var radius = Math.max(4, Math.min(12, frp / 20));
          return L.circleMarker(latlng, {
            radius: radius, fillColor: '#ef4444', color: '#f97316',
            weight: 1, fillOpacity: 0.85
          });
        },
        onEachFeature: function(feature, layer){
          var p = feature.properties;
          layer.bindPopup(
            '<div style="font-size:13px;line-height:1.5;">' +
            '<strong>Incêndio ativo</strong><br>' +
            'FRP: ' + (p.frp || '?') + ' MW<br>' +
            'Confiança: ' + (p.confidence || '?') + '%<br>' +
            'Satélite: ' + (p.satellite || '?') + '<br>' +
            '<span style="opacity:.6;font-size:11px;">' + new Date(p.acq_date).toLocaleString('pt-PT') + '</span>' +
            '</div>'
          );
        }
      });
      _layers.fires.addTo(_map);
    });
  }

  /* ---------- Toggle genérico ---------- */
  function toggle(key, btnEl){
    /* Voos: sempre delega para LiveFlights */
    if(key === 'flights'){
      if(window.LiveFlights && typeof window.LiveFlights.toggle === 'function'){
        window.LiveFlights.toggle();
        var isActive = window.LiveFlights.isEnabled();
        _enabled[key] = isActive;
        setDot(key, isActive ? 'on' : 'off');
        if(btnEl) btnEl.classList.toggle('active', isActive);
        updateMainButton();
      }
      return;
    }

    if(_enabled[key]){
      disable(key, btnEl);
    } else {
      enable(key, btnEl);
    }
  }

  function enable(key, btnEl){
    if(!_map) return;
    _enabled[key] = true;
    setDot(key, 'loading');
    btnEl.classList.add('active');

    var loadFn = {
      quakes: loadQuakes,
      weather: loadWeather,
      fires: loadFires,
    }[key];

    loadFn().then(function(){
      setDot(key, 'on');
      _intervals[key] = setInterval(function(){
        if(!_enabled[key]) return;
        setDot(key, 'loading');
        loadFn().then(function(){ setDot(key, 'on'); })['catch'](function(){
          setDot(key, 'error');
        });
      }, CONFIG[key].refreshMs);
      updateMainButton();
      notify(CONFIG[key].name + ' ativado.', 'success');
    })['catch'](function(e){
      console.error('[LiveLayers] ' + key + ':', e);
      setDot(key, 'error');
      btnEl.classList.remove('active');
      _enabled[key] = false;
      notify('Erro ao carregar ' + CONFIG[key].name + ': ' + (e.message || e), 'error');
    });
  }

  function disable(key, btnEl){
    _enabled[key] = false;
    if(_intervals[key]){ clearInterval(_intervals[key]); _intervals[key] = null; }
    if(_layers[key] && _map){ _map.removeLayer(_layers[key]); _layers[key] = null; }
    btnEl.classList.remove('active');
    setDot(key, 'off');
    updateMainButton();
    notify(CONFIG[key].name + ' desativado.', 'info');
  }

  /* ---------- Init ---------- */
  function init(mapInstance){
    if(!mapInstance){ console.error('[LiveLayers] init() precisa de map.'); return; }
    _map = mapInstance;

    document.querySelectorAll('.live-data-toggle[data-layer]').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        var key = btn.getAttribute('data-layer');
        toggle(key, btn);
      });
    });
  }

  window.LiveLayers = { init: init, toggle: toggle };

})();
