/**
 * 21-ndvi.js
 * ---------------------------------------------------------------------------
 * Análise de índices espectrais (NDVI/NBR/NDWI/NDBI) a partir de
 * Sentinel-2 L2A — 100% no browser.
 *
 * Fluxo:
 *   1. Utilizador ativa a ferramenta (itens .satellite-index-item do menu de
 *      satélite, um por índice) e desenha um retângulo no mapa.
 *   2. O módulo procura a cena Sentinel-2 L2A mais recente com pouca cobertura
 *      de nuvens que cubra essa área, via STAC do Element 84
 *      (https://earth-search.aws.element84.com/v1/search — público, CORS "*",
 *      sem auth).
 *   3. Lê apenas o recorte da área das duas bandas do índice (COG com range
 *      requests) com geotiff.js, aplica a máscara SCL (nuvens/sombra) quando
 *      disponível, e calcula (bandA - bandB) / (bandA + bandB).
 *   4. Desenha o resultado num canvas com o color-ramp do índice e mostra-o
 *      como L.imageOverlay sobre o retângulo, com um painel de estatísticas
 *      (média, mín/máx, desvio, percentagens dos limiares, área) e exportação
 *      PNG.
 *
 * PORQUE não usar o basemap Sentinel-2 cloudless (js/20-sentinel-layer.js)?
 *   O mosaico da EOX/s2maps é RGB (sem banda NIR), por isso é impossível
 *   derivar índices a partir dele. As cenas L2A "cruas" do Element 84 têm as
 *   bandas espectrais necessárias (B03/B04/B08/B11/B12 + SCL).
 *
 * INTEGRAÇÃO:
 *   - Segue o padrão do módulo offline/régua: banner de desenho
 *     (#ndvi-banner), flag global `ndviDrawing` (usada como guarda em
 *     onFeatureCreated() em 05-app-main.js para o retângulo não virar
 *     geometria do projeto) e handler `map.on('pm:create')`.
 *   - Não depende de window.__basemapLayers; usa só globais já existentes:
 *     map, GeoTIFF (geotiff.js 3.0.5), proj4, turf, showAppAlert, i18n.
 * ---------------------------------------------------------------------------
 */

// Flag de desenho NDVI em âmbito GLOBAL (fora da IIFE) para que a guarda
// `ndviDrawing` em onFeatureCreated() (js/05-app-main.js) a consiga ler —
// tal como offlineDrawing/rulerDrawing (05-app-main.js) e vaDrawingActive.
var ndviDrawing = false;

(function () {
  'use strict';

  // --- Configuração ------------------------------------------------------

  var STAC_ENDPOINT = 'https://earth-search.aws.element84.com/v1/search';

  // Limites de segurança de memória/canvas: dimensão máxima por lado e total
  // de pixels da grelha NDVI resultante (não da imagem de origem).
  var MAX_OUTPUT_DIM = 1600;
  var MAX_OUTPUT_PIXELS = 1600 * 1600;

  // Classes SCL (Scene Classification) consideradas "más" → mascaradas:
  // 0 = no data, 1 = saturado, 3 = sombra de nuvem, 7 = não classificado,
  // 8/9/10 = nuvem média/alta/cirrus, 11 = neve/gelo.
  var SCL_BAD = { 0: 1, 1: 1, 3: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1 };

  // Índices espectrais suportados. Cada índice define:
  //   - key/label    identificador e nome curto;
  //   - bandA/bandB  assets STAC das duas bandas; fórmula sempre
  //                  (bandA − bandB) / (bandA + bandB) — por isso a banda
  //                  do numerador vem em bandA;
  //   - pos/neg      limiares e rótulos (i18n) das duas percentagens de
  //                  estatísticas exibidas no painel;
  //   - drawHint     texto do banner enquanto se desenha o retângulo;
  //   - stops        color-ramp (valor → cor RGB).
  // Banda "a" define também a grelha de cálculo (10m para ndvi/nbr/ndwi,
  // 20m para ndbi); a banda "b" é lida na sua própria resolução (20m no
  // NBR/NDBI) e reamostrada para a grelha de saída.
  var INDEXES = {
    ndvi: {
      key: 'ndvi',
      label: 'NDVI',
      bandA: 'nir', bandB: 'red',
      posThreshold: 0.3, negThreshold: 0.1,
      posLabelKey: 'txt.percentagem_vegeta_o_ndvi_0_3',
      posLabel: '% vegetação (NDVI > 0,3)',
      negLabelKey: 'txt.percentagem_gu_ndvi_0_1',
      negLabel: '% água (NDVI < 0,1)',
      drawHintKey: 'txt.desenha_um_ret_ngulo_no_mapa_para_analisar_ndvi',
      drawHint: 'Desenha um retângulo no mapa para analisar NDVI',
      stops: [
        [-0.25, [60, 80, 160]],     // água
        [0.00, [150, 120, 85]],     // solo nu / água turva
        [0.15, [225, 205, 120]],    // solo com vegetação rala
        [0.30, [170, 200, 80]],     // vegetação esparsa
        [0.45, [95, 170, 60]],      // vegetação moderada
        [0.60, [45, 140, 50]],      // vegetação densa
        [0.90, [25, 110, 40]]       // vegetação muito densa
      ]
    },
    nbr: {
      key: 'nbr',
      label: 'NBR',
      bandA: 'nir', bandB: 'swir22',
      posThreshold: 0.3, negThreshold: 0.1,
      posLabelKey: 'txt.nbr_vegeta_o_saud_vel',
      posLabel: '% vegetação saudável (NBR > 0,3)',
      negLabelKey: 'txt.nbr_rea_queimada',
      negLabel: '% área queimada (NBR < 0,1)',
      drawHintKey: 'txt.desenha_um_ret_ngulo_no_mapa_para_analisar_nbr',
      drawHint: 'Desenha um retângulo no mapa para analisar NBR',
      stops: [
        [-0.90, [180, 70, 50]],     // queimada severa (vermelho escuro)
        [-0.50, [215, 120, 70]],    // queimada moderada
        [-0.15, [235, 175, 110]],   // queimada ligeira
        [0.10, [220, 215, 160]],    // regeneração / solo
        [0.35, [160, 205, 130]],    // vegetação rala
        [0.60, [100, 170, 95]],     // vegetação saudável
        [0.90, [45, 130, 60]]       // vegetação densa e saudável
      ]
    },
    ndwi: {
      key: 'ndwi',
      label: 'NDWI',
      bandA: 'green', bandB: 'nir',
      posThreshold: 0.2, negThreshold: 0.1,
      posLabelKey: 'txt.ndwi_rea_gu',
      posLabel: '% água (NDWI > 0,2)',
      negLabelKey: 'txt.ndwi_rea_seca',
      negLabel: '% não-água (NDWI < 0,1)',
      drawHintKey: 'txt.desenha_um_ret_ngulo_no_mapa_para_analisar_ndwi',
      drawHint: 'Desenha um retângulo no mapa para analisar NDWI',
      stops: [
        [-0.90, [170, 150, 110]],   // solo seco / urbano
        [-0.40, [200, 185, 135]],   // solo húmido
        [-0.10, [150, 175, 175]],   // humidade/água turva
        [0.15, [90, 145, 190]],     // água
        [0.40, [40, 105, 185]],     // água limpa
        [0.70, [20, 70, 165]],      // água profunda
        [1.00, [10, 45, 150]]       // água muito profunda
      ]
    },
    ndbi: {
      key: 'ndbi',
      label: 'NDBI',
      bandA: 'swir16', bandB: 'nir',
      posThreshold: 0.0, negThreshold: -0.1,
      posLabelKey: 'txt.ndbi_rea_constru_da',
      posLabel: '% área construída (NDBI > 0)',
      negLabelKey: 'txt.ndbi_rea_vegetal',
      negLabel: '% vegetação (NDBI < −0,1)',
      drawHintKey: 'txt.desenha_um_ret_ngulo_no_mapa_para_analisar_ndbi',
      drawHint: 'Desenha um retângulo no mapa para analisar NDBI',
      stops: [
        [-0.90, [30, 120, 45]],     // vegetação densa
        [-0.35, [110, 165, 90]],    // vegetação
        [-0.05, [195, 190, 150]],   // solo
        [0.15, [225, 200, 160]],    // construção dispersa
        [0.35, [235, 195, 150]],    // construção
        [0.60, [225, 170, 135]],    // área urbana densa
        [0.90, [200, 150, 120]]     // centro urbano (alto NDBI)
      ]
    }
  };
  var MASK_COLOR = [235, 235, 235, 110];

  // --- Estado -------------------------------------------------------------

  var ndviProcessing = false;
  var ndviActiveIndex = 'ndvi';
  var ndviOverlayLayer = null;
  var currentDataUrl = null;
  var currentResultKey = 'ndvi';

  // --- Helpers ------------------------------------------------------------

  function getMap() {
    if (typeof map !== 'undefined' && map) return map;
    if (typeof window !== 'undefined' && window.map) return window.map;
    return null;
  }

  function _t(key, fallback) {
    try {
      if (window.i18n && typeof window.i18n.t === 'function') {
        var v = window.i18n.t(key);
        if (v && v !== key) return v;
      }
    } catch (e) {}
    return fallback;
  }

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  // Alterna o banner entre modo desenho (indicador pulsante, botão cancelar)
  // e modo processamento (spinner + barra de progresso, sem cancelar).
  function setBannerProcessing(on) {
    var banner = document.getElementById('ndvi-banner');
    if (banner) banner.classList.toggle('is-processing', !!on);
  }

  function setBannerStatus(text) {
    var el = document.getElementById('ndvi-banner-text');
    if (el) {
      el.textContent = text;
      // Re-dispara a animação de entrada do texto quando o passo muda.
      if (el.animate && typeof el.animate === 'function') {
        try {
          el.animate(
            [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
            { duration: 220, easing: 'ease-out' }
          );
        } catch (e) {}
      }
    }
    var banner = document.getElementById('ndvi-banner');
    if (banner) banner.style.display = 'flex';
  }

  // Definição proj4 para zonas UTM (fallback caso a proj4.js não traga a EPSG
  // da cena registada — as cenas do Element 84 estão quase sempre em UTM/WGS84).
  function projDefForEpsg(epsg) {
    if (epsg >= 32601 && epsg <= 32660) {
      return '+proj=utm +zone=' + (epsg - 32600) + ' +datum=WGS84 +units=m +no_defs';
    }
    if (epsg >= 32701 && epsg <= 32760) {
      return '+proj=utm +zone=' + (epsg - 32700) + ' +south +datum=WGS84 +units=m +no_defs';
    }
    return null;
  }

  // Converte [lng, lat] (EPSG:4326) para a CRS da cena.
  function projectTo(epsg, x, y) {
    if (!epsg || epsg === 4326) return [x, y];
    if (typeof proj4 === 'undefined') return [x, y];
    try {
      var key = 'EPSG:' + epsg;
      if (!proj4.defs(key)) {
        var def = projDefForEpsg(epsg);
        if (def) proj4.defs(key, def);
      }
      return proj4('EPSG:4326', key, [x, y]);
    } catch (e) {
      return [x, y];
    }
  }

  // Janela de pixels [left, top, right, bottom] (ordem do geotiff.js) que
  // cobre os limites do retângulo desenhado, dado o origin/resolução da imagem.
  function pixelWindowForBounds(bounds, epsg, origin, resolution, imgWidth, imgHeight) {
    var sw = projectTo(epsg, bounds.getWest(), bounds.getSouth());
    var ne = projectTo(epsg, bounds.getEast(), bounds.getNorth());
    var resX = resolution[0], resY = resolution[1];
    var left = clamp(Math.floor((sw[0] - origin[0]) / resX), 0, imgWidth - 1);
    var top = clamp(Math.floor((ne[1] - origin[1]) / resY), 0, imgHeight - 1);
    var right = clamp(Math.ceil((ne[0] - origin[0]) / resX), 0, imgWidth);
    var bottom = clamp(Math.ceil((sw[1] - origin[1]) / resY), 0, imgHeight);
    return {
      window: [left, top, right, bottom],
      w: Math.max(1, right - left),
      h: Math.max(1, bottom - top)
    };
  }

  // Dimensão alvo da grelha NDVI respeitando o orçamento de pixels.
  function clampOutputSize(w, h) {
    var scale = Math.min(MAX_OUTPUT_DIM / w, MAX_OUTPUT_DIM / h, 1);
    if (w * h * scale * scale > MAX_OUTPUT_PIXELS) {
      scale = Math.sqrt(MAX_OUTPUT_PIXELS / (w * h));
    }
    return {
      w: Math.max(1, Math.floor(w * scale)),
      h: Math.max(1, Math.floor(h * scale))
    };
  }

  function readBand(img, window, target, method) {
    var opts = { window: window, interleave: false, samples: [0], resampleMethod: method || 'bilinear' };
    if (target && target.w && target.h) {
      opts.width = target.w;
      opts.height = target.h;
    }
    return img.readRasters(opts).then(function (rasters) { return rasters[0]; });
  }

  function downsampleNearest(src, sw, sh, dw, dh) {
    var out = new Float32Array(dw * dh);
    for (var j = 0; j < dh; j++) {
      var sy = Math.floor(j * sh / dh);
      for (var i = 0; i < dw; i++) {
        var sx = Math.floor(i * sw / dw);
        out[j * dw + i] = src[sy * sw + sx];
      }
    }
    return out;
  }

  // --- Recorte por polígono (limite do município) ----------------------------
  // Normaliza um GeoJSON (FeatureCollection / Feature / geometry) para uma
  // geometria Polygon/MultiPolygon utilizável como máscara.
  function geometryFromGeoJSON(gj) {
    if (!gj) return null;
    if (gj.type === 'FeatureCollection') {
      var polys = [];
      (gj.features || []).forEach(function (f) {
        if (!f || !f.geometry) return;
        if (f.geometry.type === 'Polygon') polys.push(f.geometry.coordinates);
        else if (f.geometry.type === 'MultiPolygon') polys = polys.concat(f.geometry.coordinates);
      });
      if (!polys.length) return null;
      return { type: 'MultiPolygon', coordinates: polys };
    }
    if (gj.type === 'Feature') return gj.geometry || null;
    if (gj.type === 'Polygon' || gj.type === 'MultiPolygon') return gj;
    return null;
  }

  // Traça o(s) anel(ns) de uma geometria GeoJSON (Polygon/MultiPolygon) num ctx,
  // projetando cada ponto [lng, lat] para coordenadas de canvas.
  function traceGeometryPath(ctx, geometry, proj) {
    if (!geometry) return;
    var polys = [];
    if (geometry.type === 'Polygon') polys = [geometry.coordinates];
    else if (geometry.type === 'MultiPolygon') polys = geometry.coordinates;
    else return;
    ctx.beginPath();
    for (var p = 0; p < polys.length; p++) {
      var rings = polys[p];
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r];
        if (!ring || !ring.length) continue;
        for (var k = 0; k < ring.length; k++) {
          var pt = proj(ring[k]);
          if (k === 0) ctx.moveTo(pt[0], pt[1]);
          else ctx.lineTo(pt[0], pt[1]);
        }
        ctx.closePath();
      }
    }
  }

  // Máscara W×H (1 = dentro do polígono, 0 = fora) rasterizada por canvas —
  // muito mais rápido do que point-in-polygon por pixel com turf.
  function maskForGeometry(geometry, bounds, W, H) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    var west = bounds.getWest(), north = bounds.getNorth();
    var spanLng = bounds.getEast() - west || 1;
    var spanLat = north - bounds.getSouth() || 1;
    traceGeometryPath(ctx, geometry, function (pt) {
      return [(pt[0] - west) / spanLng * W, (north - pt[1]) / spanLat * H];
    });
    ctx.fillStyle = '#fff';
    ctx.fill('evenodd');
    var px = ctx.getImageData(0, 0, W, H).data;
    var mask = new Uint8Array(W * H);
    for (var i = 0; i < W * H; i++) mask[i] = px[i * 4 + 3] > 0 ? 1 : 0;
    return mask;
  }

  // Desenha o contorno do polígono sobre o canvas (realça o recorte).
  function drawClipOutline(ctx, geometry, bounds, W, H) {
    if (!geometry) return;
    var west = bounds.getWest(), north = bounds.getNorth();
    var spanLng = bounds.getEast() - west || 1;
    var spanLat = north - bounds.getSouth() || 1;
    ctx.save();
    ctx.lineJoin = 'round';
    traceGeometryPath(ctx, geometry, function (pt) {
      return [(pt[0] - west) / spanLng * W, (north - pt[1]) / spanLat * H];
    });
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // --- STAC: procurar a cena Sentinel-2 L2A ---------------------------------

  function cloudOf(f) {
    return typeof f.properties['eo:cloud_cover'] === 'number' ? f.properties['eo:cloud_cover'] : 100;
  }

  async function stacSearch(bbox, start, end) {
    var body = {
      collections: ['sentinel-2-l2a'],
      bbox: bbox,
      datetime: start + '/' + end,
      limit: 10,
      sortby: [{ field: 'properties.datetime', direction: 'desc' }]
    };
    // NOTA: sem "fields" — o filtro de campos do stac-fastapi do Element 84
    // remove "properties.eo:cloud_cover"/"proj:epsg" mesmo quando pedidos
    // explicitamente; sem filtro a resposta é ~40KB/cena e filtramos no cliente.
    var resp = await fetch(STAC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error('STAC HTTP ' + resp.status);
    var data = await resp.json();
    return (data.features || []).filter(function (f) {
      return f.assets && f.assets.red && f.assets.red.href &&
             f.assets.nir && f.assets.nir.href;
    });
  }

  // Procura a cena Sentinel-2. Se `year` (ex.: "2023") for fornecido, limita a
  // pesquisa a esse ano; caso contrário usa os últimos 180 dias e, se nada
  // encontrar, cai para o arquivo desde 2016 (cena menos nublada).
  async function searchSentinelScene(bounds, year) {
    var end = new Date().toISOString();
    var start;
    if (year && /^\d{4}$/.test(String(year))) {
      start = String(year) + '-01-01T00:00:00Z';
      var yearEnd = new Date(parseInt(year, 10) + 1, 0, 1).toISOString();
      if (yearEnd > end) yearEnd = end;
      end = yearEnd;
    } else {
      start = new Date(Date.now() - 180 * 86400000).toISOString();
    }
    var bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];

    var feats = await stacSearch(bbox, start, end);
    if (!year && !feats.length) {
      feats = await stacSearch(bbox, '2016-01-01T00:00:00Z', end);
    }
    if (!feats.length) return null;

    // Menos nuvens primeiro; desempate pela cena mais recente.
    feats.sort(function (a, b) {
      var d = cloudOf(a) - cloudOf(b);
      if (d !== 0) return d;
      return new Date(b.properties.datetime) - new Date(a.properties.datetime);
    });
    return feats[0];
  }

  // CRS da cena: usa properties.proj:epsg; se faltar, infere da zona/banda MGRS.
  function inferEpsg(scene) {
    var p = scene.properties || {};
    if (p['proj:epsg']) return p['proj:epsg'];
    var z = parseInt(p['mgrs:utm_zone'], 10);
    if (z >= 1 && z <= 60) {
      var band = String(p['mgrs:latitude_band'] || '').toUpperCase();
      var north = !band || band >= 'N';
      return north ? (32600 + z) : (32700 + z);
    }
    return null;
  }

  // --- Pipeline: ler bandas + calcular índice --------------------------------

  // Lê uma banda com resize (bilinear) para a grelha `target`; se o reader não
  // suportar resize, relê à resolução nativa (devolvendo resampled=false para
  // o chamador reduzir/ajustar a grelha em JS).
  async function readBandResampled(img, bounds, epsg, target) {
    var win = pixelWindowForBounds(
      bounds, epsg, img.getOrigin(), img.getResolution(),
      img.getWidth(), img.getHeight()
    );
    try {
      return { data: await readBand(img, win.window, target, 'bilinear'), win: win, resampled: true };
    } catch (err) {
      console.warn('[ndvi] readRasters com resize falhou; a reler à resolução nativa.', err);
      return { data: await readBand(img, win.window, null, 'nearest'), win: win, resampled: false };
    }
  }

  // Núcleo do pipeline. A grelha de saída é definida pela banda "a" do índice
  // (10m no NDVI/NBR/NDWI, 20m no NDBI); a banda "b" é lida na sua própria
  // resolução (20m no NBR/NDBI) e reamostrada para essa grelha.
  // `mask` (opcional) é uma geometria GeoJSON (ex.: limite CAOP de um
  // município) — os pixels fora dela ficam NaN (recorte).
  async function fetchAndComputeIndex(bounds, scene, def, mask) {
    if (typeof GeoTIFF === 'undefined' || typeof GeoTIFF.fromUrl !== 'function') {
      throw new Error('geotiff');
    }

    var epsg = inferEpsg(scene) || 32629;
    var aAsset = scene.assets && scene.assets[def.bandA];
    var bAsset = scene.assets && scene.assets[def.bandB];
    if (!aAsset || !bAsset || !aAsset.href || !bAsset.href) {
      throw new Error('bandas em falta: ' + def.bandA + ' / ' + def.bandB);
    }
    var aHref = aAsset.href;
    var bHref = bAsset.href;
    var sclHref = (scene.assets.scl && scene.assets.scl.href) || null;

    var aTiff = await GeoTIFF.fromUrl(aHref);
    var aImg = await aTiff.getImage();
    var bTiff = await GeoTIFF.fromUrl(bHref);
    var bImg = await bTiff.getImage();

    var aWin = pixelWindowForBounds(
      bounds, epsg, aImg.getOrigin(), aImg.getResolution(),
      aImg.getWidth(), aImg.getHeight()
    );
    var target = clampOutputSize(aWin.w, aWin.h);

    var a = await readBandResampled(aImg, bounds, epsg, target);
    var b = await readBandResampled(bImg, bounds, epsg, target);

    var outW = target.w, outH = target.h;
    if (!a.resampled) {
      var sizeA = clampOutputSize(a.win.w, a.win.h);
      if (sizeA.w !== a.win.w || sizeA.h !== a.win.h) {
        a.data = downsampleNearest(a.data, a.win.w, a.win.h, sizeA.w, sizeA.h);
      }
      outW = sizeA.w;
      outH = sizeA.h;
    }
    if (!b.resampled) {
      var sizeB = clampOutputSize(b.win.w, b.win.h);
      if (sizeB.w !== b.win.w || sizeB.h !== b.win.h) {
        b.data = downsampleNearest(b.data, b.win.w, b.win.h, sizeB.w, sizeB.h);
      }
      if (sizeB.w !== outW || sizeB.h !== outH) {
        b.data = downsampleNearest(b.data, sizeB.w, sizeB.h, outW, outH);
      }
    }

    // Máscara de nuvens/sombra (banda SCL, 20m). Opcional: se faltar, calcula
    // o índice sem máscara.
    var scl = null;
    if (sclHref) {
      try {
        var sclTiff = await GeoTIFF.fromUrl(sclHref);
        var sclImg = await sclTiff.getImage();
        var sclWin = pixelWindowForBounds(
          bounds, epsg, sclImg.getOrigin(), sclImg.getResolution(),
          sclImg.getWidth(), sclImg.getHeight()
        );
        scl = await readBand(sclImg, sclWin.window, { w: outW, h: outH }, 'nearest');
      } catch (err) {
        console.warn('[ndvi] SCL indisponível — a calcular sem máscara de nuvens.', err);
        scl = null;
      }
    }

    var n = outW * outH;
    var values = new Float32Array(n);
    var maskedCount = 0;
    for (var i = 0; i < n; i++) {
      var va = a.data[i], vb = b.data[i];
      if (!isFinite(va) || !isFinite(vb)) {
        values[i] = NaN;
        maskedCount++;
        continue;
      }
      if (scl && SCL_BAD[scl[i]]) {
        values[i] = NaN;
        maskedCount++;
        continue;
      }
      var denom = va + vb;
      values[i] = denom > 0 ? (va - vb) / denom : 0;
    }

    // Recorte opcional pelo polígono do município: fora → NaN (fica
    // transparente na renderização e fora das estatísticas).
    var clipMask = null;
    var polygonAreaM2 = null;
    if (mask) {
      try {
        clipMask = maskForGeometry(mask, bounds, outW, outH);
        for (var mi = 0; mi < n; mi++) {
          if (!clipMask[mi]) values[mi] = NaN;
        }
      } catch (err) {
        console.warn('[ndvi] Falha ao recortar pelo município; a usar o retângulo total.', err);
        clipMask = null;
      }
      if (typeof turf !== 'undefined' && turf.area) {
        try {
          polygonAreaM2 = turf.area({ type: 'Feature', geometry: mask, properties: {} });
        } catch (err) { polygonAreaM2 = null; }
      }
    }

    return {
      ndvi: values,
      width: outW, height: outH,
      maskedCount: maskedCount, maskApplied: !!scl,
      scene: scene, epsg: epsg, def: def,
      clipMask: clipMask, clipGeometry: clipMask ? mask : null,
      clipBounds: clipMask ? bounds : null,
      polygonAreaM2: polygonAreaM2
    };
  }

  // Compatibilidade: pipeline clássico de NDVI.
  async function fetchAndComputeNdvi(bounds, scene) {
    return fetchAndComputeIndex(bounds, scene, INDEXES.ndvi);
  }

  // --- Renderização ----------------------------------------------------------

  // Cor para um valor num dado color-ramp (stops). NaN/Infinity → cor de máscara.
  function colorFor(v, stops) {
    if (!isFinite(v)) return MASK_COLOR;
    var first = stops[0], last = stops[stops.length - 1];
    var vv = clamp(v, first[0], last[0]);
    for (var i = 0; i < stops.length - 1; i++) {
      var a = stops[i], b = stops[i + 1];
      if (vv >= a[0] && vv <= b[0]) {
        var t = (b[0] === a[0]) ? 0 : (vv - a[0]) / (b[0] - a[0]);
        return [
          Math.round(a[1][0] + (b[1][0] - a[1][0]) * t),
          Math.round(a[1][1] + (b[1][1] - a[1][1]) * t),
          Math.round(a[1][2] + (b[1][2] - a[1][2]) * t),
          255
        ];
      }
    }
    return [last[1][0], last[1][1], last[1][2], 255];
  }

  // Compatibilidade: ndviColor usa a rampa do NDVI.
  function ndviColor(v) {
    return colorFor(v, INDEXES.ndvi.stops);
  }

  // Gradiente CSS da legenda, normalizado ao intervalo dos stops.
  function legendGradientFor(stops) {
    var first = stops[0], last = stops[stops.length - 1];
    var span = last[0] - first[0] || 1;
    var parts = stops.map(function (s) {
      return 'rgb(' + s[1][0] + ',' + s[1][1] + ',' + s[1][2] + ') ' + Math.round((s[0] - first[0]) / span * 100) + '%';
    });
    return 'linear-gradient(90deg, ' + parts.join(', ') + ')';
  }

  function legendGradient() {
    return legendGradientFor(INDEXES.ndvi.stops);
  }

  // Estatísticas genéricas de um índice, com as duas percentagens acima/abaixo
  // dos limiares definidos no índice (pos/neg).
  function computeIndexStats(values, def) {
    var sum = 0, sumSq = 0, min = Infinity, max = -Infinity, valid = 0, pos = 0, neg = 0;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (!isFinite(v)) continue;
      valid++;
      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > def.posThreshold) pos++;
      if (v < def.negThreshold) neg++;
    }
    var mean = valid ? sum / valid : 0;
    var std = valid ? Math.sqrt(Math.max(0, sumSq / valid - mean * mean)) : 0;
    return {
      valid: valid,
      mean: mean,
      min: valid ? min : 0,
      max: valid ? max : 0,
      std: std,
      posPct: valid ? pos / valid * 100 : 0,
      negPct: valid ? neg / valid * 100 : 0
    };
  }

  // Compatibilidade: computeStats mantém o formato histórico (NDVI), com os
  // aliases vegPct/watPct usados por testes e pela UI.
  function computeStats(ndvi) {
    var s = computeIndexStats(ndvi, INDEXES.ndvi);
    return {
      valid: s.valid,
      mean: s.mean,
      min: s.min,
      max: s.max,
      std: s.std,
      vegPct: s.posPct,
      watPct: s.negPct
    };
  }

  function formatArea(m2) {
    if (m2 >= 1000000) return (m2 / 1000000).toFixed(2) + ' km²';
    if (m2 >= 10000) return (m2 / 1000).toFixed(1) + ' ha';
    return Math.round(m2).toLocaleString('pt-PT') + ' m²';
  }

  function formatNum(v, digits) {
    if (!isFinite(v)) return '—';
    var s = v.toFixed(digits);
    return s;
  }

  function overlayBoundsFor(bounds) {
    return L.latLngBounds(
      L.latLng(bounds.getSouth(), bounds.getWest()),
      L.latLng(bounds.getNorth(), bounds.getEast())
    );
  }

  function renderNdvi(result, bounds) {
    var def = result.def || INDEXES.ndvi;
    currentResultKey = def.key;
    clearNdviOverlay();
    var canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(result.width, result.height);
    var px = imgData.data;
    for (var i = 0; i < result.ndvi.length; i++) {
      var o = i * 4;
      // Fora do polígono do município → totalmente transparente (base visível).
      if (result.clipMask && result.clipMask[i] === 0) {
        px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0;
        continue;
      }
      var c = colorFor(result.ndvi[i], def.stops);
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
    }
    ctx.putImageData(imgData, 0, 0);
    if (result.clipMask && result.clipGeometry && result.clipBounds) {
      drawClipOutline(ctx, result.clipGeometry, result.clipBounds, result.width, result.height);
    }
    currentDataUrl = canvas.toDataURL('image/png');

    ndviOverlayLayer = L.imageOverlay(currentDataUrl, overlayBoundsFor(bounds), {
      opacity: 0.9,
      pane: 'overlayPane',
      zIndex: 250,
      interactive: false
    }).addTo(getMap());

    showNdviPanel(result, bounds);
    var m = getMap();
    if (m) m.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
  }

  function showNdviPanel(result, bounds) {
    var panel = document.getElementById('ndvi-panel');
    if (!panel) return;
    var scene = result.scene;
    var def = result.def || INDEXES.ndvi;

    var titleEl = document.getElementById('ndvi-panel-title');
    if (titleEl) titleEl.textContent = def.label;

    var sceneId = (scene.id || '').split('_').slice(0, 5).join('_');
    var dateStr = new Date(scene.properties.datetime).toLocaleDateString('pt-PT');
    var cloud = typeof scene.properties['eo:cloud_cover'] === 'number'
      ? scene.properties['eo:cloud_cover'].toFixed(1) + '%'
      : '—';

    var metaEl = document.getElementById('ndvi-meta');
    if (metaEl) {
      metaEl.innerHTML =
        '<div><span>' + _t('txt.cena_sentinel_2', 'Cena Sentinel-2') + '</span><b>' + sceneId + '</b></div>' +
        '<div><span>' + _t('txt.data_da_cena', 'Data da cena') + '</span><b>' + dateStr + '</b></div>' +
        '<div><span>' + _t('txt.cobertura_de_nuvens', 'Cobertura de nuvens') + '</span><b>' + cloud + '</b></div>' +
        '<div><span>' + _t('txt.crs_da_cena', 'CRS da cena') + '</span><b>EPSG:' + result.epsg + '</b></div>' +
        '<div><span>' + _t('txt.resolu_o_de_c_lculo', 'Resolução de cálculo') + '</span><b>' + result.width + '×' + result.height + 'px</b></div>' +
        (result.maskApplied
          ? '<div><span>' + _t('txt.mascarado_nuvens_sombra', 'Pixels mascarados (nuvens/sombra)') + '</span><b>' + result.maskedCount.toLocaleString('pt-PT') + '</b></div>'
          : '');
    }

    var st = computeIndexStats(result.ndvi, def);
    var areaM2 = 0;
    try {
      if (typeof turf !== 'undefined' && turf.area) {
        if (typeof result.polygonAreaM2 === 'number' && isFinite(result.polygonAreaM2)) {
          areaM2 = result.polygonAreaM2;
        } else if (turf.bboxPolygon) {
          areaM2 = turf.area(turf.bboxPolygon([
            bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()
          ]));
        }
      }
    } catch (e) { areaM2 = 0; }

    var statsEl = document.getElementById('ndvi-stats');
    if (statsEl) {
      statsEl.innerHTML =
        '<div><span>' + _t('txt.rea_analisada', 'Área analisada') + '</span><b>' + formatArea(areaM2) + '</b></div>' +
        '<div><span>' + def.label + ' ' + _t('txt.m_dio', 'médio') + '</span><b>' + formatNum(st.mean, 2) + '</b></div>' +
        '<div><span>' + def.label + ' ' + _t('txt.m_nimo', 'mínimo') + '</span><b>' + formatNum(st.min, 2) + '</b></div>' +
        '<div><span>' + def.label + ' ' + _t('txt.m_ximo', 'máximo') + '</span><b>' + formatNum(st.max, 2) + '</b></div>' +
        '<div><span>' + _t('txt.desvio_padr_o', 'Desvio padrão') + '</span><b>' + formatNum(st.std, 2) + '</b></div>' +
        '<div><span>' + _t(def.posLabelKey, def.posLabel) + '</span><b>' + st.posPct.toFixed(1) + '%</b></div>' +
        '<div><span>' + _t(def.negLabelKey, def.negLabel) + '</span><b>' + st.negPct.toFixed(1) + '%</b></div>' +
        '<div><span>' + _t('txt.pixels_v_lidos', 'Pixels válidos') + '</span><b>' + st.valid.toLocaleString('pt-PT') + '</b></div>';
    }

    var legendEl = document.getElementById('ndvi-legend-bar');
    if (legendEl) legendEl.style.background = legendGradientFor(def.stops);

    panel.classList.remove('hidden');
  }

  // --- Limpar ----------------------------------------------------------------

  function clearNdviOverlay() {
    if (ndviOverlayLayer) {
      var m = getMap();
      if (m && m.removeLayer) m.removeLayer(ndviOverlayLayer);
      ndviOverlayLayer = null;
    }
    currentDataUrl = null;
    var panel = document.getElementById('ndvi-panel');
    if (panel) panel.classList.add('hidden');
  }

  function clearNdvi() {
    clearNdviOverlay();
    cancelNdviDrawing();
  }

  function exportNdviPng() {
    if (!currentDataUrl) return;
    var a = document.createElement('a');
    a.href = currentDataUrl;
    a.download = currentResultKey + '_' + new Date().toISOString().slice(0, 10) + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // --- Desenho do retângulo (Geoman) -----------------------------------------

  function startNdviDrawing(indexKey) {
    if (ndviDrawing || ndviProcessing) return;
    if (!indexKey) indexKey = ndviActiveIndex;
    var def = INDEXES[indexKey];
    if (!def) indexKey = 'ndvi';
    def = INDEXES[indexKey];
    ndviActiveIndex = indexKey;
    var m = getMap();
    if (!m || !m.pm) return;
    if (m.pm.globalDrawModeEnabled && m.pm.globalDrawModeEnabled()) m.pm.disableDraw();
    ndviDrawing = true;
    var banner = document.getElementById('ndvi-banner');
    if (banner) {
      setBannerProcessing(false);
      var text = document.getElementById('ndvi-banner-text');
      if (text) text.textContent = _t(def.drawHintKey, def.drawHint);
      banner.style.display = 'flex';
    }
    var btn = document.getElementById('btn-satellite');
    if (btn) btn.classList.add('is-active');
    m.pm.enableDraw('Rectangle');
  }

  function cancelNdviDrawing() {
    var m = getMap();
    if (m && m.pm && m.pm.globalDrawModeEnabled && m.pm.globalDrawModeEnabled()) m.pm.disableDraw();
    ndviDrawing = false;
    var banner = document.getElementById('ndvi-banner');
    if (banner) banner.style.display = 'none';
    var btn = document.getElementById('btn-satellite');
    if (btn) btn.classList.remove('is-active');
  }

  function onPmCreate(e) {
    if (!ndviDrawing) return;
    ndviDrawing = false;
    var m = getMap();
    if (m && m.pm && m.pm.globalDrawModeEnabled && m.pm.globalDrawModeEnabled()) m.pm.disableDraw();
    var banner = document.getElementById('ndvi-banner');
    if (banner) banner.style.display = 'none';
    var btn = document.getElementById('btn-satellite');
    if (btn) btn.classList.remove('is-active');

    var layer = e.layer;
    if (!layer || !layer.getBounds) return;
    var bounds = layer.getBounds();
    try { layer.remove(); } catch (err) { if (m) m.removeLayer(layer); }
    runIndexAnalysis(bounds, INDEXES[ndviActiveIndex]);
  }

  async function runIndexAnalysis(bounds, def, mask, year) {
    if (ndviProcessing) return;
    ndviProcessing = true;
    var btn = document.getElementById('btn-satellite');
    if (btn) btn.classList.add('is-processing');
    setBannerProcessing(true);
    clearNdviOverlay();
    try {
      setBannerStatus(_t('txt.a_procurar_imagem_sentinel_2', 'A procurar imagem Sentinel-2 recente…'));
      var scene = await searchSentinelScene(bounds, year);
      if (!scene) {
        if (window.showAppAlert) {
          window.showAppAlert(_t('txt.sem_cena_sentinel_2_dispon_vel', 'Não foi encontrada nenhuma cena Sentinel-2 recente nesta área.'), { error: true });
        }
        return;
      }
      setBannerStatus(_t('txt.a_descarregar_bandas_sentinel_2', 'A descarregar bandas Sentinel-2…'));
      var result = await fetchAndComputeIndex(bounds, scene, def, mask);
      setBannerStatus(_t('txt.a_calcular_ndice', 'A calcular índice…'));
      renderNdvi(result, bounds);
    } catch (err) {
      console.error('[ndvi]', err);
      if (window.showAppAlert) {
        var msg = err && err.message === 'geotiff'
          ? _t('txt.sem_geotiff_dispon_vel', 'A biblioteca geotiff.js não está disponível.')
          : _t('txt.erro_ndice_processamento', 'Não foi possível calcular o índice. Verifica a ligação à internet e tenta novamente.');
        window.showAppAlert(msg, { error: true });
      }
    } finally {
      var banner = document.getElementById('ndvi-banner');
      if (banner) banner.style.display = 'none';
      setBannerProcessing(false);
      if (btn) btn.classList.remove('is-processing');
      ndviProcessing = false;
    }
  }

  // --- Processar por município ----------------------------------------------
  // Busca o limite do concelho (mesmo índice MUNICIPIOS_INDEX/portal DataGis
  // usado por 10-portal-bridge.js — MUNICIPIOS_GITHUB_RAW_BASE + entry.p é um
  // GeoJSON CAOP em WGS84) e corre a análise do índice escolhido sobre esses
  // bounds.
  async function processMunicipio(entry, indexKey, year) {
    if (ndviProcessing) return;
    var def = INDEXES[indexKey] || INDEXES[ndviActiveIndex] || INDEXES.ndvi;
    if (INDEXES[indexKey]) ndviActiveIndex = indexKey;
    if (ndviDrawing) cancelNdviDrawing();
    setBannerProcessing(true);
    setBannerStatus(_t('txt.a_carregar_limite_do_munic_pio', 'A carregar limite do município…'));
    try {
      if (!entry || !entry.p) throw new Error('sem limite do município');
      var res = await fetch(MUNICIPIOS_GITHUB_RAW_BASE + entry.p);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var gj = await res.json();
      var bounds = L.geoJSON(gj).getBounds();
      if (!bounds || !bounds.isValid || !bounds.isValid()) throw new Error('limite do município inválido');
      await runIndexAnalysis(bounds, def, geometryFromGeoJSON(gj), year);
    } catch (err) {
      console.error('[ndvi] município:', err);
      var banner = document.getElementById('ndvi-banner');
      if (banner) banner.style.display = 'none';
      setBannerProcessing(false);
      if (window.showAppAlert) {
        window.showAppAlert(_t('txt.sem_limite_do_munic_pio', 'Não foi possível carregar o limite do município.'), { error: true });
      }
    }
  }

  // --- Wiring ---------------------------------------------------------------

  function wireButton() {
    // As ferramentas vivem no menu de satélite (itens .satellite-index-item);
    // o estado visual ativo/processando reflete-se no botão do cabeçalho
    // (#btn-satellite).
    var items = document.querySelectorAll('.satellite-index-item[data-index]');
    items.forEach(function (item) {
      if (item.dataset.ndviWired) return;
      item.dataset.ndviWired = '1';
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        if (ndviProcessing) return;
        if (ndviDrawing) {
          cancelNdviDrawing();
          return;
        }
        startNdviDrawing(item.dataset.index);
      });
    });
  }

  function wirePanel() {
    var cancel = document.getElementById('ndvi-cancel');
    if (cancel && !cancel.dataset.ndviWired) {
      cancel.dataset.ndviWired = '1';
      cancel.addEventListener('click', function () {
        if (ndviProcessing) return;
        cancelNdviDrawing();
      });
    }
    var clearBtn = document.getElementById('ndvi-clear');
    if (clearBtn && !clearBtn.dataset.ndviWired) {
      clearBtn.dataset.ndviWired = '1';
      clearBtn.addEventListener('click', function () { clearNdvi(); });
    }
    var closeBtn = document.getElementById('ndvi-panel-close');
    if (closeBtn && !closeBtn.dataset.ndviWired) {
      closeBtn.dataset.ndviWired = '1';
      closeBtn.addEventListener('click', function () { clearNdviOverlay(); });
    }
    var exportBtn = document.getElementById('ndvi-export-png');
    if (exportBtn && !exportBtn.dataset.ndviWired) {
      exportBtn.dataset.ndviWired = '1';
      exportBtn.addEventListener('click', function () { exportNdviPng(); });
    }
  }

  function setupMapHandler() {
    var m = getMap();
    if (!m) return false;
    m.on('pm:create', onPmCreate);
    return true;
  }

  function init() {
    wireButton();
    wirePanel();
    // Espera o mapa (initMap em 05-app-main.js) para registar o handler.
    if (!setupMapHandler()) {
      var attempts = 0;
      var timer = setInterval(function () {
        attempts++;
        if (setupMapHandler()) {
          clearInterval(timer);
        } else if (attempts >= 20) {
          clearInterval(timer);
          console.warn('[ndvi] Não foi possível registar o handler pm:create no mapa.');
        }
      }, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposição para debug/consola e para testes de funções puras.
  window.ndviTool = {
    start: startNdviDrawing,
    cancel: cancelNdviDrawing,
    clear: clearNdvi,
    exportPng: exportNdviPng,
    processMunicipio: processMunicipio,
    get active() { return ndviDrawing; },
    get processing() { return ndviProcessing; },
    get activeIndex() { return ndviActiveIndex; },
    __internals: {
      INDEXES: INDEXES,
      ndviColor: ndviColor,
      colorFor: colorFor,
      legendGradient: legendGradient,
      legendGradientFor: legendGradientFor,
      computeStats: computeStats,
      computeIndexStats: computeIndexStats,
      clampOutputSize: clampOutputSize,
      pixelWindowForBounds: pixelWindowForBounds,
      projectTo: projectTo,
      inferEpsg: inferEpsg,
      fetchAndComputeNdvi: fetchAndComputeNdvi,
      fetchAndComputeIndex: fetchAndComputeIndex,
      maskForGeometry: maskForGeometry,
      traceGeometryPath: traceGeometryPath,
      geometryFromGeoJSON: geometryFromGeoJSON,
      SCL_BAD: SCL_BAD,
      MAX_OUTPUT_DIM: MAX_OUTPUT_DIM,
      MAX_OUTPUT_PIXELS: MAX_OUTPUT_PIXELS
    }
  };
})();
