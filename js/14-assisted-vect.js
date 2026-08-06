/* ============================================================
   VETORIZACAO ASSISTIDA — modulo UI (main thread)
   ============================================================ */
(function(){
  'use strict';
  console.log('[vetorizacao-assistida] 14-assisted-vect.js build=osm-auto-samples-v2 (magic wand: crop de alta resolucao por clique + trava de deriva de cor; amostras automaticas via edificios OSM/Overpass; negativas automaticas por cobertura do solo OSM -- floresta/agricola/estrada -- com grelha cega so como complemento)');

  var vaState = {
    active: false,
    step: 1,
    selectedClass: 'building',
    areaBounds: null,
    areaLayer: null,
    samples: [],
    sampleDrawing: false,
    sampleLabel: null,
    vaDrawingActive: false,
    magicWandActive: false,
    magicWandLabel: null,
    mwCropCache: null,
    geojson: null,
    stats: null,
    reviewLayers: [],
    worker: null
  };

  function $(id){ return document.getElementById(id); }

  function ensureWorker(){
    if(!vaState.worker){
      vaState.worker = new Worker('js/14b-assisted-vect-worker.js');
      vaState.worker.onmessage = onWorkerMessage;
      vaState.worker.onerror = function(e){
        console.error('[VetAssist] Worker error:', e);
        showAppAlert('Erro no processamento: ' + (e.message || 'Erro desconhecido.'), {error:true});
        showStep(4);
      };
    }
    return vaState.worker;
  }

  /* ---- Abrir / Fechar ---- */
  function openVetAssist(){
    if(vaState.active) return;
    vaState.active = true;
    vaState.step = 1;
    vaState.areaBounds = null;
    vaState.areaLayer = null;
    vaState.samples = [];
    vaState.geojson = null;
    vaState.stats = null;
    vaState.reviewLayers = [];
    vaState.mwCropCache = null;
    vaState.magicWandActive = false;
    vaState.magicWandLabel = null;
    $('va-page').hidden = false;
    setOsmStatusText('');
    updateOsmCoverageWarning(0, 0);
    showStep(1);
    updateNav();
  }

  function closeVetAssist(){
    if(!vaState.active) return;
    vaState.active = false;
    vaState.step = 1;
    cancelAreaDrawing();
    cancelSampleDrawing();
    cancelMagicWand();
    vaState.mwCropCache = null;
    if(vaState.areaLayer){ map.removeLayer(vaState.areaLayer); }
    clearSampleLayers();
    clearReviewLayers();
    if(vaState.worker){
      vaState.worker.terminate();
      vaState.worker = null;
    }
    $('va-page').hidden = true;
  }

  /* ---- Navegacao por steps ---- */
  function showStep(n){
    vaState.step = n;
    document.querySelectorAll('.va-step').forEach(function(s){
      s.classList.toggle('is-visible', Number(s.dataset.vaStep) === n);
    });
    updateNav();
  }

  function updateNav(){
    document.querySelectorAll('.va-nav-btn[data-va-step]').forEach(function(btn){
      var s = Number(btn.dataset.vaStep);
      btn.classList.toggle('is-active', s === vaState.step);
      btn.classList.toggle('is-done', s < vaState.step);
    });
  }

  /* ---- Step 2: Selecionar classe ---- */
  function selectClass(cls){
    var card = document.querySelector('.va-class-card[data-va-class="' + cls + '"]');
    if(!card || card.classList.contains('disabled')) return;
    document.querySelectorAll('.va-class-card').forEach(function(c){ c.classList.remove('selected'); });
    card.classList.add('selected');
    vaState.selectedClass = cls;
  }

  /* ---- Step 3: Area ---- */
  function startAreaDrawing(){
    cancelSampleDrawing();
    vaState.vaDrawingActive = true;
    window.vaDrawingActive = true;
    $('va-page').classList.add('va-drawing');
    $('va-draw-banner').classList.remove('hidden');
    map.pm.enableDraw('Rectangle');
  }

  function cancelAreaDrawing(){
    vaState.vaDrawingActive = false;
    window.vaDrawingActive = false;
    $('va-page').classList.remove('va-drawing');
    $('va-draw-banner').classList.add('hidden');
    if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
  }

  function onAreaDrawn(layer){
    cancelAreaDrawing();
    vaState.areaLayer = layer;
    vaState.areaBounds = layer.getBounds();
    vaState.mwCropCache = null; // area mudou -- invalida a imagem cacheada para o magic wand
    var areaM2 = calcAreaM2(vaState.areaBounds);
    var centerLat = vaState.areaBounds.getCenter().lat;
    var zoom = estimateZoom(centerLat);
    var tiles = estimateTiles(vaState.areaBounds, zoom);
    var timeEst = estimateTime(tiles);
    $('va-estimate-area').textContent = formatArea(areaM2);
    $('va-estimate-tiles').textContent = tiles;
    $('va-estimate-zoom').textContent = zoom;
    $('va-estimate-time').textContent = timeEst;
    $('va-estimate').classList.remove('hidden');

    /* Area nova -- as amostras anteriores (se existirem, de uma area
       diferente) deixam de fazer sentido geograficamente. */
    clearSampleLayers();
    updateSampleUI();

    /* zoom ja nao baixa para compensar areas grandes (ver estimateZoom) --
       em vez disso, se a area desenhada exigir demasiados tiles ao zoom de
       classificacao, bloqueia-se o avanco em vez de degradar a resolucao
       silenciosamente. */
    var tooLarge = tiles > CLASSIFICATION_MAX_TILES;
    updateAreaTooLargeWarning(tooLarge, tiles, zoom);
    $('va-step3-next').disabled = tooLarge;
    if(tooLarge) return;

    importOsmBuildingsForArea(vaState.areaBounds, zoom, areaM2);
  }

  /* ============================================================
     Importacao automatica de edificios OSM (Overpass API)
     ------------------------------------------------------------
     Em vez de depender so do click manual / magic wand para gerar
     amostras positivas, pedimos os poligonos `building=*` que ja
     existem no OpenStreetMap dentro da area de trabalho e usamo-los
     directamente como amostras de treino "edificio". A geometria vem
     certa (sem deriva de cor, sem ambiguidade de bordas) porque nao
     estamos a adivinhar nada a partir de pixels.
     Complementamos com algumas amostras "nao-edificio" geradas por
     amostragem em grelha dentro da area, evitando pontos proximos de
     qualquer edificio OSM -- assim o utilizador ja chega ao passo 4
     com amostras minimas prontas (3+3), podendo sempre acrescentar/
     remover manualmente.
     ============================================================ */
  var OSM_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
  var OSM_OVERPASS_TIMEOUT_S = 25;
  var OSM_AUTO_NEG_COUNT = 4;      // quantas amostras negativas tentar gerar automaticamente
  /* IMPORTANTE: o worker classifica por SUPERPIXEL (grid de SLIC_GRID_STEP=12px,
     ver 14b-assisted-vect-worker.js), e so' considera uma amostra se esta
     contiver o CENTRO de pelo menos um desses superpixels (ver
     prepareTrainingData/pointInPixelBounds no worker). Um quadrado de
     tamanho fixo em metros pode ser MENOR do que uma celula do grid a zooms
     baixos (usados em areas grandes) -- nesse caso a amostra e' aceite na
     UI mas contribui ZERO linhas de treino. Sem nenhuma amostra negativa
     real, o classificador aprende so' "edificio" e classifica a area
     inteira como um unico edificio (foi exatamente o bug reportado).
     Por isso o tamanho e' calculado dinamicamente a partir do zoom que vai
     ser mesmo usado no processamento (mesma formula de metros/pixel do
     Web Mercator), com margem generosa (2.5x a celula) para garantir que
     cobre sempre o centro de pelo menos um superpixel, seja qual for o
     desfasamento entre o quadrado e a grelha. */
  var SLIC_GRID_STEP_REF = 12; // tem de acompanhar SLIC_GRID_STEP no worker
  var OSM_AUTO_NEG_MIN_SIZE_M = 6;   // nunca gerar amostras mais pequenas do que isto
  var OSM_AUTO_NEG_MAX_SIZE_M = 30;  // nem maiores do que isto (evita invadir zonas vizinhas)

  function metersPerPixelAt(lat, zoom){
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
  }

  function autoNegSampleSizeM(lat, zoom){
    var cellSizeM = metersPerPixelAt(lat, zoom) * SLIC_GRID_STEP_REF;
    var size = cellSizeM * 2.5;
    if(size < OSM_AUTO_NEG_MIN_SIZE_M) size = OSM_AUTO_NEG_MIN_SIZE_M;
    if(size > OSM_AUTO_NEG_MAX_SIZE_M) size = OSM_AUTO_NEG_MAX_SIZE_M;
    return size;
  }

  function boundsToOverpassBBox(bounds){
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(',');
  }

  /* Um unico pedido Overpass que traz, alem dos edificios, tres classes de
     cobertura do solo (floresta, terreno agricola, estradas) para servirem
     de amostras negativas "verdadeiras". Antes so pediamos edificios e
     adivinhavamos pontos "vazios" numa grelha cega -- isso falha quando a
     area tem floresta/sombra de copa ou estrada, porque o classificador
     nunca via um exemplo negativo desse tipo especifico e acabava por
     confundir textura de copa ou aresta de asfalto com telhado. Aqui
     aplicamos a mesma logica que ja usamos para "building": o OSM ja sabe
     onde e floresta/campo/estrada, por isso perguntamos diretamente em vez
     de adivinhar. So `way` -- relations (multipolygon) ficam de fora por
     agora, ver nota equivalente que existia antes para edificios. */
  function buildOverpassTrainingQuery(bbox){
    return '[out:json][timeout:' + OSM_OVERPASS_TIMEOUT_S + '];' +
      '(' +
      'way["building"](' + bbox + ');' +
      'way["natural"="wood"](' + bbox + ');' +
      'way["landuse"="forest"](' + bbox + ');' +
      'way["landuse"="farmland"](' + bbox + ');' +
      'way["highway"](' + bbox + ');' +
      ');' +
      'out geom;';
  }

  function closeRingIfNeeded(coords){
    var first = coords[0], last = coords[coords.length - 1];
    if(first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
    return coords;
  }

  /* Devolve edificios (rings fechados, como antes) e, separadamente,
     poligonos de floresta/agricola (rings fechados, com o tipo em `kind`)
     e linhas de estrada (polilinhas abertas) -- usados so' para gerar
     amostras negativas automaticas, nunca desenhados como amostra
     positiva. */
  function fetchOsmTrainingFeatures(bounds){
    var query = buildOverpassTrainingQuery(boundsToOverpassBBox(bounds));
    return fetch(OSM_OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query
    }).then(function(resp){
      if(!resp.ok) throw new Error('Overpass respondeu ' + resp.status);
      return resp.json();
    }).then(function(data){
      var elements = (data && data.elements) || [];
      var buildingRings = [];
      var landcoverRings = [];
      var roadLines = [];
      elements.forEach(function(el){
        if(el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
        var coords = el.geometry.map(function(pt){ return [pt.lat, pt.lon]; });
        var tags = el.tags || {};
        if(tags.building){
          if(coords.length < 3) return;
          buildingRings.push(closeRingIfNeeded(coords));
        } else if(tags.natural === 'wood' || tags.landuse === 'forest'){
          if(coords.length < 3) return;
          landcoverRings.push({ ring: closeRingIfNeeded(coords), kind: 'floresta' });
        } else if(tags.landuse === 'farmland'){
          if(coords.length < 3) return;
          landcoverRings.push({ ring: closeRingIfNeeded(coords), kind: 'agricola' });
        } else if(tags.highway){
          roadLines.push(coords);
        }
      });
      return { buildingRings: buildingRings, landcoverRings: landcoverRings, roadLines: roadLines };
    });
  }

  function pointInRing(lat, lng, ring){
    var inside = false;
    for(var i = 0, j = ring.length - 2; i < ring.length - 1; j = i++){
      var yi = ring[i][0], xi = ring[i][1];
      var yj = ring[j][0], xj = ring[j][1];
      var intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if(intersect) inside = !inside;
    }
    return inside;
  }

  function pointInAnyRing(lat, lng, rings){
    for(var i = 0; i < rings.length; i++){
      if(pointInRing(lat, lng, rings[i])) return true;
    }
    return false;
  }

  function metersBetween(lat1, lng1, lat2, lng2){
    var dLat = (lat2 - lat1) * 111320;
    var dLng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  function squareRingAround(lat, lng, sizeM){
    var dLat = (sizeM / 2) / 111320;
    var dLng = (sizeM / 2) / (111320 * Math.cos(lat * Math.PI / 180));
    return [
      [lat - dLat, lng - dLng],
      [lat - dLat, lng + dLng],
      [lat + dLat, lng + dLng],
      [lat + dLat, lng - dLng],
      [lat - dLat, lng - dLng]
    ];
  }

  var OSM_AUTO_NEG_PER_CLASS = 2;              // quantas amostras negativas tentar tirar de CADA classe (floresta, agricola, estrada)
  var OSM_AUTO_NEG_MAX_FEATURES_PER_CLASS = 6; // nao percorrer centenas de poligonos/linhas -- so os primeiros N encontrados por classe

  function tooCloseToRings(lat, lng, rings, minDistM){
    return rings.some(function(ring){
      return ring.some(function(v){
        return metersBetween(lat, lng, v[0], v[1]) < minDistM;
      });
    });
  }

  function tooCloseToPoints(lat, lng, points, minDistM){
    return points.some(function(p){
      return metersBetween(lat, lng, p[0], p[1]) < minDistM;
    });
  }

  /* Ponto aleatorio dentro de um ring, por rejection sampling na bounding
     box (rings de floresta/campo do OSM tendem a ser irregulares, por
     isso nao basta usar o centroide -- pode cair fora da forma). */
  function randomPointInRing(ring, maxTries){
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for(var i = 0; i < ring.length - 1; i++){
      var lat = ring[i][0], lng = ring[i][1];
      if(lat < minLat) minLat = lat;
      if(lat > maxLat) maxLat = lat;
      if(lng < minLng) minLng = lng;
      if(lng > maxLng) maxLng = lng;
    }
    for(var t = 0; t < maxTries; t++){
      var lat = minLat + Math.random() * (maxLat - minLat);
      var lng = minLng + Math.random() * (maxLng - minLng);
      if(pointInRing(lat, lng, ring)) return [lat, lng];
    }
    return null;
  }

  /* Distribui `count` pontos ao longo do comprimento total da polilinha,
     evitando os extremos (que podem cair fora da area de trabalho). */
  function pointsAlongLine(line, count){
    var segLens = [];
    var total = 0;
    for(var i = 0; i < line.length - 1; i++){
      var d = metersBetween(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
      segLens.push(d);
      total += d;
    }
    if(total <= 0) return [];
    var pts = [];
    for(var k = 1; k <= count; k++){
      var target = total * k / (count + 1);
      var acc = 0;
      for(var i = 0; i < segLens.length; i++){
        if(acc + segLens[i] >= target || i === segLens.length - 1){
          var segT = segLens[i] > 0 ? (target - acc) / segLens[i] : 0;
          segT = Math.max(0, Math.min(1, segT));
          pts.push([
            line[i][0] + (line[i + 1][0] - line[i][0]) * segT,
            line[i][1] + (line[i + 1][1] - line[i][1]) * segT
          ]);
          break;
        }
        acc += segLens[i];
      }
    }
    return pts;
  }

  /* Tenta adicionar uma amostra negativa num ponto: rejeita se cair dentro
     de um edificio, perto demais de um edificio, ou perto demais de outra
     amostra negativa ja adicionada (evita desperdicar amostras coladas
     umas as outras). Devolve true/false consoante conseguiu. */
  function tryAddNegativeSampleAt(lat, lng, sizeM, buildingRings, minDistM, addedPoints){
    if(pointInAnyRing(lat, lng, buildingRings)) return false;
    if(tooCloseToRings(lat, lng, buildingRings, minDistM)) return false;
    if(tooCloseToPoints(lat, lng, addedPoints, sizeM)) return false;
    var ring = squareRingAround(lat, lng, sizeM);
    var layer = L.polygon(ring).addTo(map);
    addSampleFromLayer(layer, 'non-building');
    addedPoints.push([lat, lng]);
    return true;
  }

  /* Amostragem negativa automatica em duas fases:
     1. Cobertura do solo real do OSM (floresta, agricola, estrada) -- da
        diversidade espectral ao classificador (sombra de copa, asfalto,
        terra) que faltava por completo antes: se a area tinha floresta e
        a grelha cega calhava so em campo agricola, o classificador nunca
        aprendia "isto tambem e nao-edificio" para sombra de arvore, e
        confundia-a com telhado (era exatamente o padrao visto nos
        resultados: mancha gigante sobre copas + faixa fina ao longo de
        uma estrada).
     2. Grelha cega, como complemento/fallback, ate perfazer
        OSM_AUTO_NEG_COUNT no total -- continua a ser util quando a area
        nao tem nenhuma floresta/campo/estrada mapeada no OSM. */
  function generateAutoNegativeSamples(bounds, buildingRings, landcoverRings, roadLines, zoom){
    var north = bounds.getNorth(), south = bounds.getSouth();
    var east = bounds.getEast(), west = bounds.getWest();
    var latMid = (north + south) / 2;
    var sizeM = autoNegSampleSizeM(latMid, zoom);
    var minDistM = sizeM * 1.2;
    var addedPoints = [];
    var added = 0;
    var byKind = { floresta: 0, agricola: 0, estrada: 0 };

    ['floresta', 'agricola'].forEach(function(kind){
      var feats = landcoverRings.filter(function(f){ return f.kind === kind; }).slice(0, OSM_AUTO_NEG_MAX_FEATURES_PER_CLASS);
      feats.forEach(function(f){
        if(byKind[kind] >= OSM_AUTO_NEG_PER_CLASS) return;
        var pt = randomPointInRing(f.ring, 8);
        if(!pt) return;
        if(tryAddNegativeSampleAt(pt[0], pt[1], sizeM, buildingRings, minDistM, addedPoints)){
          added++;
          byKind[kind]++;
        }
      });
    });

    roadLines.slice(0, OSM_AUTO_NEG_MAX_FEATURES_PER_CLASS).forEach(function(line){
      if(byKind.estrada >= OSM_AUTO_NEG_PER_CLASS) return;
      pointsAlongLine(line, 1).forEach(function(pt){
        if(byKind.estrada >= OSM_AUTO_NEG_PER_CLASS) return;
        if(tryAddNegativeSampleAt(pt[0], pt[1], sizeM, buildingRings, minDistM, addedPoints)){
          added++;
          byKind.estrada++;
        }
      });
    });

    if(added < OSM_AUTO_NEG_COUNT){
      var gridN = 6;
      var candidates = [];
      for(var i = 1; i < gridN; i++){
        for(var j = 1; j < gridN; j++){
          candidates.push([
            south + (north - south) * i / gridN,
            west + (east - west) * j / gridN
          ]);
        }
      }
      for(var k = 0; k < candidates.length && added < OSM_AUTO_NEG_COUNT; k++){
        var pt = candidates[k];
        if(tryAddNegativeSampleAt(pt[0], pt[1], sizeM, buildingRings, minDistM, addedPoints)){
          added++;
        }
      }
    }

    return { added: added, byKind: byKind };
  }

  function setOsmStatusText(text){
    var el = $('va-osm-status');
    if(el) el.textContent = text;
  }

  function formatNegKindSummary(byKind){
    var parts = [];
    if(byKind.floresta > 0) parts.push(byKind.floresta + ' floresta');
    if(byKind.agricola > 0) parts.push(byKind.agricola + ' agricola');
    if(byKind.estrada > 0) parts.push(byKind.estrada + ' estrada');
    return parts.length > 0 ? ' (' + parts.join(', ') + ')' : '';
  }

  /* Area aproximada de um ring (lat/lng) em m2, por projecao local
     equirectangular (suficiente para uma estimativa de cobertura -- nao
     precisa da precisao geodesica usada no worker para os poligonos
     finais). */
  function ringAreaM2(ring){
    var n = ring.length - 1;
    if(n < 3) return 0;
    var latSum = 0;
    for(var i = 0; i < n; i++) latSum += ring[i][0];
    var latMid = latSum / n;
    var latM = 111320;
    var lngM = 111320 * Math.cos(latMid * Math.PI / 180);
    var area = 0;
    for(var i = 0; i < n; i++){
      var j = (i + 1) % n;
      var x1 = ring[i][1] * lngM, y1 = ring[i][0] * latM;
      var x2 = ring[j][1] * lngM, y2 = ring[j][0] * latM;
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area) / 2;
  }

  /* Se a area desenhada ja esta densamente coberta por edificios OSM
     (centro urbano ja mapeado), correr o classificador nao ajuda -- o
     objetivo desta ferramenta e detetar construcoes que o OSM AINDA NAO
     tem. Nesses casos os edificios OSM ja importados como amostra positiva
     (passo seguinte) sao, na pratica, o resultado que se quer: mais vale
     avisar e sugerir reduzir a area a zonas sem cobertura. */
  var OSM_COVERAGE_WARN_AREA_RATIO = 0.28; // >=28% da area desenhada ja coberta por edificios OSM
  var OSM_COVERAGE_WARN_MIN_COUNT = 25;    // ou simplesmente muitos edificios OSM na area, zona urbana densa

  function updateOsmCoverageWarning(coverageRatio, buildingCount){
    var el = $('va-osm-coverage-warn');
    if(!el) return;
    var show = coverageRatio >= OSM_COVERAGE_WARN_AREA_RATIO || buildingCount >= OSM_COVERAGE_WARN_MIN_COUNT;
    if(show){
      var pctEl = $('va-osm-coverage-pct');
      if(pctEl) pctEl.textContent = Math.round(coverageRatio * 100);
      var countEl = $('va-osm-coverage-count');
      if(countEl) countEl.textContent = buildingCount;
    }
    el.classList.toggle('hidden', !show);
  }

  /* Aviso "area demasiado grande" -- ver nota junto a estimateZoom() sobre
     porque o zoom de classificacao deixou de baixar com a area (isso e'
     que causava a celula do SLIC/grid ficar maior do que ruas/edificios
     em areas grandes). Como agora o zoom fica sempre alto o suficiente
     para uma resolucao fiavel, o numero de tiles/pixels do mosaico pode
     crescer muito em areas grandes -- em vez de deixar continuar (o que
     pode esgotar memoria do canvas ou demorar minutos), bloqueamos o
     avanco do passo 3 e pedimos uma area mais pequena. O elemento HTML
     nao existe no template (page injetado antes do resto do app existir),
     por isso e' criado por JS na primeira vez, tal como injectOsmStatusUI. */
  function injectAreaTooLargeWarningUI(){
    if($('va-area-toolarge-warn')) return;
    var estimate = $('va-estimate');
    if(!estimate || !estimate.parentNode) return;
    var el = document.createElement('div');
    el.id = 'va-area-toolarge-warn';
    el.className = 'hidden';
    el.style.cssText = 'margin-top:8px;padding:10px 12px;border:1px solid var(--warn, #b45309);' +
      'border-radius:var(--radius-sm, 6px);background:rgba(180,83,9,0.08);' +
      'color:var(--warn, #b45309);font-size:0.85rem;line-height:1.4;';
    el.innerHTML = 'Área demasiado grande para a resolução de classificação necessária ' +
      '(<span id="va-area-toolarge-tiles"></span> tiles a zoom <span id="va-area-toolarge-zoom"></span>, ' +
      'limite de ' + CLASSIFICATION_MAX_TILES + '). Desenhe uma área mais pequena para continuar.';
    estimate.parentNode.insertBefore(el, estimate.nextSibling);
  }

  function updateAreaTooLargeWarning(show, tiles, zoom){
    injectAreaTooLargeWarningUI();
    var el = $('va-area-toolarge-warn');
    if(!el) return;
    if(show){
      var tilesEl = $('va-area-toolarge-tiles');
      if(tilesEl) tilesEl.textContent = tiles;
      var zoomEl = $('va-area-toolarge-zoom');
      if(zoomEl) zoomEl.textContent = zoom;
    }
    el.classList.toggle('hidden', !show);
  }

  function importOsmBuildingsForArea(bounds, zoom, areaM2){
    setOsmStatusText('A importar edificios e cobertura do solo (OpenStreetMap)...');
    updateOsmCoverageWarning(0, 0);
    fetchOsmTrainingFeatures(bounds).then(function(data){
      data.buildingRings.forEach(function(ring){
        var layer = L.polygon(ring).addTo(map);
        addSampleFromLayer(layer, 'building');
      });
      var totalBuildingAreaM2 = data.buildingRings.reduce(function(sum, ring){ return sum + ringAreaM2(ring); }, 0);
      var coverageRatio = areaM2 > 0 ? totalBuildingAreaM2 / areaM2 : 0;
      updateOsmCoverageWarning(coverageRatio, data.buildingRings.length);
      var neg = generateAutoNegativeSamples(bounds, data.buildingRings, data.landcoverRings, data.roadLines, zoom);
      var kindText = formatNegKindSummary(neg.byKind);
      if(data.buildingRings.length > 0){
        setOsmStatusText(data.buildingRings.length + ' edificio(s) OSM importado(s) como amostra positiva' + (data.buildingRings.length === 1 ? '' : 's') +
          (neg.added > 0 ? '; ' + neg.added + ' amostra(s) negativa(s) geradas automaticamente' + kindText + '.' : '.'));
      } else {
        setOsmStatusText('Nenhum edificio OSM encontrado nesta area' +
          (neg.added > 0 ? ' (' + neg.added + ' amostra(s) negativa(s) geradas automaticamente' + kindText + ').' : '.') +
          ' Usa o desenho manual ou o magic wand no passo seguinte.');
      }
    }).catch(function(err){
      console.error('[VetAssist] Erro Overpass:', err);
      setOsmStatusText('Nao foi possivel importar dados OSM (' + err.message + '). Podes continuar manualmente no passo seguinte.');
    });
  }

  /* ---- Step 4: Amostras ---- */
  function startSampleDrawing(label){
    cancelAreaDrawing();
    vaState.vaDrawingActive = true;
    window.vaDrawingActive = true;
    vaState.sampleDrawing = true;
    vaState.sampleLabel = label;
    $('va-page').classList.add('va-drawing');
    var banner = $('va-sample-banner');
    banner.classList.remove('hidden');
    $('va-sample-banner-text').textContent = label === 'building'
      ? 'Desenha um poligono sobre um edificio.'
      : 'Desenha um poligono sobre uma area NAO-edificio (vegetacao, estrada, solo, etc.).';
    map.pm.enableDraw('Polygon');
  }

  function cancelSampleDrawing(){
    vaState.vaDrawingActive = false;
    window.vaDrawingActive = false;
    vaState.sampleDrawing = false;
    vaState.sampleLabel = null;
    $('va-page').classList.remove('va-drawing');
    $('va-sample-banner').classList.add('hidden');
    if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
    if(vaState.magicWandActive) cancelMagicWand();
  }

  function onSampleDrawn(layer){
    if(!vaState.sampleDrawing) return false;
    var savedLabel = vaState.sampleLabel;
    cancelSampleDrawing();
    addSampleFromLayer(layer, savedLabel);
    return true;
  }

  /* Adiciona uma layer (poligono) como amostra de treino, seja ela vinda do
     desenho manual (leaflet-geoman) ou da selecao automatica por clique
     (magic wand). Centraliza estilo + registo em vaState.samples. */
  function addSampleFromLayer(layer, label){
    var id = 'va-sample-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    var entry = { id: id, label: label, layer: layer };
    vaState.samples.push(entry);
    var color = label === 'building' ? '#2f7d4f' : '#b5472b';
    layer.setStyle({ color: color, weight: 2, fillColor: color, fillOpacity: 0.25, dashArray: '4 4' });
    updateSampleUI();
  }

  function updateSampleUI(){
    var posCount = vaState.samples.filter(function(s){ return s.label === 'building'; }).length;
    var negCount = vaState.samples.filter(function(s){ return s.label === 'non-building'; }).length;
    $('va-sample-pos-count').textContent = posCount;
    $('va-sample-neg-count').textContent = negCount;
    $('va-step4-start').disabled = !(posCount >= 3 && negCount >= 3);
    var list = $('va-sample-list');
    list.innerHTML = vaState.samples.map(function(s, i){
      var tag = s.label === 'building' ? 'Edificio' : 'Nao-edificio';
      var bg = s.label === 'building' ? 'rgba(47,125,79,.1)' : 'rgba(181,71,43,.1)';
      return '<span style="display:inline-block;padding:2px 6px;border-radius:4px;margin:2px;font-size:10px;background:' + bg + ';">' + tag + ' #' + (i+1) + '</span>';
    }).join('');
  }

  /* ============================================================
     Selecao automatica por clique ("magic wand")
     ------------------------------------------------------------
     Em vez de desenhar manualmente o poligono da amostra, o utilizador
     clica sobre um ponto (ex: um telhado) e o algoritmo:
       1. Faz "region growing" (flood fill) a partir desse pixel,
          agregando pixels vizinhos com cor semelhante (dentro de uma
          janela local, para nao "rebentar" para a imagem toda se o
          clique cair numa area grande e uniforme).
       2. Traca o contorno da mancha resultante usando o MESMO algoritmo
          de arestas direcionadas ja usado no worker para vetorizar os
          poligonos finais (robusto a formas complexas, sem as diagonais
          gigantes do tracing antigo).
       3. Converte o contorno de pixels do mosaico para lat/lng e cria
          um poligono editavel (arrastavel, via leaflet-geoman) que e
          adicionado como amostra de treino.
     ============================================================ */
  var MW_WINDOW_RADIUS_PX = 70; // raio (em px do CROP de alta resolucao) da janela de procura a volta do clique
  var MW_GRADIENT_THRESHOLD = 130; // magnitude Sobel: arestas fortes param o flood fill

  var MW_TOLERANCE_PRESETS = { baixa: 25, media: 42, alta: 60 }; // distancia euclidiana RGB (0-441)

  /* O magic wand precisa de resolucao ao nivel do edificio (~0.2-0.3 m/px),
     independentemente do zoom escolhido para a captura da area de trabalho
     inteira (esse zoom e propositadamente baixo em areas grandes, para nao
     pedir milhares de tiles -- ver estimateZoom). Reutilizar esse mosaico de
     baixa resolucao para o magic wand foi o bug real por tras dos "vazamentos"
     gigantes: uma janela de poucas dezenas de pixels nesse mosaico podia
     corresponder a dezenas de metros reais no terreno, cobrindo varias casas,
     arvores e a rua -- nao era a comparacao de cor que estava errada, era a
     area coberta por cada pixel que era grande demais.
     Por isso o magic wand agora pede sempre um crop pequeno e de zoom fixo
     e elevado, centrado no ponto clicado, em vez de reutilizar o mosaico
     grande. Mantem-se em cache o ultimo crop pedido para evitar pedidos de
     tiles repetidos quando o utilizador clica varias vezes perto uns dos
     outros. */
  var MW_CAPTURE_ZOOM = 19; // ~0.2-0.3 m/px a latitudes de Portugal -- suficiente para separar edificios individuais
  var MW_CAPTURE_RADIUS_M = 45; // raio (em metros) do crop pedido a volta de cada clique

  function boundsAroundLatLng(lat, lng, radiusM){
    var dLat = radiusM / 111320;
    var dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
    return { north: lat + dLat, south: lat - dLat, east: lng + dLng, west: lng - dLng };
  }

  function latLngWithinCropMargin(latlng, crop){
    if(!crop) return false;
    var marginLat = (crop.bounds.north - crop.bounds.south) * 0.2;
    var marginLng = (crop.bounds.east - crop.bounds.west) * 0.2;
    return latlng.lat > crop.bounds.south + marginLat && latlng.lat < crop.bounds.north - marginLat &&
           latlng.lng > crop.bounds.west + marginLng && latlng.lng < crop.bounds.east - marginLng;
  }

  function ensureHighResCropAroundClick(latlng){
    if(latLngWithinCropMargin(latlng, vaState.mwCropCache)){
      return Promise.resolve(vaState.mwCropCache);
    }
    var bounds = boundsAroundLatLng(latlng.lat, latlng.lng, MW_CAPTURE_RADIUS_M);
    setMagicWandBannerText('A carregar imagem de alta resolucao...');
    return captureBasemapPixels(bounds, MW_CAPTURE_ZOOM).then(function(result){
      vaState.mwCropCache = result;
      setMagicWandBannerText(magicWandBannerDefaultText());
      return result;
    }).catch(function(err){
      setMagicWandBannerText('Erro ao carregar imagem: ' + err.message);
      throw err;
    });
  }

  function magicWandBannerDefaultText(){
    return vaState.magicWandLabel === 'building'
      ? 'Clica sobre um edificio para o algoritmo desenhar o limite automaticamente.'
      : 'Clica sobre uma area NAO-edificio para o algoritmo desenhar o limite automaticamente.';
  }

  function setMagicWandBannerText(text){
    var el = $('va-magicwand-banner-text');
    if(el) el.textContent = text;
  }

  function startMagicWand(label){
    cancelAreaDrawing();
    cancelSampleDrawing();
    vaState.magicWandActive = true;
    vaState.magicWandLabel = label;
    window.vaDrawingActive = true;
    $('va-page').classList.add('va-drawing');
    var banner = $('va-magicwand-banner');
    if(banner) banner.classList.remove('hidden');
    setMagicWandBannerText(magicWandBannerDefaultText());
    if(map && map.getContainer()) map.getContainer().style.cursor = 'crosshair';
    if(map) map.on('click', onMagicWandClick);
    /* Nao ha imagem para pre-carregar aqui -- o crop de alta resolucao e
       pedido a volta do primeiro clique, ja que so ai sabemos onde o
       utilizador quer clicar. */
  }

  function cancelMagicWand(){
    vaState.magicWandActive = false;
    vaState.magicWandLabel = null;
    window.vaDrawingActive = false;
    $('va-page').classList.remove('va-drawing');
    var banner = $('va-magicwand-banner');
    if(banner) banner.classList.add('hidden');
    if(map && map.getContainer()) map.getContainer().style.cursor = '';
    if(map) map.off('click', onMagicWandClick);
  }

  function onMagicWandClick(e){
    if(!vaState.magicWandActive) return;
    ensureHighResCropAroundClick(e.latlng).then(function(crop){
      processMagicWandClick(e.latlng, crop);
    }).catch(function(){ /* erro ja reportado em ensureHighResCropAroundClick */ });
  }

  function processMagicWandClick(latlng, mosaic){
    var b = mosaic.bounds;
    var seedX = Math.round((latlng.lng - b.west) / (b.east - b.west) * mosaic.width);
    var seedY = Math.round((b.north - latlng.lat) / (b.north - b.south) * mosaic.height);
    if(seedX < 0 || seedX >= mosaic.width || seedY < 0 || seedY >= mosaic.height){
      showAppAlert('Clica dentro da area de trabalho desenhada no passo anterior.');
      return;
    }

    var toleranceSel = $('va-magicwand-tolerance');
    var tolerance = MW_TOLERANCE_PRESETS[(toleranceSel && toleranceSel.value) || 'media'];

    var result = floodFillMask(mosaic.pixelData, mosaic.width, mosaic.height, seedX, seedY, tolerance, MW_WINDOW_RADIUS_PX);
    if(!result){
      showAppAlert('Nao foi possivel isolar uma area definida. Tenta clicar mais ao centro do edificio, ou reduz a sensibilidade.', {error:true});
      return;
    }

    var ring = traceMaskBoundary(result.mask, result.w, result.h, result.seedLx, result.seedLy);
    if(!ring || ring.length < 4){
      showAppAlert('Nao foi possivel tracar um contorno valido nesse ponto. Tenta outro clique.', {error:true});
      return;
    }

    /* Simplificacao agressiva: DP com 4px para reduzir centenas de
       verticces para ~10-25. Depois remove colineares e verticces
       muito proximos. So depois ortogonaliza se necessario. */
    ring = douglasPeucker(ring, 4.0);
    if(ring.length < 4){
      showAppAlert('Contorno demasiado pequeno apos simplificacao.', {error:true});
      return;
    }
    ring = removeCollinearPoints(ring);
    ring = weldNearPoints(ring, 3.0);
    ring = removeCollinearPoints(ring);

    var orthoCheckbox = $('va-magicwand-ortho');
    if(!orthoCheckbox || orthoCheckbox.checked){
      ring = orthogonalizeRing(ring);
      ring = removeCollinearPoints(ring);
      ring = weldNearPoints(ring, 2.0);
    }

    /* Fecha o anel (garantir que primeiro e ultimo coincidem) */
    if(ring.length > 0){
      ring.push([ring[0][0], ring[0][1]]);
    }

    var latlngs = ring.map(function(pt){
      var gx = pt[0] + result.offsetX;
      var gy = pt[1] + result.offsetY;
      var lng = b.west + (gx / mosaic.width) * (b.east - b.west);
      var lat = b.north - (gy / mosaic.height) * (b.north - b.south);
      return [lat, lng];
    });

    var layer = L.polygon(latlngs).addTo(map);
    if(layer.pm && typeof layer.pm.enable === 'function'){
      try { layer.pm.enable(); } catch(err){ /* geoman pode nao estar disponivel para esta layer */ }
    }
    addSampleFromLayer(layer, vaState.magicWandLabel);
  }

function floodFillMask(pixelData, mosaicW, mosaicH, seedX, seedY, tolerance, windowRadius){
    var minX = Math.max(0, seedX - windowRadius);
    var maxX = Math.min(mosaicW - 1, seedX + windowRadius);
    var minY = Math.max(0, seedY - windowRadius);
    var maxY = Math.min(mosaicH - 1, seedY + windowRadius);
    var winW = maxX - minX + 1;
    var winH = maxY - minY + 1;

    function readPx(x, y){
      var i = (y * mosaicW + x) * 4;
      return [pixelData[i], pixelData[i + 1], pixelData[i + 2]];
    }
    function gray(x, y){
      var i = (y * mosaicW + x) * 4;
      return pixelData[i] * 0.299 + pixelData[i + 1] * 0.587 + pixelData[i + 2] * 0.114;
    }

    /* Pre-computa gradiente Sobel 3x3 na ROI (só gray) */
    var grad = new Uint8Array(winW * winH);
    for(var y = 0; y < winH; y++){
      for(var x = 0; x < winW; x++){
        var gx = minX + x, gy = minY + y;
        if(gx < 1 || gx >= mosaicW - 1 || gy < 1 || gy >= mosaicH - 1){
          grad[y * winW + x] = 255; continue;
        }
        var gxVal = -gray(gx - 1, gy - 1) + gray(gx + 1, gy - 1)
                    -2 * gray(gx - 1, gy) + 2 * gray(gx + 1, gy)
                    -gray(gx - 1, gy + 1) + gray(gx + 1, gy + 1);
        var gyVal = -gray(gx - 1, gy - 1) -2 * gray(gx, gy - 1) - gray(gx + 1, gy - 1)
                    +gray(gx - 1, gy + 1) + 2 * gray(gx, gy + 1) + gray(gx + 1, gy + 1);
        grad[y * winW + x] = Math.sqrt(gxVal * gxVal + gyVal * gyVal) > MW_GRADIENT_THRESHOLD ? 255 : 0;
      }
    }

    /* Cor de referencia = media 3x3 a volta do clique */
    var rSum = 0, gSum = 0, bSum = 0, nRef = 0;
    for(var dy = -1; dy <= 1; dy++){
      for(var dx = -1; dx <= 1; dx++){
        var sx = seedX + dx, sy = seedY + dy;
        if(sx < 0 || sx >= mosaicW || sy < 0 || sy >= mosaicH) continue;
        var c0 = readPx(sx, sy);
        rSum += c0[0]; gSum += c0[1]; bSum += c0[2]; nRef++;
      }
    }
    var refR = Math.round(rSum / nRef), refG = Math.round(gSum / nRef), refB = Math.round(bSum / nRef);

    var mask = new Uint8Array(winW * winH);
    var visited = new Uint8Array(winW * winH);
    var stack = [[seedX - minX, seedY - minY]];
    visited[(seedY - minY) * winW + (seedX - minX)] = 1;
    var filledCount = 0;
    var maxFill = Math.floor(winW * winH * 0.6);
    var bb = { minX: seedX - minX, minY: seedY - minY, maxX: seedX - minX, maxY: seedY - minY };

    /* Adaptive reference: actualiza lentamente para seguir variacao suave dentro do telhado.
       MAS sem nenhum travao, esta adaptacao sofre de "color drift" (color
       walk): cada passo e pequeno e "razoavel" localmente (dentro da
       tolerancia face a referencia atual), mas ao fim de centenas de
       pixels a referencia pode ter-se afastado muito da cor original do
       clique, permitindo que o fill atravesse telhado -> sombra -> rua ->
       outro telhado sem nunca violar a tolerancia local. Isto e exatamente
       o que estava a fundir varios edificios/ruas/logradouros numa mancha
       so. Fix: alem da distancia a referencia adaptativa, exige-se tambem
       que a cor nunca se afaste mais do que maxDriftFromAnchor da cor
       ORIGINAL do clique (que nunca muda) -- um travao duro independente
       da deriva gradual. */
    var anchorR = refR, anchorG = refG, anchorB = refB;
    var maxDriftFromAnchor = tolerance * 1.4;
    var adaptR = refR, adaptG = refG, adaptB = refB;
    var adaptCount = 0;
    var maxAdaptDist = tolerance * 0.55;

    while(stack.length > 0){
      var cur = stack.pop();
      var lx = cur[0], ly = cur[1];
      var c = readPx(lx + minX, ly + minY);
      var dist = Math.sqrt(Math.pow(c[0] - adaptR, 2) + Math.pow(c[1] - adaptG, 2) + Math.pow(c[2] - adaptB, 2));
      if(dist > tolerance) continue;
      var distAnchor = Math.sqrt(Math.pow(c[0] - anchorR, 2) + Math.pow(c[1] - anchorG, 2) + Math.pow(c[2] - anchorB, 2));
      if(distAnchor > maxDriftFromAnchor) continue;
      mask[ly * winW + lx] = 1;
      filledCount++;
      if(filledCount > maxFill) return null;

      /* Adaptive ref: se o pixel estiver dentro de um limiar menor,
         actualiza lentamente a referencia para seguir o telhado */
      if(dist < maxAdaptDist){
        adaptR += Math.round((c[0] - adaptR) * 0.1);
        adaptG += Math.round((c[1] - adaptG) * 0.1);
        adaptB += Math.round((c[2] - adaptB) * 0.1);
      }

      if(lx < bb.minX) bb.minX = lx;
      if(lx > bb.maxX) bb.maxX = lx;
      if(ly < bb.minY) bb.minY = ly;
      if(ly > bb.maxY) bb.maxY = ly;
      adaptCount++;
      if(adaptCount >= 64){
        adaptCount = 0;
        var bbW = bb.maxX - bb.minX + 1;
        var bbH = bb.maxY - bb.minY + 1;
        var ratio = bbW > bbH ? bbW / bbH : bbH / bbW;
        if(ratio > 6.0 && filledCount > 200) return null;
      }

      var neigh = [[lx - 1, ly], [lx + 1, ly], [lx, ly - 1], [lx, ly + 1]];
      for(var k = 0; k < neigh.length; k++){
        var nx = neigh[k][0], ny = neigh[k][1];
        if(nx < 0 || nx >= winW || ny < 0 || ny >= winH) continue;
        var vi = ny * winW + nx;
        if(visited[vi]) continue;
        visited[vi] = 1;

        /* Edge-stop: se o vizinho tem gradiente forte, verifica se
           a cor ainda e semelhante - se nao for, e uma aresta real */
        if(grad[vi] === 255){
          var nc = readPx(nx + minX, ny + minY);
          var nd = Math.sqrt(Math.pow(nc[0] - adaptR, 2) + Math.pow(nc[1] - adaptG, 2) + Math.pow(nc[2] - adaptB, 2));
          if(nd > tolerance * 0.7) continue; // aresta real: nao cruza
        }
        stack.push([nx, ny]);
      }
    }
    if(filledCount < 4) return null;

    /* Close (preenche buracos) + open (corta pontes) */
    var closed = closeMask(mask, winW, winH);
    var opened = openMask(closed, winW, winH);

    var seedLx = seedX - minX, seedLy = seedY - minY;
    var isolated = keepComponentContainingSeed(opened, winW, winH, seedLx, seedLy);
    if(isolated && isolated.count >= 4){
      mask = isolated.mask;
    }

    return { mask: mask, w: winW, h: winH, offsetX: minX, offsetY: minY, seedLx: seedLx, seedLy: seedLy };
  }

  /* Erosao seguida de dilatacao (4-conectividade), 1 iteracao: remove
     pontes/protuberancias com menos de ~2px de largura mantendo a forma
     geral de blobs solidos. */
  function openMask(mask, w, h){
    function get(m, x, y){
      if(x < 0 || x >= w || y < 0 || y >= h) return 0;
      return m[y * w + x];
    }
    var eroded = new Uint8Array(w * h);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        if(get(mask, x, y) && get(mask, x - 1, y) && get(mask, x + 1, y) &&
           get(mask, x, y - 1) && get(mask, x, y + 1)){
          eroded[y * w + x] = 1;
        }
      }
    }
    var dilated = new Uint8Array(w * h);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        if(get(eroded, x, y) || get(eroded, x - 1, y) || get(eroded, x + 1, y) ||
           get(eroded, x, y - 1) || get(eroded, x, y + 1)){
          dilated[y * w + x] = 1;
        }
      }
    }
    return dilated;
  }

  /* Fecho morfologico (dilatacao seguida de erosao, 1 iteracao 4-viz):
     preenche pequenos buracos e une fragmentos proximos sem alterar
     a forma geral. */
  function closeMask(mask, w, h){
    function get(m, x, y){
      if(x < 0 || x >= w || y < 0 || y >= h) return 0;
      return m[y * w + x];
    }
    var dilated = new Uint8Array(w * h);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        if(get(mask, x, y) || get(mask, x - 1, y) || get(mask, x + 1, y) ||
           get(mask, x, y - 1) || get(mask, x, y + 1)){
          dilated[y * w + x] = 1;
        }
      }
    }
    var closed = new Uint8Array(w * h);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        if(get(dilated, x, y) && get(dilated, x - 1, y) && get(dilated, x + 1, y) &&
           get(dilated, x, y - 1) && get(dilated, x, y + 1)){
          closed[y * w + x] = 1;
        }
      }
    }
    return closed;
  }

  /* Isola, por BFS 4-conectado, apenas a componente conexa que contem
     (seedLx, seedLy). Devolve null se o pixel de partida ja nao estiver
     preenchido nessa mascara (ex: opening removeu-o). */
  function keepComponentContainingSeed(mask, w, h, seedLx, seedLy){
    if(seedLx < 0 || seedLx >= w || seedLy < 0 || seedLy >= h) return null;
    if(!mask[seedLy * w + seedLx]) return null;

    var result = new Uint8Array(w * h);
    var visited = new Uint8Array(w * h);
    var stack = [[seedLx, seedLy]];
    visited[seedLy * w + seedLx] = 1;
    var count = 0;
    while(stack.length > 0){
      var cur = stack.pop();
      var x = cur[0], y = cur[1];
      result[y * w + x] = 1;
      count++;
      var neigh = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for(var k = 0; k < neigh.length; k++){
        var nx = neigh[k][0], ny = neigh[k][1];
        if(nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        var vi = ny * w + nx;
        if(visited[vi] || !mask[vi]) continue;
        visited[vi] = 1;
        stack.push([nx, ny]);
      }
    }
    return { mask: result, count: count };
  }

  /* ---- Tracing de contorno por arestas direcionadas (mesma tecnica do
     worker, adaptada para operar sobre uma mascara binaria pixel-a-pixel
     em vez de uma grelha de superpixels) ---- */
  function pointInPolygonXY(x, y, ring){
    var inside = false;
    for(var i = 0, j = ring.length - 2; i < ring.length - 1; j = i++){
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      var intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if(intersect) inside = !inside;
    }
    return inside;
  }

  function traceMaskBoundary(mask, w, h, seedLx, seedLy){
    function filled(x, y){
      if(x < 0 || x >= w || y < 0 || y >= h) return false;
      return mask[y * w + x] === 1;
    }
    var edges = [];
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        if(!filled(x, y)) continue;
        if(!filled(x, y - 1)) edges.push([[x, y], [x + 1, y]]);         // topo
        if(!filled(x + 1, y)) edges.push([[x + 1, y], [x + 1, y + 1]]); // direita
        if(!filled(x, y + 1)) edges.push([[x + 1, y + 1], [x, y + 1]]); // baixo
        if(!filled(x - 1, y)) edges.push([[x, y + 1], [x, y]]);          // esquerda
      }
    }
    if(edges.length < 3) return null;

    var vKey = function(v){ return v[0] + ',' + v[1]; };
    var entries = edges.map(function(ed){ return { edge: ed, used: false }; });
    var byStart = {};
    entries.forEach(function(en){
      var k = vKey(en.edge[0]);
      if(!byStart[k]) byStart[k] = [];
      byStart[k].push(en);
    });

    function edgeDir(edge){ return [edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]]; }
    function turnPriority(dirIn, dirOut){
      var dot = dirIn[0] * dirOut[0] + dirIn[1] * dirOut[1];
      var cross = dirIn[0] * dirOut[1] - dirIn[1] * dirOut[0];
      if(cross > 0.5) return 0;
      if(dot > 0.5) return 1;
      if(cross < -0.5) return 2;
      return 3;
    }

    var loops = [];
    var maxSteps = entries.length + 2;
    for(var idx = 0; idx < entries.length; idx++){
      var startEntry = entries[idx];
      if(startEntry.used) continue;
      var loopPts = [];
      var curEntry = startEntry;
      var startKey = vKey(startEntry.edge[0]);
      var guard = 0;
      while(true){
        curEntry.used = true;
        var edge = curEntry.edge;
        loopPts.push(edge[0]);
        var dir = edgeDir(edge);
        var endKey = vKey(edge[1]);
        guard++;
        if(endKey === startKey || guard > maxSteps) break;
        var candidates = byStart[endKey];
        if(!candidates) break;
        var best = null, bestScore = Infinity;
        for(var ci = 0; ci < candidates.length; ci++){
          var cand = candidates[ci];
          if(cand.used) continue;
          var score = turnPriority(dir, edgeDir(cand.edge));
          if(score < bestScore){ bestScore = score; best = cand; }
        }
        if(!best) break;
        curEntry = best;
      }
      if(loopPts.length >= 3){
        loopPts.push(loopPts[0].slice());
        loops.push(loopPts);
      }
    }
    if(loops.length === 0) return null;

    var candidates = [];
    for(var i = 0; i < loops.length; i++){
      var a = 0;
      for(var j = 0; j < loops[i].length - 1; j++){
        a += loops[i][j][0] * loops[i][j + 1][1] - loops[i][j + 1][0] * loops[i][j][1];
      }
      candidates.push({ loop: loops[i], area: Math.abs(a / 2) });
    }

    /* Uma mascara isolada por keepComponentContainingSeed continua a poder
       gerar mais do que um loop se a forma se tocar a si propria num unico
       vertice (ex: edificio em L, ou dois "colados" por um so pixel).
       ANTES escolhia-se sempre o loop de maior area -- se o lobo que o
       utilizador clicou fosse o mais pequeno dos dois, o poligono devolvido
       nem sequer continha o ponto do clique. Agora: preferir sempre o loop
       que contem o pixel clicado; so cair para "maior area" se, por algum
       motivo inesperado, nenhum loop contiver o ponto. */
    if(typeof seedLx === 'number' && typeof seedLy === 'number'){
      var seedRing = null;
      for(var i2 = 0; i2 < candidates.length; i2++){
        if(pointInPolygonXY(seedLx + 0.5, seedLy + 0.5, candidates[i2].loop)){
          if(!seedRing || candidates[i2].area > seedRing.area) seedRing = candidates[i2];
        }
      }
      if(seedRing) return seedRing.loop;
    }

    var bestRing = null, bestArea = -1;
    for(var i3 = 0; i3 < candidates.length; i3++){
      if(candidates[i3].area > bestArea){ bestArea = candidates[i3].area; bestRing = candidates[i3].loop; }
    }
    return bestRing;
  }

  /* ---- Ortogonalizacao do contorno tracado pelo magic wand ----
     Portado de orthogonalizePolygon() no worker (14b), adaptado para
     operar em coordenadas de pixel da janela local (em vez de graus
     lng/lat): a projecao Web Mercator e localmente conforme, por isso
     ortogonalizar em pixels ANTES de converter para lat/lng preserva
     melhor os angulos do que ortogonalizar em graus (que distorce com
     a latitude), e evita duplicar a logica de projecao para metros que
     o worker usa para a simplificacao em lote.
     Ao contrario da versao do worker (que so atua se confidence >= 0.4,
     vindo do classificador), aqui nao ha "confidence" -- e o utilizador
     que clicou a dizer "isto e um edificio" -- por isso o unico filtro
     e a proporcao de angulos ja proximos de 90 graus, para nao forcar
     formas claramente nao-retangulares (ex: telhados curvos). */
  function orthogonalizeRing(ring){
    if(ring.length < 5) return ring;
    var n = ring.length - 1;

    var origArea = Math.abs(signedAreaXY(ring));
    if(origArea < 1e-6) return ring;

    var origCx = 0, origCy = 0;
    for(var i = 0; i < n; i++){ origCx += ring[i][0]; origCy += ring[i][1]; }
    origCx /= n; origCy /= n;

    var rightAngles = 0;
    for(var i = 0; i < n; i++){
      var prev = ring[(i - 1 + n) % n];
      var cur = ring[i];
      var next = ring[(i + 1) % n];
      var dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
      var dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
      var dot = dx1 * dx2 + dy1 * dy2;
      var cross = dx1 * dy2 - dy1 * dx2;
      var angle = Math.atan2(Math.abs(cross), dot);
      if(Math.abs(angle - Math.PI / 2) < 0.5) rightAngles++;
    }
    if(rightAngles < Math.floor(n * 0.3)) return ring; // nao parece retangular -- nao mexer

    var result = ring.slice().map(function(p){ return p.slice(); });
    var baseStep = 0.05;

    for(var iter = 0; iter < 10; iter++){
      var step = baseStep * (1 - iter / 12);
      for(var i = 0; i < n; i++){
        var prev = result[(i - 1 + n) % n];
        var cur = result[i];
        var next = result[(i + 1) % n];
        var dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
        var dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
        var len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        var len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if(len1 < 1e-9 || len2 < 1e-9) continue;

        var a1 = Math.atan2(dy1, dx1);
        var a2 = Math.atan2(dy2, dx2);
        var avgA = (a1 + a2) / 2;
        if(Math.abs(a1 - a2) > Math.PI) avgA += Math.PI;

        var targetAngle = Math.round(avgA / (Math.PI / 2)) * (Math.PI / 2);
        var angleDelta = targetAngle - avgA;

        var avgLen = (len1 + len2) / 2;
        var bisectAngle = targetAngle + Math.PI / 2;
        var mag = avgLen * step * (1 + Math.abs(angleDelta) * 2);
        var dx = Math.cos(bisectAngle) * mag;
        var dy = Math.sin(bisectAngle) * mag;

        var crossVal = dx1 * dy2 - dy1 * dx2;
        var crossSign = crossVal > 0 ? 1 : -1;
        result[i] = [cur[0] + dx * crossSign, cur[1] + dy * crossSign];
      }
    }

    result[n] = [result[0][0], result[0][1]];

    var newArea = Math.abs(signedAreaXY(result));
    if(newArea > 1e-6){
      var scale = Math.sqrt(origArea / newArea);
      var newCx = 0, newCy = 0;
      for(var i = 0; i < n; i++){ newCx += result[i][0]; newCy += result[i][1]; }
      newCx /= n; newCy /= n;
      for(var i = 0; i < n; i++){
        result[i][0] = origCx + (result[i][0] - newCx) * scale;
        result[i][1] = origCy + (result[i][1] - newCy) * scale;
      }
      result[n] = [result[0][0], result[0][1]];
    }

    return result;
  }

  function signedAreaXY(ring){
    var a = 0;
    var n = ring.length - 1;
    for(var i = 0; i < n; i++){
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return a / 2;
  }

  function douglasPeucker(points, tolerance){
    if(points.length <= 2) return points;
    var maxDist = 0, maxIdx = 0;
    var first = points[0], last = points[points.length - 1];
    for(var i = 1; i < points.length - 1; i++){
      var d = perpendicularDist(points[i], first, last);
      if(d > maxDist){ maxDist = d; maxIdx = i; }
    }
    if(maxDist > tolerance){
      var left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
      var right = douglasPeucker(points.slice(maxIdx), tolerance);
      return left.slice(0, left.length - 1).concat(right);
    }
    return [first, last];
  }

  function perpendicularDist(point, lineStart, lineEnd){
    var dx = lineEnd[0] - lineStart[0];
    var dy = lineEnd[1] - lineStart[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if(len === 0) return Math.sqrt(Math.pow(point[0] - lineStart[0], 2) + Math.pow(point[1] - lineStart[1], 2));
    return Math.abs(dy * point[0] - dx * point[1] + lineEnd[0] * lineStart[1] - lineEnd[1] * lineStart[0]) / len;
  }

  /* Remove vertices colineares: se o angulo entre (prev->cur) e
     (cur->next) for ~180°, cur e redundante. */
  function removeCollinearPoints(ring, angleThreshold){
    angleThreshold = angleThreshold || 0.97;
    var n = ring.length;
    if(n < 4) return ring;
    var result = [];
    for(var i = 0; i < n; i++){
      var prev = ring[(i - 1 + n) % n];
      var cur = ring[i];
      var next = ring[(i + 1) % n];
      var dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
      var dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
      var len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      var len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if(len1 < 0.5 || len2 < 0.5) continue;
      var dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
      if(dot < angleThreshold) result.push([cur[0], cur[1]]);
    }
    if(result.length < 3) return ring;
    return result;
  }

  /* Solda vertices muito proximos (< distMin px) substituindo cada
     par por um ponto medio. */
  function weldNearPoints(ring, distMin){
    if(ring.length < 3) return ring;
    var result = [];
    result.push([ring[0][0], ring[0][1]]);
    for(var i = 1; i < ring.length; i++){
      var prev = result[result.length - 1];
      var cur = ring[i];
      var dx = cur[0] - prev[0], dy = cur[1] - prev[1];
      if(Math.sqrt(dx * dx + dy * dy) < distMin){
        var mx = (prev[0] + cur[0]) / 2, my = (prev[1] + cur[1]) / 2;
        result[result.length - 1] = [mx, my];
      } else {
        result.push([cur[0], cur[1]]);
      }
    }
    if(result.length >= 3){
      var last = result[result.length - 1];
      var first = result[0];
      var dx = last[0] - first[0], dy = last[1] - first[1];
      if(Math.sqrt(dx * dx + dy * dy) < distMin){
        var mx = (last[0] + first[0]) / 2, my = (last[1] + first[1]) / 2;
        result[0] = [mx, my];
        result.pop();
      }
    }
    return result.length >= 3 ? result : ring;
  }

  /* ---- Processamento ---- */
  function startProcessing(){
    showStep(5);
    $('va-progress-fill').style.width = '0%';
    $('va-progress-phase').textContent = 'A capturar imagem do basemap...';
    $('va-progress-log').innerHTML = '';

    var bounds = {
      north: vaState.areaBounds.getNorth(),
      south: vaState.areaBounds.getSouth(),
      east: vaState.areaBounds.getEast(),
      west: vaState.areaBounds.getWest()
    };
    var sampleData = vaState.samples.map(function(s){
      var gj = s.layer.toGeoJSON();
      return { label: s.label, geometry: gj.geometry };
    });
    clearSampleLayers();
    var zoom = estimateZoom(vaState.areaBounds.getCenter().lat);

    captureBasemapPixels(bounds, zoom).then(function(result){
      appendLog('Imagem capturada: ' + result.width + 'x' + result.height + ' px', 'log');
      $('va-progress-phase').textContent = 'A processar...';
      var worker = ensureWorker();
      worker.postMessage({
        type: 'process',
        mosaicWidth: result.width,
        mosaicHeight: result.height,
        pixelData: result.pixelData,
        mosaicBounds: result.bounds,
        bounds: bounds,
        samples: sampleData,
        zoom: zoom
      }, [result.pixelData.buffer]);
    }).catch(function(err){
      appendLog('Erro ao capturar basemap: ' + err.message, 'error');
      showAppAlert('Erro ao capturar imagem: ' + err.message, {error:true});
      setTimeout(function(){ showStep(4); }, 1500);
    });
  }

  function captureBasemapPixels(bounds, zoom){
    var n = Math.pow(2, zoom);
    var nwTile = latLngToTile(bounds.north, bounds.west, zoom);
    var seTile = latLngToTile(bounds.south, bounds.east, zoom);
    var minTileX = Math.min(nwTile.x, seTile.x);
    var maxTileX = Math.max(nwTile.x, seTile.x);
    var minTileY = Math.min(nwTile.y, seTile.y);
    var maxTileY = Math.max(nwTile.y, seTile.y);
    var nCols = maxTileX - minTileX + 1;
    var nRows = maxTileY - minTileY + 1;
    var TILE = 256;
    var mosaicW = nCols * TILE;
    var mosaicH = nRows * TILE;

    /* Usa o basemap ativo em vez do ArcGIS fixo */
    var tileInfo = getActiveTileInfo();

    var canvas = document.createElement('canvas');
    canvas.width = mosaicW;
    canvas.height = mosaicH;
    var ctx = canvas.getContext('2d');

    var promises = [];
    for(var tx = minTileX; tx <= maxTileX; tx++){
      for(var ty = minTileY; ty <= maxTileY; ty++){
        (function(cx, cy){
          var url;
          if(tileInfo.isWMS){
            url = tileInfo.urlTemplate
              .replace('{width}', TILE).replace('{height}', TILE)
              .replace('{bbox}', tileInfo.bboxForTile(cx, cy, zoom));
          } else {
            url = tileInfo.urlTemplate
              .replace('{z}', zoom).replace('{x}', cx).replace('{y}', cy)
              .replace('{s}', 'a');
          }
          var img = new Image();
          img.crossOrigin = 'anonymous';
          var p = new Promise(function(resolve, reject){
            img.onload = function(){
              ctx.drawImage(img, (cx - minTileX) * TILE, (cy - minTileY) * TILE, TILE, TILE);
              resolve();
            };
            img.onerror = function(){ reject(new Error('Falha ao carregar tile ' + cx + '/' + cy)); };
          });
          img.src = url;
          promises.push(p);
        })(tx, ty);
      }
    }

    /* mosaicBounds tem de corresponder EXATAMENTE aos pixels desenhados no
       canvas (tiles minTileX..maxTileX, minTileY..maxTileY). Usar
       minTileX+nCols / minTileY+nRows aqui seria pedir os limites do tile
       SEGUINTE (um tile inteiro, 256px, alem do que esta realmente
       pintado) -- isso alarga o mosaicBounds para alem da imagem real e
       faz com que toda a conversao pixel->lat/lng (features, amostras de
       treino, poligono final) fique esticada/desfasada. Correto e usar o
       INDICE do ultimo tile realmente desenhado (maxTileX/maxTileY). */
    var mosaicBounds = {
      north: tileToBounds(minTileX, minTileY, zoom).north,
      south: tileToBounds(maxTileX, maxTileY, zoom).south,
      east: tileToBounds(maxTileX, minTileY, zoom).east,
      west: tileToBounds(minTileX, minTileY, zoom).west
    };

    return Promise.all(promises).then(function(){
      var imageData = ctx.getImageData(0, 0, mosaicW, mosaicH);
      return { width: mosaicW, height: mosaicH, pixelData: imageData.data, bounds: mosaicBounds };
    });
  }

  function tileToBounds(x, y, z){
    var n = Math.pow(2, z);
    var lngW = x / n * 360 - 180;
    var lngE = (x + 1) / n * 360 - 180;
    var latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    var latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
    return { north: latN, south: latS, east: lngE, west: lngW };
  }

  function getActiveTileInfo(){
    function tile3857BBox(z, x, y){
      var EARTH = 20037508.342789244;
      var size = (2 * EARTH) / Math.pow(2, z);
      var minX = -EARTH + x * size;
      var maxX = -EARTH + (x + 1) * size;
      var maxY = EARTH - y * size;
      var minY = EARTH - (y + 1) * size;
      return [minX, minY, maxX, maxY];
    }
    var key = window.__activeBaseLayerKey || 'satelite';
    var groups = window.__basemapLayers;
    if(!groups || !groups[key]) return getFallbackTileInfo();
    var group = groups[key];
    /* Procura a primeira tile layer dentro do grupo */
    var tileLayer = null;
    if(group instanceof L.TileLayer){
      tileLayer = group;
    } else if(group.getLayers && typeof group.getLayers === 'function'){
      var layers = group.getLayers();
      for(var i = 0; i < layers.length; i++){
        if(layers[i] instanceof L.TileLayer){ tileLayer = layers[i]; break; }
      }
    }
    if(!tileLayer) return getFallbackTileInfo();

    var isWMS = tileLayer instanceof L.TileLayer.WMS;
    if(isWMS){
      var wmsOpts = tileLayer.options;
      var params = [];
      for(var k in wmsOpts){
        if(k === 'maxZoom' || k === 'maxNativeZoom' || k === 'minNativeZoom' ||
           k === 'attribution' || k === 'offlineKey' || k === 'transparent' ||
           k === 'format' || k === 'version' || k === 'layers') continue;
        /* passar parametros adicionais */
      }
      var baseUrl = tileLayer._url;
      var sep = baseUrl.indexOf('?') >= 0 ? '&' : '?';
      var urlTemplate = baseUrl + sep +
        'SERVICE=WMS&VERSION=' + (wmsOpts.version || '1.3.0') +
        '&REQUEST=GetMap&FORMAT=' + (wmsOpts.format || 'image/jpeg') +
        '&TRANSPARENT=' + (wmsOpts.transparent !== false ? 'TRUE' : 'FALSE') +
        '&LAYERS=' + (wmsOpts.layers || '') +
        '&CRS=EPSG:3857&WIDTH={width}&HEIGHT={height}&BBOX={bbox}';
      return {
        isWMS: true,
        urlTemplate: urlTemplate,
        bboxForTile: function(x, y, z){
          var box = tile3857BBox(z, x, y);
          return box[0] + ',' + box[1] + ',' + box[2] + ',' + box[3];
        }
      };
    }
    /* XYZ: substitui {s} por 'a' o mais cedo possivel */
    var tpl = tileLayer._url.replace('{s}', 'a');
    return { isWMS: false, urlTemplate: tpl };
  }

  function getFallbackTileInfo(){
    return {
      isWMS: false,
      urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    };
  }

  function onWorkerMessage(e){
    var msg = e.data;
    if(msg.type === 'progress'){
      $('va-progress-fill').style.width = (msg.pct || 0) + '%';
      $('va-progress-phase').textContent = msg.text || 'A processar...';
      appendLog(msg.text, 'log');
    } else if(msg.type === 'log'){
      appendLog(msg.text, msg.level || 'log');
    } else if(msg.type === 'sampleWarning'){
      /* O worker ja' escreveu os detalhes no log (nivel 'warning'); aqui so'
         reforcamos com um alerta visivel, porque isto muda a fiabilidade do
         resultado (menos amostras reais do que as que o utilizador desenhou)
         e e' facil perder uma linha de log a meio do processamento. */
      showAppAlert(
        msg.deadSamples.length + ' de ' + msg.totalSamples + ' amostra(s) nao contribuiram para o treino ' +
        '(demasiado pequenas para a grelha usada a este zoom). Ve o registo para detalhes.',
        {error:true}
      );
    } else if(msg.type === 'done'){
      $('va-progress-fill').style.width = '100%';
      $('va-progress-phase').textContent = 'Concluido!';
      appendLog('Processamento concluido.', 'log');
      vaState.geojson = msg.geojson;
      vaState.stats = msg.stats;
      setTimeout(function(){ showReview(); }, 600);
    } else if(msg.type === 'error'){
      appendLog('Erro: ' + msg.message, 'error');
      showAppAlert('Erro no processamento: ' + msg.message, {error:true});
      setTimeout(function(){ showStep(4); }, 1500);
    }
  }

  function appendLog(text, level){
    var log = $('va-progress-log');
    var line = document.createElement('div');
    line.className = 'va-progress-log-line is-' + (level || 'log');
    var ts = new Date().toTimeString().slice(0, 8);
    var tsSpan = document.createElement('span');
    tsSpan.className = 'va-progress-log-ts';
    tsSpan.textContent = ts;
    var msgSpan = document.createElement('span');
    msgSpan.className = 'va-progress-log-msg';
    msgSpan.textContent = text || '';
    line.appendChild(tsSpan);
    line.appendChild(msgSpan);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /* ---- Review ---- */
  function showReview(){
    clearReviewLayers();
    showStep(6);
    var logContent = $('va-progress-log') ? $('va-progress-log').innerHTML : '';
    var reviewLog = $('va-review-log');
    if(reviewLog) reviewLog.innerHTML = logContent;
    var features = vaState.geojson ? (vaState.geojson.features || []) : [];
    var stats = vaState.stats || {};
    $('va-review-count').textContent = stats.count || features.length;
    $('va-review-area').textContent = formatArea(stats.area || 0);
    $('va-review-confidence').textContent = (stats.avgConfidence || 0).toFixed(0) + '%';
    features.forEach(function(f, i){
      var conf = (f.properties && f.properties.confianca_pct) || 0;
      var color = conf > 80 ? '#2f7d4f' : conf > 50 ? '#c08a20' : '#b5472b';
      var layer = L.geoJSON(f, {
        style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.3 }
      }).addTo(map);
      layer._vaIndex = i;
      layer._vaEliminated = false;
      layer.on('click', function(){
        if(this._vaEliminated){
          this.setStyle({ fillOpacity: 0.3, opacity: 1 });
          this._vaEliminated = false;
        } else {
          this.setStyle({ fillOpacity: 0.08, opacity: 0.3, dashArray: '4 4' });
          this._vaEliminated = true;
        }
      });
      vaState.reviewLayers.push(layer);
    });
    if(vaState.areaBounds){
      map.fitBounds(vaState.areaBounds, { padding: [40, 40] });
    }
  }

  function clearReviewLayers(){
    vaState.reviewLayers.forEach(function(l){ map.removeLayer(l); });
    vaState.reviewLayers = [];
  }

  function clearSampleLayers(){
    vaState.samples.forEach(function(s){
      if(s.layer && map.hasLayer(s.layer)) map.removeLayer(s.layer);
    });
    vaState.samples = [];
  }

  function eliminateSelected(){
    var eliminated = 0;
    vaState.reviewLayers.forEach(function(l){
      if(l._vaEliminated){
        map.removeLayer(l);
        eliminated++;
      }
    });
    if(eliminated > 0){
      showAppAlert(eliminated + ' poligonos eliminados.');
    } else {
      showAppAlert('Nenhum poligono selecionado para eliminar. Clica num poligono no mapa primeiro.');
    }
  }

  /* ---- Criacao da camada ---- */
  function acceptAndCreateLayer(){
    var features = (vaState.geojson.features || []).filter(function(f, i){
      var layer = vaState.reviewLayers[i];
      return layer && !layer._vaEliminated;
    });
    if(features.length === 0){
      showAppAlert('Nao restam poligonos para criar a camada.');
      return;
    }
    var geojson = { type: 'FeatureCollection', features: features };
    if(typeof importGeoJSONFeatures === 'function'){
      var newLayerId = ++layerCounter;
      layers.push({
        id: newLayerId,
        name: 'Vetorizacao Assistida',
        geometryType: 'Polygon',
        mode: 'atributos',
        attributes: [],
        colorAttr: null,
        baseColor: null,
        opacity: null,
        strokeColor: null,
        strokeWidth: null,
        pointSize: null,
        symbology: typeof defaultSymbology === 'function' ? defaultSymbology() : {}
      });
      layerVisible.set(newLayerId, true);
      layerOrder.push(newLayerId);
      ensureLayerPane(newLayerId);
      importGeoJSONFeatures(geojson, function(){ return newLayerId; }, false);
      activeLayerId = newLayerId;
      if(typeof renderLayersPanel === 'function') renderLayersPanel();
    } else {
      var layer = L.geoJSON(geojson).addTo(map);
      drawnGroup.addLayer(layer);
    }
    if(vaState.areaLayer){ map.removeLayer(vaState.areaLayer); }
    clearSampleLayers();
    clearReviewLayers();
    showSummary();
    showAppAlert('Camada criada com ' + features.length + ' edificios.');
  }

  function showSummary(){
    showStep(7);
    var stats = vaState.stats || {};
    $('va-summary-count').textContent = stats.count || 0;
    $('va-summary-area').textContent = formatArea(stats.area || 0);
    $('va-summary-time').textContent = stats.time ? (stats.time / 1000).toFixed(1) + 's' : '-';
    $('va-summary-confidence').textContent = (stats.avgConfidence || 0).toFixed(0) + '%';
  }

  /* ---- pm:create handler ---- */
  function onPmCreate(e){
    if(!vaState.active) return;
    if(vaState.sampleDrawing){
      if(onSampleDrawn(e.layer)){
        drawnGroup.removeLayer(e.layer);
        return;
      }
    }
    if(vaState.step === 3 && !vaState.areaLayer){
      drawnGroup.removeLayer(e.layer);
      onAreaDrawn(e.layer);
      return;
    }
  }

  /* ---- Utilitarios ---- */
  function calcAreaM2(bounds){
    var ne = bounds.getNorthEast();
    var sw = bounds.getSouthWest();
    var latM = 111320;
    var lngM = 111320 * Math.cos((ne.lat + sw.lat) / 2 * Math.PI / 180);
    return Math.abs(ne.lat - sw.lat) * latM * Math.abs(ne.lng - sw.lng) * lngM;
  }

  /* estimateZoom era area-based (baldes por m2): quanto maior a area
     desenhada, mais baixo o zoom escolhido. Isso confundia duas coisas
     diferentes -- "quanto tempo/tiles vai demorar" e "que resolucao e'
     preciso para classificar edificios" -- e em areas grandes dava um
     zoom baixo demais para o classificador funcionar (celula do SLIC
     maior do que ruas estreitas/edificios colados, ver nota junto a
     SLIC_GRID_STEP_REF). A resolucao de classificacao NAO deve depender
     da area desenhada: decoupled agora por metros/pixel alvo (constante,
     independente da area), com a area grande a ser tratada em vez disso
     como um bloqueio explicito (ver updateAreaTooLargeWarning) em vez de
     um zoom mais baixo e silenciosamente pior. */
  var CLASSIFICATION_TARGET_MPP = 0.6;  // metros/pixel alvo (~zoom 18 a latitude de Portugal)
  var CLASSIFICATION_MIN_ZOOM = 16;
  var CLASSIFICATION_MAX_ZOOM = 19;     // acima disto os providers de tiles usados nao tem mais detalhe
  var CLASSIFICATION_MAX_TILES = 256;   // ~16x16 tiles (4096x4096px) -- limite seguro de memoria/canvas

  function estimateZoom(lat){
    var latForCalc = (typeof lat === 'number' && !isNaN(lat)) ? lat : 41; // ~latitude media de Portugal continental
    var mppAtZoom0 = 156543.03392 * Math.cos(latForCalc * Math.PI / 180);
    var z = Math.ceil(Math.log2(mppAtZoom0 / CLASSIFICATION_TARGET_MPP));
    if(z < CLASSIFICATION_MIN_ZOOM) z = CLASSIFICATION_MIN_ZOOM;
    if(z > CLASSIFICATION_MAX_ZOOM) z = CLASSIFICATION_MAX_ZOOM;
    return z;
  }

  function estimateTiles(bounds, zoom){
    var ne = bounds.getNorthEast();
    var sw = bounds.getSouthWest();
    var n = latLngToTile(ne.lat, ne.lng, zoom);
    var s = latLngToTile(sw.lat, sw.lng, zoom);
    return Math.max(1, (n.x - s.x + 1)) * Math.max(1, (n.y - s.y + 1));
  }

  function latLngToTile(lat, lng, z){
    var n = Math.pow(2, z);
    var x = Math.floor((lng + 180) / 360 * n);
    var y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    return { x: x, y: y };
  }

  function estimateTime(tiles){
    var sec = tiles * 2 + 10;
    if(sec < 60) return '~' + sec + 's';
    return '~' + Math.ceil(sec / 60) + 'min';
  }

  function formatArea(m2){
    if(m2 >= 1000000) return (m2 / 1000000).toFixed(1) + ' km2';
    if(m2 >= 10000) return (m2 / 1000).toFixed(1) + ' ha';
    return Math.round(m2).toLocaleString('pt-PT') + ' m2';
  }

  /* Injeta a UI do magic wand dinamicamente (banner + botoes + sensibilidade).
     O estilo vive agora em classes CSS (ver <style> em engenh.html, bloco
     "Vetorizacao assistida: ferramentas OSM/magic wand"), consistente com o
     resto da app -- antes tinha cores fixas inline aqui, o que destoava do
     .btn usado no resto do painel. */
  /* Injeta uma linha de estado (texto simples) por baixo do bloco de
     estimativa do passo 3, usada para reportar o progresso/resultado da
     importacao automatica de edificios OSM. Mesma logica do
     injectMagicWandUI: nao ha garantia de que o template HTML tenha este
     elemento, por isso criamo-lo por JS. */
  function injectOsmStatusUI(){
    if($('va-osm-status')) return;
    var estimate = $('va-estimate');
    if(!estimate || !estimate.parentNode) return;
    var el = document.createElement('div');
    el.id = 'va-osm-status';
    estimate.parentNode.insertBefore(el, estimate.nextSibling);
  }

  var MW_WAND_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>';

  function injectMagicWandUI(){
    if($('va-magicwand-banner')) return; // ja injetado

    var sampleBanner = $('va-sample-banner');
    var banner = document.createElement('div');
    banner.id = 'va-magicwand-banner';
    banner.className = 'va-magicwand-banner hidden';
    var text = document.createElement('span');
    text.id = 'va-magicwand-banner-text';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.addEventListener('click', cancelMagicWand);
    banner.appendChild(text);
    banner.appendChild(cancelBtn);
    if(sampleBanner && sampleBanner.parentNode){
      sampleBanner.parentNode.insertBefore(banner, sampleBanner.nextSibling);
    } else if(map && map.getContainer()){
      map.getContainer().appendChild(banner);
    }

    var negBtn = $('va-sample-btn-neg');
    var wrap = document.createElement('span');
    wrap.className = 'va-mw-toolbar';

    var mwPosBtn = document.createElement('button');
    mwPosBtn.type = 'button';
    mwPosBtn.id = 'va-magicwand-btn-pos';
    mwPosBtn.className = 'va-mw-btn pos';
    mwPosBtn.title = 'Clica sobre um edificio na imagem e o algoritmo desenha o limite automaticamente';
    mwPosBtn.innerHTML = MW_WAND_ICON_SVG + '<span>Edificio (clique)</span>';
    mwPosBtn.addEventListener('click', function(){ startMagicWand('building'); });

    var mwNegBtn = document.createElement('button');
    mwNegBtn.type = 'button';
    mwNegBtn.id = 'va-magicwand-btn-neg';
    mwNegBtn.className = 'va-mw-btn neg';
    mwNegBtn.title = 'Clica sobre uma area NAO-edificio na imagem e o algoritmo desenha o limite automaticamente';
    mwNegBtn.innerHTML = MW_WAND_ICON_SVG + '<span>Nao-edificio (clique)</span>';
    mwNegBtn.addEventListener('click', function(){ startMagicWand('non-building'); });

    var tolLabel = document.createElement('label');
    tolLabel.className = 'va-mw-field';
    tolLabel.appendChild(document.createTextNode('Sensibilidade:'));
    var tolSelect = document.createElement('select');
    tolSelect.id = 'va-magicwand-tolerance';
    ['baixa', 'media', 'alta'].forEach(function(opt){
      var o = document.createElement('option');
      o.value = opt;
      o.textContent = opt === 'baixa' ? 'Baixa' : opt === 'media' ? 'Media' : 'Alta';
      if(opt === 'media') o.selected = true;
      tolSelect.appendChild(o);
    });
    tolLabel.appendChild(tolSelect);

    var orthoLabel = document.createElement('label');
    orthoLabel.className = 'va-mw-field';
    var orthoCheckbox = document.createElement('input');
    orthoCheckbox.type = 'checkbox';
    orthoCheckbox.id = 'va-magicwand-ortho';
    orthoCheckbox.checked = true;
    orthoCheckbox.title = 'Ajusta o contorno detetado para angulos retos (90 graus), quando o formato ja e maioritariamente retangular.';
    orthoLabel.appendChild(orthoCheckbox);
    orthoLabel.appendChild(document.createTextNode('Ortogonalizar'));

    wrap.appendChild(mwPosBtn);
    wrap.appendChild(mwNegBtn);
    wrap.appendChild(tolLabel);
    wrap.appendChild(orthoLabel);

    if(negBtn && negBtn.parentNode){
      negBtn.parentNode.insertBefore(wrap, negBtn.nextSibling);
    }
  }

  /* ---- Bind events ---- */
  function bindEvents(){
    injectMagicWandUI();
    injectOsmStatusUI();

    // Comentado: o botão btn-vetassist agora é gerido pelo SAM (18-sam-segment.js)
    // $('btn-vetassist').addEventListener('click', openVetAssist);
    $('va-close-btn').addEventListener('click', closeVetAssist);
    $('va-cancel-btn').addEventListener('click', closeVetAssist);
    $('va-summary-close').addEventListener('click', closeVetAssist);
    $('va-summary-new').addEventListener('click', function(){ closeVetAssist(); openVetAssist(); });

    $('va-step1-next').addEventListener('click', function(){ showStep(2); });

    document.querySelectorAll('.va-class-card[data-va-class]').forEach(function(card){
      card.addEventListener('click', function(){ selectClass(card.dataset.vaClass); });
    });

    $('va-step2-next').addEventListener('click', function(){ showStep(3); });
    $('va-step2-back').addEventListener('click', function(){ showStep(1); });

    $('va-step3-draw').addEventListener('click', startAreaDrawing);
    $('va-draw-cancel').addEventListener('click', cancelAreaDrawing);
    $('va-step3-back').addEventListener('click', function(){ showStep(2); });
    $('va-step3-next').addEventListener('click', function(){ showStep(4); });

    $('va-sample-btn-pos').addEventListener('click', function(){ startSampleDrawing('building'); });
    $('va-sample-btn-neg').addEventListener('click', function(){ startSampleDrawing('non-building'); });
    $('va-sample-cancel').addEventListener('click', cancelSampleDrawing);
    $('va-step4-back').addEventListener('click', function(){
      cancelSampleDrawing();
      vaState.samples.forEach(function(s){ drawnGroup.removeLayer(s.layer); });
      vaState.samples = [];
      showStep(3);
    });
    $('va-step4-start').addEventListener('click', startProcessing);

    $('va-review-reject').addEventListener('click', eliminateSelected);
    $('va-review-accept').addEventListener('click', acceptAndCreateLayer);

    if(map){
      map.on('pm:create', onPmCreate);
    }
  }

  /* ---- Init ---- */
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bindEvents);
  } else {
    bindEvents();
  }

})();
