/**
 * 20-sentinel-layer.js
 * ---------------------------------------------------------------------------
 * Basemap adicional: Sentinel-2 cloudless (EOX IT Services GmbH / s2maps.eu)
 *
 * - Serviço WMS público, gratuito, SEM registo/OAuth (ao contrário do
 *   Copernicus Data Space Ecosystem "oficial").
 * - IMPORTANTE: é um mosaico ANUAL sem nuvens, não é imagem em tempo real.
 * - Este módulo permite escolher o ANO do mosaico Sentinel-2 (2017–2025) e o
 *   ANO do basemap satélite padrão da Esri (World Imagery Wayback, 2014→hoje)
 *   a partir do controlo "Escala temporal" no canto inferior esquerdo do mapa
 *   (#sentinel-year-selector), persistindo as escolhas em localStorage.
 * - O controlo é adaptativo: com o basemap "sentinel" ativo mostra os anos do
 *   mosaico Sentinel-2; com qualquer outro basemap (padrão: satélite Esri)
 *   mostra os anos da World Imagery Wayback.
 * - Licença: uso livre com atribuição obrigatória (ver ATTRIBUTION por ano).
 *   Uso não-comercial explicitamente permitido; para uso comercial aplicam-se
 *   condições próprias da EOX (ver https://s2maps.eu).
 * - GetCapabilities: https://tiles.maps.eox.at/wms?service=wms&request=getcapabilities
 *   -> confirmar periodicamente se existe um ano mais recente.
 *
 * INTEGRAÇÃO (arquitetura real do FeatherGIS):
 *   O sistema de basemaps vive em 05-app-main.js/initMap():
 *     - `basemaps` = { satelite, claro, osm, dgt } guardado em `basemapLayers`
 *       e exposto em window.__basemapLayers (mesma referência de objeto).
 *     - `switchBasemap(key)` / `ensureWorkspaceBasemap(key)` iteram esse objeto,
 *       por isso basta adicionar a entrada `sentinel` aí para que o toggle do
 *       menu, a exclusividade (radio), o estado por workspace e a captura de
 *       tiles (vetorização assistida) funcionem sem mais alterações.
 *     - O botão do menu (#basemap-menu button[data-basemap="sentinel"]) é
 *       gerido automaticamente por renderBasemapMenu()/click handler em initMap.
 *
 *   Este ficheiro NÃO adiciona a layer ao mapa por defeito — apenas a cria e a
 *   regista no registry, ficando disponível para o utilizador ativar via menu.
 * ---------------------------------------------------------------------------
 */

(function () {
  'use strict';

  // --- Configuração -----------------------------------------------------

  const SENTINEL_WMS_URL = 'https://tiles.maps.eox.at/wms';

  // Chave do basemap neste projeto (tem de bater com data-basemap do botão).
  const SENTINEL_KEY = 'sentinel';

  // Anos disponíveis no GetCapabilities (julho/2026). A variante "_3857"
  // funciona com EPSG:3857 tanto em WMS 1.1.1 (srs) como em 1.3.0 (crs) —
  // testado com CORS "*".
  const SENTINEL_YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017];
  const YEAR_STORAGE_KEY = 'sentinelCloudlessYear';

  // --- ESRI Wayback World Imagery (basemap satélite padrão) -----------------
  //
  // O basemap "satélite" padrão (World Imagery da Esri) tem um arquivo
  // histórico público: o "World Imagery Wayback" (2014 → hoje, ~195 versões).
  // Cada versão tem um releaseNum opaco que entra no URL dos tiles:
  //   https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{releaseNum}/{z}/{y}/{x}
  // A lista de releases é pública e com CORS "*":
  //   https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
  const ESRI_DEFAULT_TPL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const ESRI_DEFAULT_ATTR = 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics';
  const ESRI_WAYBACK_CONFIG_URL = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
  const ESRI_WAYBACK_ATTR = 'Tiles &copy; Esri — World Imagery Wayback (Source: Esri, Maxar, Earthstar Geographics)';
  const ESRI_WAYBACK_CACHE_KEY = 'esriWaybackConfigCache';
  const ESRI_WAYBACK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias
  const ESRI_YEAR_STORAGE_KEY = 'esriWaybackRelease';

  function sentinelLayerNameForYear(year) {
    return 's2cloudless-' + year + '_3857';
  }

  function makeAttribution(year) {
    return 'Sentinel-2 cloudless &ndash; ' +
      '<a href="https://s2maps.eu" target="_blank" rel="noopener">s2maps.eu</a> ' +
      'by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ' + year + ')';
  }

  // Ano ativo: o guardado em localStorage (validado) ou o mais recente.
  let currentYear = localStorage.getItem(YEAR_STORAGE_KEY);
  if (SENTINEL_YEARS.indexOf(parseInt(currentYear, 10)) === -1) currentYear = '2025';
  currentYear = String(currentYear);
  let currentAttributionText = makeAttribution(currentYear);

  // Ano do basemap satélite Esri: 'latest' (World Imagery atual) ou um
  // releaseNum do Wayback. Lê também a cache local da lista de releases para
  // o primeiro clique no controlo não ficar à espera da rede.
  let esriCurrentRelease = localStorage.getItem(ESRI_YEAR_STORAGE_KEY) || 'latest';
  if (esriCurrentRelease !== 'latest' && !/^\d+$/.test(esriCurrentRelease)) esriCurrentRelease = 'latest';
  let esriWaybackYears = null; // [{ year, releaseNum, dateLabel }], do mais recente para o mais antigo
  try {
    const cached = localStorage.getItem(ESRI_WAYBACK_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.t && parsed.years && Date.now() - parsed.t < ESRI_WAYBACK_CACHE_TTL) {
        esriWaybackYears = parsed.years;
      }
    }
  } catch (e) { /* cache corrompida — ignora */ }

  function esriWaybackTileTpl(releaseNum) {
    return 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/' +
      releaseNum + '/{z}/{y}/{x}';
  }

  // A config é um objeto keyed por releaseNum; cada entrada tem itemTitle
  // ("World Imagery (Wayback 2014-02-20)") e itemURL. IMPORTANTE: o releaseNum
  // NÃO cresce com a data (ex.: 2023-12-07 tem releaseNum menor que
  // 2023-08-31), por isso ordena-se por data. Por ano fica a release mais
  // recente desse ano (é a que melhor representa o aspeto do basemap).
  function buildEsriWaybackYears(raw) {
    const releases = [];
    Object.keys(raw || {}).forEach(function (k) {
      if (!/^\d+$/.test(k)) return;
      const it = raw[k];
      if (!it || typeof it !== 'object') return;
      const m = it.itemTitle && it.itemTitle.match(/\d{4}-\d{2}-\d{2}/);
      if (!m) return;
      const dateLabel = m[0];
      releases.push({ releaseNum: parseInt(k, 10), dateLabel: dateLabel, year: parseInt(dateLabel.slice(0, 4), 10) });
    });
    releases.sort(function (a, b) { return a.dateLabel < b.dateLabel ? 1 : -1; });
    const byYear = {};
    releases.forEach(function (r) { if (!byYear[r.year]) byYear[r.year] = r; });
    return Object.keys(byYear).sort(function (a, b) { return b - a; }).map(function (y) { return byYear[y]; });
  }

  async function loadEsriWaybackYears() {
    if (esriWaybackYears) return esriWaybackYears;
    try {
      const resp = await fetch(ESRI_WAYBACK_CONFIG_URL);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      esriWaybackYears = buildEsriWaybackYears(await resp.json());
      try {
        localStorage.setItem(ESRI_WAYBACK_CACHE_KEY, JSON.stringify({ t: Date.now(), years: esriWaybackYears }));
      } catch (e) { /* quota cheia — não crítico */ }
      return esriWaybackYears;
    } catch (err) {
      console.warn('[sentinel-layer] Não foi possível obter os anos Wayback da Esri:', err);
      return [];
    }
  }

  // --- Criação da layer ---------------------------------------------------
  //
  // Usa OfflineWMSTileLayer (js/modules/idb.js) quando disponível, para que a
  // camada também possa ser cacheada no modo offline — mesma convenção da DGT.
  // Fallback: L.tileLayer.wms normal. O offlineKey inclui o ano para que tiles
  // de anos diferentes não se misturem na cache IndexedDB.

  function createSentinelLayer() {
    const options = {
      layers: sentinelLayerNameForYear(currentYear),
      format: 'image/jpeg',
      transparent: false,
      version: '1.1.1',
      maxZoom: 16,
      minZoom: 0,
      attribution: currentAttributionText
    };

    if (typeof window.OfflineWMSTileLayer === 'function') {
      return new window.OfflineWMSTileLayer(SENTINEL_WMS_URL, Object.assign({}, options, {
        offlineKey: 'sentinel-' + currentYear
      }));
    }
    return L.tileLayer.wms(SENTINEL_WMS_URL, options);
  }

  const sentinelCloudlessLayer = createSentinelLayer();

  // Nome da layer ativa, exposto para módulos que constroem os seus próprios
  // tiles WMS (ex.: js/09-layouts.js nos mini-mapas dos frames).
  window.__sentinelLayerName = sentinelLayerNameForYear(currentYear);

  // Toast/alerta de erro em tiles (só quando o sistema de alertas existe).
  sentinelCloudlessLayer.on('tileerror', function (err) {
    console.warn('[sentinel-layer] Falha ao carregar tile Sentinel-2 cloudless:', err);
    if (typeof window.showAppAlert === 'function') {
      window.showAppAlert('Não foi possível carregar a camada Sentinel-2 (satélite).', { error: true });
    }
  });

  // --- Troca de ano (mosaico) ---------------------------------------------

  function getMapInstance() {
    // ATENÇÃO: `map` é uma global lexical (let map em 05-app-main.js), por isso
    // `window.map` aponta para o <div id="map"> (auto-global de elementos com
    // id), NÃO para o mapa Leaflet. Tem de se verificar o `map` global direto
    // e confirmar que é um mapa real (tem addControl) antes de o usar.
    if (typeof map !== 'undefined' && map && typeof map.addControl === 'function') return map;
    if (typeof window.map !== 'undefined' && window.map && typeof window.map.addControl === 'function') return window.map;
    return null;
  }

  function setSentinelYear(year, opts) {
    opts = opts || {};
    year = String(year);
    if (SENTINEL_YEARS.indexOf(parseInt(year, 10)) === -1) return;

    const layerName = sentinelLayerNameForYear(year);
    const newAttr = makeAttribution(year);
    const oldAttr = currentAttributionText;
    const changed = year !== currentYear;

    sentinelCloudlessLayer.setParams({ layers: layerName });
    sentinelCloudlessLayer.options.offlineKey = 'sentinel-' + year;
    sentinelCloudlessLayer.options.attribution = newAttr;

    // Mantém o download offline (BASE_LAYERS_INFO em 05-app-main.js) a par do
    // ano escolhido — é lido pelo módulo offline.js quando estima/descarrega.
    try {
      if (typeof BASE_LAYERS_INFO !== 'undefined' && BASE_LAYERS_INFO.sentinel && BASE_LAYERS_INFO.sentinel[0]) {
        BASE_LAYERS_INFO.sentinel[0].wmsLayer = layerName;
      }
    } catch (e) { /* não crítico */ }

    // Atualiza o crédito obrigatório no controlo de atribuição do Leaflet.
    try {
      const m = getMapInstance();
      if (m && m.attributionControl && oldAttr !== newAttr) {
        m.attributionControl.removeAttribution(oldAttr);
        m.attributionControl.addAttribution(newAttr);
      }
    } catch (e) { /* não crítico */ }

    currentYear = year;
    currentAttributionText = newAttr;
    window.__sentinelLayerName = layerName;
    localStorage.setItem(YEAR_STORAGE_KEY, year);
    syncYearButtons();

    if (changed && opts.toast && typeof showBasemapToast === 'function') {
      showBasemapToast('Sentinel-2 cloudless — mosaico de ' + year + '.');
    }
  }

  window.setSentinelYear = setSentinelYear;

  // --- Troca de ano do basemap satélite Esri (World Imagery Wayback) ------

  function getEsriSatelliteLayer() {
    try {
      if (window.__esriSatelliteLayer && typeof window.__esriSatelliteLayer.setUrl === 'function') {
        return window.__esriSatelliteLayer;
      }
      // fallback: procura dentro do grupo registado em window.__basemapLayers
      const group = window.__basemapLayers && window.__basemapLayers.satelite;
      if (group && typeof group.getLayers === 'function') {
        const l = group.getLayers()[0];
        if (l && typeof l.setUrl === 'function') return l;
      }
    } catch (e) { /* não crítico */ }
    return null;
  }

  function esriYearLabelForRelease(release) {
    release = String(release || 'latest');
    if (release === 'latest') {
      return (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t('txt.mais_recente') : 'Mais recente';
    }
    if (esriWaybackYears) {
      for (let i = 0; i < esriWaybackYears.length; i++) {
        if (String(esriWaybackYears[i].releaseNum) === release) return String(esriWaybackYears[i].year);
      }
    }
    return 'Wayback ' + release;
  }

  function setEsriYear(release, opts) {
    opts = opts || {};
    release = String(release || 'latest');
    if (release !== 'latest' && !/^\d+$/.test(release)) return;

    const layer = getEsriSatelliteLayer();
    const m = getMapInstance();
    const isLatest = release === 'latest';
    const tpl = isLatest ? ESRI_DEFAULT_TPL : esriWaybackTileTpl(release);
    const offlineKey = isLatest ? 'satellite' : 'satellite-wb-' + release;
    const newAttr = isLatest ? ESRI_DEFAULT_ATTR : ESRI_WAYBACK_ATTR;
    const changed = release !== esriCurrentRelease;

    if (layer) {
      layer.setUrl(tpl);
      layer.options.offlineKey = offlineKey;
      const oldAttr = layer.options.attribution;
      layer.options.attribution = newAttr;
      // Atualiza o crédito no controlo de atribuição do Leaflet quando a layer
      // já está no mapa (o Leaflet não relê options.attribution depois do add;
      // quando ainda não está no mapa, lê-o no momento em que for adicionada).
      try {
        if (m && m.attributionControl && m.hasLayer(layer) && oldAttr !== newAttr) {
          m.attributionControl.removeAttribution(oldAttr);
          m.attributionControl.addAttribution(newAttr);
        }
      } catch (e) { /* não crítico */ }
    }

    // Mantém o download offline (BASE_LAYERS_INFO em 05-app-main.js) a par do
    // ano escolhido — é lido pelo módulo offline.js quando estima/descarrega.
    try {
      if (typeof BASE_LAYERS_INFO !== 'undefined' && BASE_LAYERS_INFO.satelite && BASE_LAYERS_INFO.satelite[0]) {
        BASE_LAYERS_INFO.satelite[0].tpl = tpl;
        BASE_LAYERS_INFO.satelite[0].key = offlineKey;
      }
    } catch (e) { /* não crítico */ }

    esriCurrentRelease = release;
    localStorage.setItem(ESRI_YEAR_STORAGE_KEY, release);
    syncYearButtons();

    if (changed && opts.toast && typeof showBasemapToast === 'function') {
      showBasemapToast('Esri satélite — ' + esriYearLabelForRelease(release) + '.');
    }
  }

  window.setEsriYear = setEsriYear;

  // --- Seletor de ano: controlo permanente no canto inferior esquerdo --------
  //
  // Os anos são construídos em #sentinel-year-options (dentro do controlo
  // #sentinel-year-selector, no canto inferior esquerdo do mapa). O botão
  // "Escala temporal" expande/colapsa o painel de anos.
  // buildYearSelector()/syncYearButtons() percorrem esse contentor.

  // Modo do controlo: com o basemap "sentinel" ativo mostra os anos do mosaico
  // Sentinel-2; com qualquer outro (padrão: satélite Esri) mostra os anos da
  // World Imagery Wayback.
  function yearControlMode() {
    return window.__activeBaseLayerKey === 'sentinel' ? 'sentinel' : 'esri';
  }

  // O controlo "Escala temporal" só faz sentido nos basemaps com história
  // temporal: satélite Esri (Wayback) e Sentinel-2. Nos restantes é ocultado.
  const TIME_BASEMAP_KEYS = ['satelite', 'sentinel'];

  function updateYearControlVisibility() {
    const el = window.__yearControlEl;
    if (!el) return;
    const key = window.__activeBaseLayerKey;
    const show = TIME_BASEMAP_KEYS.indexOf(key) !== -1;
    el.style.display = show ? '' : 'none';
    if (!show) {
      // fecha o painel para não ficar aberto sem o botão visível
      const wrap = document.getElementById('sentinel-year-selector');
      const btn = el.querySelector ? el.querySelector('.sentinel-year-trigger') : null;
      if (wrap && !wrap.classList.contains('hidden')) wrap.classList.add('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    } else {
      buildYearSelector();
    }
  }

  let yearControlModeBuilt = null;

  function addYearOptionButton(optsEl, text, release, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.dataset.esriRelease = String(release);
    b.setAttribute('title', title);
    b.addEventListener('click', function () {
      setEsriYear(b.dataset.esriRelease, { toast: true });
    });
    optsEl.appendChild(b);
  }

  function buildYearSelector() {
    const optsEl = document.getElementById('sentinel-year-options');
    if (!optsEl) return;
    const mode = yearControlMode();

    // label adaptativo ao basemap ativo
    const labelEl = document.querySelector('#sentinel-year-selector .basemap-year-label');
    if (labelEl) {
      labelEl.setAttribute('data-i18n', mode === 'sentinel' ? 'txt.ano_sentinel2' : 'txt.ano_esri');
    }

    if (mode !== yearControlModeBuilt) {
      yearControlModeBuilt = mode;
      optsEl.innerHTML = '';
      if (mode === 'sentinel') {
        SENTINEL_YEARS.forEach(function (year) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = String(year);
          b.dataset.sentinelYear = String(year);
          b.setAttribute('title', 'Sentinel-2 cloudless ' + year);
          b.addEventListener('click', function () {
            setSentinelYear(b.dataset.sentinelYear, { toast: true });
          });
          optsEl.appendChild(b);
        });
      } else {
        const latestLabel = (window.i18n && typeof window.i18n.t === 'function')
          ? window.i18n.t('txt.mais_recente')
          : 'Mais recente';
        addYearOptionButton(optsEl, latestLabel, 'latest', 'World Imagery (atual)');
        if (esriWaybackYears && esriWaybackYears.length) {
          esriWaybackYears.forEach(function (r) {
            addYearOptionButton(optsEl, String(r.year), r.releaseNum, 'World Imagery (Wayback ' + r.dateLabel + ')');
          });
        } else {
          // primeiro acesso: a lista ainda está a chegar — busca e preenche
          loadEsriWaybackYears().then(function (years) {
            if (years && years.length && yearControlMode() === 'esri') {
              yearControlModeBuilt = null;
              buildYearSelector();
            }
          });
        }
      }
    }

    syncYearButtons();
    // garante tradução do label caso o seletor seja injetado depois do i18n
    if (window.i18n && typeof window.i18n.apply === 'function') {
      try {
        window.i18n.apply(document.getElementById('sentinel-year-selector'));
      } catch (e) {}
    }
  }

  function syncYearButtons() {
    const optsEl = document.getElementById('sentinel-year-options');
    if (!optsEl) return;
    if (yearControlMode() === 'sentinel') {
      Array.prototype.forEach.call(optsEl.querySelectorAll('button[data-sentinel-year]'), function (b) {
        b.classList.toggle('is-active', b.dataset.sentinelYear === String(currentYear));
      });
    } else {
      Array.prototype.forEach.call(optsEl.querySelectorAll('button[data-esri-release]'), function (b) {
        b.classList.toggle('is-active', b.dataset.esriRelease === String(esriCurrentRelease));
      });
    }
  }

  // Controlo Leaflet permanente (canto inferior esquerdo): botão "Escala
  // temporal" + painel de anos expandível.
  const SentinelYearControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'sentinel-year-control leaflet-control');
      window.__yearControlEl = container;
      const btn = L.DomUtil.create('button', 'sentinel-year-trigger', container);
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.innerHTML = '<span data-i18n="txt.escala_temporal">Escala temporal</span>';

      const wrap = L.DomUtil.create('div', 'basemap-year-wrap hidden', container);
      wrap.id = 'sentinel-year-selector';
      const label = L.DomUtil.create('span', 'basemap-year-label', wrap);
      label.setAttribute('data-i18n', 'txt.ano_sentinel2');
      label.textContent = 'Ano Sentinel-2';
      const opts = L.DomUtil.create('div', 'basemap-year-options', wrap);
      opts.id = 'sentinel-year-options';

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);

      L.DomEvent.on(btn, 'click', function (e) {
        L.DomEvent.stop(e);
        const open = wrap.classList.toggle('hidden') === false;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) buildYearSelector();
      });

      return container;
    }
  });

  function addYearControl() {
    const m = getMapInstance();
    if (m && !window.__sentinelYearControlAdded) {
      m.addControl(new SentinelYearControl());
      window.__sentinelYearControlAdded = true;
      buildYearSelector();
      updateYearControlVisibility();
      console.info('[sentinel-layer] Seletor de ano adicionado ao canto inferior esquerdo.');
    }
    return !!(m && window.__sentinelYearControlAdded);
  }

  // --- Registo no sistema de basemaps existente ---------------------------

  const REGISTRY_KEY = '__basemapLayers';

  function tryRegister() {
    const registry = window[REGISTRY_KEY];
    if (!registry || typeof registry !== 'object') return false;
    if (registry[SENTINEL_KEY]) return true; // já registado
    registry[SENTINEL_KEY] = sentinelCloudlessLayer;
    console.info('[sentinel-layer] Basemap "' + SENTINEL_KEY + '" registado em window.__basemapLayers.');
    return true;
  }

  function applyStoredEsriYear() {
    if (esriCurrentRelease !== 'latest') {
      try { setEsriYear(esriCurrentRelease); } catch (e) { /* não crítico */ }
    }
  }

  // Mostra/oculta o controlo "Escala temporal" quando o basemap muda
  // (evento despachado por switchBasemap em 05-app-main.js).
  document.addEventListener('basemap:changed', function () {
    updateYearControlVisibility();
  });

  function init() {
    const regOk = tryRegister();
    const ctlOk = addYearControl();
    if (regOk && ctlOk) {
      applyStoredEsriYear();
      return;
    }
    // initMap() ainda não correu (window.__basemapLayers ou o mapa ainda não
    // existem). Tenta de novo até ~5s.
    let attempts = 0;
    const timer = setInterval(function () {
      attempts++;
      const rOk = tryRegister();
      const cOk = addYearControl();
      if (rOk && cOk) {
        clearInterval(timer);
        applyStoredEsriYear();
      } else if (attempts >= 10) {
        clearInterval(timer);
        console.warn(
          '[sentinel-layer] Não foi possível registar automaticamente. ' +
          'A camada está disponível em window.sentinelCloudlessLayer.'
        );
      }
    }, 500);
  }

  // Este módulo é carregado DEPOIS de init.js (que chama initMap), pelo que o
  // registry normalmente já existe; init() cobre também o caso contrário.
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // Exposição para debug/consola e para outros módulos que queiram referenciar
  // a layer diretamente (ex.: toggle programático).
  window.sentinelCloudlessLayer = sentinelCloudlessLayer;
  window.sentinelCloudlessLayerDefinition = {
    id: SENTINEL_KEY,
    label: 'Satélite (Sentinel-2 cloudless)',
    group: 'basemap',
    layer: sentinelCloudlessLayer,
    defaultActive: false,
    meta: {
      source: 'EOX IT Services GmbH / s2maps.eu',
      updateFrequency: 'mosaico anual (não é imagem em tempo real)',
      requiresAuth: false
    }
  };
})();
