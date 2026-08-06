/**
 * comparison.js — Modo Comparação Sincronizada
 * -------------------------------------------------
 * Permite visualizar múltiplos processamentos lado a lado com mapas
 * sincronizados. Cada painel contém um mapa Leaflet independente com
 * apenas o respetivo overlay de deteção remota.
 */
(function () {
  'use strict';

  // --- Estado -----------------------------------------------------------
  var comparisonMode = false;
  var comparisonMaps = [];  // [{id, map, container, name}]
  var syncing = false;

  // --- Helpers ----------------------------------------------------------

  function getMap() {
    if (typeof map !== 'undefined' && map) return map;
    if (typeof window !== 'undefined' && window.map) return window.map;
    return null;
  }

  function getRasterEntries() {
    if (typeof rasterLayers !== 'undefined' && rasterLayers && rasterLayers.values) {
      return Array.from(rasterLayers.values());
    }
    return [];
  }

  function getGridDimensions(count) {
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    if (count <= 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 3, rows: 2 };
    return { cols: 3, rows: 3 };
  }

  function tileLayerForKey(key) {
    switch (key) {
      case 'claro':
        return L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 24, maxNativeZoom: 19, attribution: ''
        });
      case 'osm':
        return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 24, maxNativeZoom: 19, attribution: ''
        });
      case 'dgt':
        return L.tileLayer.wms('https://cartografia.dgterritorio.gov.pt/wms/ortos2021', {
          layers: 'Ortos2021-RGB', format: 'image/jpeg', transparent: false, version: '1.3.0',
          maxZoom: 24, maxNativeZoom: 20, minZoom: 6, attribution: ''
        });
      case 'sentinel':
        return L.tileLayer.wms('https://tiles.maps.eox.at/wms', {
          layers: (typeof window.__sentinelLayerName !== 'undefined' ? window.__sentinelLayerName : 's2cloudless-2025_3857'),
          format: 'image/jpeg', transparent: false, version: '1.1.1',
          maxZoom: 16, attribution: ''
        });
      case 'satelite':
      default:
        return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 24, maxNativeZoom: 19, attribution: ''
        });
    }
  }

  function getActiveBasemapKey() {
    if (typeof activeBaseLayerKey !== 'undefined') return activeBaseLayerKey;
    if (typeof window !== 'undefined' && window.__activeBaseLayerKey) return window.__activeBaseLayerKey;
    return 'satelite';
  }

  // --- Sincronização ---------------------------------------------------

  var _syncRaf = null;

  function syncMap(sourceMap) {
    if (syncing) return;
    if (_syncRaf) return; // já agendado — descarta chamadas intermédias
    _syncRaf = requestAnimationFrame(function () {
      _syncRaf = null;
      syncing = true;
      var center = sourceMap.getCenter();
      var zoom = sourceMap.getZoom();
      var m = getMap();
      // Sincronizar mapa principal se estiver visível
      if (m && !document.getElementById('map').classList.contains('hidden')) {
        m.setView(center, zoom, { animate: false, noMoveStart: true });
      }
      // Sincronizar todos os mini-mapas
      comparisonMaps.forEach(function (item) {
        if (item.map !== sourceMap) {
          try { item.map.setView(center, zoom, { animate: false, noMoveStart: true }); } catch (e) {}
        }
      });
      syncing = false;
    });
  }

  // --- Construção da grelha --------------------------------------------

  function buildComparisonGrid() {
    var container = document.getElementById('comparison-container');
    if (!container) return;

    var entries = getRasterEntries();
    if (entries.length < 2) return;

    var dims = getGridDimensions(entries.length);
    container.style.gridTemplateColumns = 'repeat(' + dims.cols + ', 1fr)';
    container.style.gridTemplateRows = 'repeat(' + dims.rows + ', 1fr)';
    container.innerHTML = '';

    // Destruir mapas anteriores
    destroyComparisonMaps();

    var m = getMap();
    var center = m ? m.getCenter() : [20, 0];
    var zoom = m ? m.getZoom() : 2;
    var basemapKey = getActiveBasemapKey();

    entries.forEach(function (entry) {
      var panel = document.createElement('div');
      panel.className = 'comparison-panel';

      var label = document.createElement('div');
      label.className = 'comparison-panel-label';
      label.textContent = entry.name || 'Camada';
      panel.appendChild(label);

      var mapDiv = document.createElement('div');
      mapDiv.className = 'comparison-map';
      panel.appendChild(mapDiv);

      container.appendChild(panel);

      // Criar mapa Leaflet independente
      var miniMap;
      try {
        miniMap = L.map(mapDiv, {
          zoomControl: false,
          attributionControl: false,
          maxZoom: 24
        }).setView(center, zoom);
      } catch (e) { return; }

      // Adicionar basemap
      tileLayerForKey(basemapKey).addTo(miniMap);

      // Adicionar overlay deste processamento
      if (entry.overlay) {
        try {
          // Clonar o overlay para não afetar o original
          var bounds = entry.overlay.getBounds();
          var url = entry.overlay._url || entry.dataUrl || entry.url;
          if (url && bounds) {
            L.imageOverlay(url, bounds, {
              opacity: 0.9,
              pane: 'overlayPane',
              zIndex: 250,
              interactive: false
            }).addTo(miniMap);
          }
        } catch (e) {
          // Se não conseguir clonar, tentar adicionar o original
          try { entry.overlay.addTo(miniMap); } catch (e2) {}
        }
      }

      comparisonMaps.push({
        id: entry.id,
        map: miniMap,
        container: panel,
        name: entry.name
      });

      // Sincronizar quando este mapa se move (tempo real)
      miniMap.on('move zoom', function () {
        syncMap(miniMap);
      });
    });

    // Invalidar tamanho de todos os mapas
    setTimeout(function () {
      comparisonMaps.forEach(function (item) {
        try { item.map.invalidateSize(); } catch (e) {}
      });
    }, 100);
  }

  // --- Destruir mapas --------------------------------------------------

  function destroyComparisonMaps() {
    comparisonMaps.forEach(function (item) {
      try {
        item.map.eachLayer(function (layer) {
          item.map.removeLayer(layer);
        });
        item.map.remove();
      } catch (e) {}
    });
    comparisonMaps = [];
  }

  // --- Atualizar visibilidade do botão ---------------------------------

  function updateComparisonButtonVisibility() {
    var btn = document.getElementById('btn-comparison-mode');
    if (!btn) return;
    var entries = getRasterEntries();
    btn.classList.toggle('hidden', entries.length < 2);
  }

  // --- Entrar no modo comparação ---------------------------------------

  function enterComparisonMode() {
    if (comparisonMode) return;
    var entries = getRasterEntries();
    if (entries.length < 2) return;

    comparisonMode = true;

    var mapEl = document.getElementById('map');
    var cmpContainer = document.getElementById('comparison-container');

    if (mapEl) mapEl.classList.add('hidden');
    if (cmpContainer) cmpContainer.classList.remove('hidden');

    buildComparisonGrid();

    // Atualizar botão
    var btn = document.getElementById('btn-comparison-mode');
    if (btn) btn.classList.add('is-active');
  }

  // --- Sair do modo comparação -----------------------------------------

  function exitComparisonMode() {
    if (!comparisonMode) return;
    comparisonMode = false;

    if (_syncRaf) { cancelAnimationFrame(_syncRaf); _syncRaf = null; }
    destroyComparisonMaps();

    var mapEl = document.getElementById('map');
    var cmpContainer = document.getElementById('comparison-container');

    if (cmpContainer) cmpContainer.classList.add('hidden');
    if (mapEl) mapEl.classList.remove('hidden');

    // Invalidar tamanho do mapa principal
    var m = getMap();
    if (m) {
      setTimeout(function () {
        try { m.invalidateSize(); } catch (e) {}
      }, 100);
    }

    // Atualizar botão
    var btn = document.getElementById('btn-comparison-mode');
    if (btn) btn.classList.remove('is-active');
  }

  // --- Toggle ----------------------------------------------------------

  function toggleComparisonMode() {
    if (comparisonMode) exitComparisonMode();
    else enterComparisonMode();
  }

  // --- Exposição global ------------------------------------------------

  window.comparisonMode = {
    enter: enterComparisonMode,
    exit: exitComparisonMode,
    toggle: toggleComparisonMode,
    isActive: function () { return comparisonMode; },
    updateButtonVisibility: updateComparisonButtonVisibility,
    rebuildGrid: function () {
      if (comparisonMode) buildComparisonGrid();
    }
  };

  // --- Wiring ----------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btn-comparison-mode');
    if (btn) {
      btn.addEventListener('click', function () {
        toggleComparisonMode();
      });
    }
  });

})();
