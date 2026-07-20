/* ============================================================
   VETORIZACAO ASSISTIDA — Web Worker (pipeline de processamento)
   ============================================================ */
(function(){
  'use strict';

  var MIN_SAMPLES_PER_CLASS = 3;
  var RF_N_TREES = 50;
  var RF_MAX_DEPTH = 10;
  var SLIC_GRID_STEP = 12;
  var SIMPLIFY_TOLERANCE_M = 0.4; // tolerancia Douglas-Peucker em METROS (era 0.0001 graus, dependia da latitude)

  self.onmessage = function(e){
    var msg = e.data;
    if(msg.type === 'process'){
      try {
        processArea(msg);
      } catch(err) {
        console.error('[VetAssist Worker] Error:', err);
        self.postMessage({ type: 'error', message: err.message || String(err) });
      }
    }
  };

  function postProgress(pct, text){
    self.postMessage({ type: 'progress', pct: pct, text: text });
  }

  function postLog(text, level){
    self.postMessage({ type: 'log', text: text, level: level || 'log' });
  }

  function countLabel(labels, value){
    var n = 0;
    for(var i = 0; i < labels.length; i++){ if(labels[i] === value) n++; }
    return n;
  }

  function processArea(msg){
    var bounds = msg.bounds;
    var samples = msg.samples;
    var zoom = msg.zoom || 18;
    var startTime = Date.now();

    /* Fase 1: Usar mosaico capturado do basemap (main thread) */
    postProgress(5, 'A receber imagem do basemap...');
    var mosaic = {
      width: msg.mosaicWidth,
      height: msg.mosaicHeight,
      pixelData: { data: msg.pixelData },
      bounds: msg.mosaicBounds
    };
    postLog('Mosaico recebido: ' + mosaic.width + 'x' + mosaic.height + ' px');

    /* Fase 2: Extrair features */
    postProgress(15, 'A extrair features espetrais...');
    var features = extractFeatures(mosaic);

    /* Fase 3: Segmentar superpixels (SLIC simplificado) */
    postProgress(25, 'A segmentar superpixels...');
    var superpixels = computeSuperpixels(mosaic, features);

    /* Fase 4: Preparar dados de treino */
    postProgress(35, 'A preparar dados de treino...');
    var trainData = prepareTrainingData(samples, superpixels, mosaic);
    postLog('Amostras: ' + trainData.X.length + ' (edif=' + trainData.y.filter(function(v){return v===1;}).length + ', nao-edif=' + trainData.y.filter(function(v){return v===0;}).length + ')', 'status');

    /* Fase 5: Estimar accuracy por validacao cruzada (k-fold), depois treinar
       o modelo final com TODOS os dados. Nunca avaliar no mesmo conjunto que
       treinou o modelo final -- isso infla artificialmente a accuracy (o KNN,
       por exemplo, "acerta" sempre no seu proprio ponto de treino = 100%
       falso) e desequilibra os pesos do ensemble a favor do modelo mais
       overfitted. */
    var kFolds = chooseKFolds(trainData.y);
    postLog('Validacao cruzada: ' + kFolds + '-fold', 'status');

    postProgress(40, 'A validar Random Forest (' + kFolds + '-fold)...');
    var rfAcc = crossValidateAccuracy(trainData.X, trainData.y, kFolds,
      function(X, y){ return trainRandomForest(X, y); },
      function(f, m){ return predictRF(f, m); });
    var rf = trainRandomForest(trainData.X, trainData.y);
    postLog('Random Forest: ' + rf.nTrees + ' arvores, accuracy (cv)=' + Math.round(rfAcc * 100) + '%', 'model');

    postProgress(45, 'A validar Naive Bayes (' + kFolds + '-fold)...');
    var nbAcc = crossValidateAccuracy(trainData.X, trainData.y, kFolds,
      function(X, y){ return trainNaiveBayes(X, y); },
      function(f, m){ return predictNaiveBayes(f, m); });
    var nb = trainNaiveBayes(trainData.X, trainData.y);
    postLog('Naive Bayes: accuracy (cv)=' + Math.round(nbAcc * 100) + '%', 'model');

    postProgress(50, 'A validar KNN (' + kFolds + '-fold)...');
    var knnAcc = crossValidateAccuracy(trainData.X, trainData.y, kFolds,
      function(X, y){ return trainKNN(X, y, 5); },
      function(f, m){ return predictKNN(f, m); });
    var knn = trainKNN(trainData.X, trainData.y, 5);
    postLog('KNN (k=5): accuracy (cv)=' + Math.round(knnAcc * 100) + '%', 'model');

    var models = { rf: rf, nb: nb, knn: knn, rfAccuracy: rfAcc, nbAccuracy: nbAcc, knnAccuracy: knnAcc };
    postLog('Ensemble ponderado (pesos por CV): RF=' + Math.round(rfAcc * 100) + '% NB=' + Math.round(nbAcc * 100) + '% KNN=' + Math.round(knnAcc * 100) + '%', 'status');

    /* Fase 6: Classificar todos os superpixels */
    postProgress(55, 'A classificar (ensemble)...');
    var classified = classifyAll(superpixels, models);
    var nBuildingRaw = countLabel(classified.labels, 1);
    postLog('Classificacao bruta: ' + nBuildingRaw + '/' + classified.nSuperpixels + ' superpixels como edificio', 'status');

    /* Fase 7: Limpeza morfologica */
    postProgress(65, 'A limpar ruido (abertura + fecho)...');
    var cleaned = morphologicalCleanup(classified, mosaic.width, mosaic.height);
    var nBuildingCleaned = countLabel(cleaned.labels, 1);
    postLog('Apos morfologia: ' + nBuildingCleaned + '/' + cleaned.nSuperpixels + ' superpixels como edificio', 'status');

    /* Fase 8: Raster para vetor */
    postProgress(70, 'A vetorizar poligonos...');
    var vectorData = rasterToVector(cleaned, mosaic.width, mosaic.height, mosaic.bounds);
    postLog(vectorData.length + ' poligonos brutos', 'result');

    /* Fase 8a: Clipar poligonos ao retangulo de trabalho original */
    vectorData = vectorData.map(function(p){
      return { ring: clipRingToBounds(p.ring, bounds), confidence: p.confidence };
    }).filter(function(p){ return p.ring.length >= 4; });

    /* Fase 8b: Filtrar poligonos pequenos */
    postProgress(75, 'A filtrar por area minima...');
    var latMid = (mosaic.bounds.north + mosaic.bounds.south) / 2 * Math.PI / 180;
    var cellWidthM = (mosaic.bounds.east - mosaic.bounds.west) / mosaic.width * SLIC_GRID_STEP * 111320 * Math.cos(latMid);
    var cellHeightM = (mosaic.bounds.north - mosaic.bounds.south) / mosaic.height * SLIC_GRID_STEP * 111320;
    var cellAreaM2 = cellWidthM * cellHeightM;
    var minAreaM2 = cellAreaM2 * 0.36 * 2;
    vectorData = filterByMinArea(vectorData, minAreaM2);
    postLog(vectorData.length + ' poligonos (area > ' + Math.round(minAreaM2) + ' m2)', 'result');

    /* Fase 8c: Dividir regioes grandes (edificios fundidos) */
    postProgress(77, 'A dividir regioes fundidas...');
    var MAX_BUILDING_AREA = 400;
    var beforeSplit = vectorData.length;
    vectorData = splitLargeRegions(vectorData, MAX_BUILDING_AREA);
    postLog(beforeSplit + ' -> ' + vectorData.length + ' poligonos (split)', 'result');

    /* Fase 9: Simplificar geometrias (tolerancia em metros, projetada
       localmente por poligono para nao depender da latitude) */
    postProgress(80, 'A simplificar geometrias...');
    var simplified = simplifyGeometries(vectorData, SIMPLIFY_TOLERANCE_M);
    postLog(simplified.length + ' poligonos apos simplificacao (tol=' + SIMPLIFY_TOLERANCE_M + 'm)', 'result');

    /* Fase 9b: Ortotogonalizar poligonos */
    postProgress(88, 'A ortogonalizar poligonos...');
    simplified = simplified.map(function(p){
      return { ring: orthogonalizePolygon(p.ring, p.confidence), confidence: p.confidence };
    });
    postLog('Ortogonalizacao concluida', 'result');

    /* Fase 9c: MBR orientado para poligonos ainda irregulares */
    postProgress(90, 'A aplicar bounding box orientado...');
    simplified = simplified.map(function(p){
      if(p.confidence < 0.4) return p;
      var n = p.ring.length - 1;
      if(n < 4) return p;
      var rightCount = 0;
      for(var i = 0; i < n; i++){
        var prev = p.ring[(i - 1 + n) % n];
        var cur = p.ring[i];
        var next = p.ring[(i + 1) % n];
        var dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
        var dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
        var dot = dx1 * dx2 + dy1 * dy2;
        var cross = dx1 * dy2 - dy1 * dx2;
        var angle = Math.atan2(Math.abs(cross), dot);
        if(Math.abs(angle - Math.PI / 2) < 0.5) rightCount++;
      }
      if(rightCount < Math.floor(n * 0.6)) return p;
      var mbr = orientedBoundingBox(p.ring);
      if(mbr && Math.abs(signedArea(mbr)) > 1e-14){
        return { ring: mbr, confidence: p.confidence };
      }
      return p;
    });
    postLog('MBR aplicado', 'result');

    /* Fase 10: Build GeoJSON */
    postProgress(92, 'A gerar GeoJSON...');
    var geojson = buildGeoJSON(simplified, models, superpixels);

    var elapsed = Date.now() - startTime;
    postProgress(100, 'Concluido em ' + (elapsed / 1000).toFixed(1) + 's');
    postLog(geojson.features.length + ' edificios, confianca ' + Math.round(calcAvgConfidence(geojson)) + '%, ' + (elapsed / 1000).toFixed(1) + 's', 'status');

    self.postMessage({
      type: 'done',
      geojson: geojson,
      stats: {
        count: geojson.features.length,
        area: calcTotalArea(bounds),
        time: elapsed,
        avgConfidence: calcAvgConfidence(geojson),
        models: {
          rf: Math.round(models.rfAccuracy * 100),
          nb: Math.round(models.nbAccuracy * 100),
          knn: Math.round(models.knnAccuracy * 100)
        }
      }
    });

  }

  /* ---- Feature extraction ---- */
  function extractFeatures(mosaic){
    var w = mosaic.width;
    var h = mosaic.height;
    var pixels = mosaic.pixelData.data;
    var nFeatures = 9; // +2 face a versao anterior: textureStd, edgeMag
    var features = new Float32Array(w * h * nFeatures);

    /* Passo 1: luminancia (necessaria para as features de textura) */
    var lum = new Float32Array(w * h);
    for(var i = 0; i < w * h; i++){
      var idx4 = i * 4;
      lum[i] = (0.299 * pixels[idx4] + 0.587 * pixels[idx4 + 1] + 0.114 * pixels[idx4 + 2]) / 255;
    }

    /* Passo 2: features espetrais + texturais.
       Solo lavrado/vegetacao seca e telhados de telha em Portugal tem cores
       muito parecidas (tons de laranja/castanho), por isso o classificador
       so com RGB/HSV confundia-os facilmente. As duas features novas
       ajudam a distinguir pelo PADRAO da superficie, nao so pela cor:
       - textureStd: desvio padrao local da luminancia numa janela 3x3.
         Telhados de telha tendem a ter um padrao mais regular/repetitivo;
         solo e vegetacao tendem a ter textura mais irregular/ruidosa.
       - edgeMag: magnitude do gradiente (Sobel), deteta arestas fortes
         como beirais, cumeeiras e limites de telhado, que sao mais
         nitidas e retas do que as transicoes suaves em terrenos naturais. */
    for(var py = 0; py < h; py++){
      for(var px = 0; px < w; px++){
        var i2 = py * w + px;
        var idx = i2 * 4;
        var r = pixels[idx] / 255;
        var g = pixels[idx + 1] / 255;
        var b = pixels[idx + 2] / 255;

        var hsv = rgbToHsv(r, g, b);
        var greenExcess = (g - r) / (g + r + 0.001);
        var exRed = (r - g) / (r + g + 0.001);

        var sum = 0, sumSq = 0, n = 0;
        for(var dy = -1; dy <= 1; dy++){
          for(var dx = -1; dx <= 1; dx++){
            var ny = py + dy, nx = px + dx;
            if(nx < 0) nx = 0; else if(nx >= w) nx = w - 1;
            if(ny < 0) ny = 0; else if(ny >= h) ny = h - 1;
            var lv = lum[ny * w + nx];
            sum += lv; sumSq += lv * lv; n++;
          }
        }
        var mean = sum / n;
        var variance = Math.max(0, sumSq / n - mean * mean);
        var textureStd = Math.sqrt(variance);

        var nxm1 = px > 0 ? px - 1 : 0, nxp1 = px < w - 1 ? px + 1 : w - 1;
        var nym1 = py > 0 ? py - 1 : 0, nyp1 = py < h - 1 ? py + 1 : h - 1;
        var l00 = lum[nym1 * w + nxm1], l01 = lum[nym1 * w + px], l02 = lum[nym1 * w + nxp1];
        var l10 = lum[py * w + nxm1],                              l12 = lum[py * w + nxp1];
        var l20 = lum[nyp1 * w + nxm1], l21 = lum[nyp1 * w + px], l22 = lum[nyp1 * w + nxp1];
        var sobelX = (l02 + 2 * l12 + l22) - (l00 + 2 * l10 + l20);
        var sobelY = (l20 + 2 * l21 + l22) - (l00 + 2 * l01 + l02);
        var edgeMag = Math.sqrt(sobelX * sobelX + sobelY * sobelY);

        var fIdx = i2 * nFeatures;
        features[fIdx]     = r;
        features[fIdx + 1] = g;
        features[fIdx + 2] = b;
        features[fIdx + 3] = hsv[0];
        features[fIdx + 4] = hsv[1];
        features[fIdx + 5] = greenExcess;
        features[fIdx + 6] = exRed;
        features[fIdx + 7] = textureStd;
        features[fIdx + 8] = edgeMag;
      }
    }

    return { data: features, nFeatures: nFeatures };
  }

  function rgbToHsv(r, g, b){
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var d = max - min;
    var h = 0, s = max === 0 ? 0 : d / max, v = max;
    if(d !== 0){
      if(max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if(max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h, s, v];
  }

  /* ---- SLIC superpixels (grid-based simplification) ---- */
  function computeSuperpixels(mosaic, features){
    var w = mosaic.width;
    var h = mosaic.height;
    var step = SLIC_GRID_STEP;
    var labels = new Int32Array(w * h);
    var gridCols = Math.ceil(w / step);
    var gridRows = Math.ceil(h / step);

    for(var py = 0; py < h; py++){
      for(var px = 0; px < w; px++){
        var gc = Math.min(Math.floor(px / step), gridCols - 1);
        var gr = Math.min(Math.floor(py / step), gridRows - 1);
        labels[py * w + px] = gr * gridCols + gc;
      }
    }

    var nSuperpixels = gridCols * gridRows;
    var centroidFeatures = new Float32Array(nSuperpixels * features.nFeatures);
    var centroidCount = new Float32Array(nSuperpixels);

    for(var py = 0; py < h; py++){
      for(var px = 0; px < w; px++){
        var label = labels[py * w + px];
        centroidCount[label]++;
        for(var f = 0; f < features.nFeatures; f++){
          centroidFeatures[label * features.nFeatures + f] += features.data[(py * w + px) * features.nFeatures + f];
        }
      }
    }

    for(var s = 0; s < nSuperpixels; s++){
      if(centroidCount[s] > 0){
        for(var f = 0; f < features.nFeatures; f++){
          centroidFeatures[s * features.nFeatures + f] /= centroidCount[s];
        }
      }
    }

    return {
      labels: labels,
      nSuperpixels: nSuperpixels,
      gridCols: gridCols,
      gridRows: gridRows,
      centroidFeatures: centroidFeatures,
      nFeatures: features.nFeatures
    };
  }

  /* ---- Training data preparation ---- */
  function prepareTrainingData(samples, superpixels, mosaic){
    var w = mosaic.width;
    var nFeat = superpixels.nFeatures;
    var X = [];
    var y = [];
    var labeled = {};

    samples.forEach(function(sample){
      var geom = sample.geometry;
      var label = sample.label === 'building' ? 1 : 0;
      var coords = flattenCoords(geom);

      for(var s = 0; s < superpixels.nSuperpixels; s++){
        if(labeled[s]) continue;
        var gc = s % superpixels.gridCols;
        var gr = Math.floor(s / superpixels.gridCols);
        var cx = gc * SLIC_GRID_STEP + SLIC_GRID_STEP / 2;
        var cy = gr * SLIC_GRID_STEP + SLIC_GRID_STEP / 2;

        if(pointInPixelBounds(cx, cy, coords, w, mosaic.height, mosaic.bounds)){
          labeled[s] = true;
          var feat = [];
          for(var f = 0; f < nFeat; f++){
            feat.push(superpixels.centroidFeatures[s * nFeat + f]);
          }
          X.push(feat);
          y.push(label);
        }
      }
    });

    return { X: X, y: y };
  }

  function flattenCoords(geometry){
    if(geometry.type === 'Polygon') return geometry.coordinates[0];
    if(geometry.type === 'MultiPolygon'){
      var all = [];
      geometry.coordinates.forEach(function(poly){ all = all.concat(poly[0]); });
      return all;
    }
    return [];
  }

  function pointInPixelBounds(px, py, coords, imgW, imgH, bounds){
    var lng = bounds.west + (px / imgW) * (bounds.east - bounds.west);
    var lat = bounds.north - (py / imgH) * (bounds.north - bounds.south);
    return pointInPolygon(lng, lat, coords);
  }

  function pointInPolygon(x, y, poly){
    var inside = false;
    for(var i = 0, j = poly.length - 1; i < poly.length; j = i++){
      var xi = poly[i][0], yi = poly[i][1];
      var xj = poly[j][0], yj = poly[j][1];
      if(((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)){
        inside = !inside;
      }
    }
    return inside;
  }

  /* ---- Random Forest (simplified) ---- */
  function trainRandomForest(X, y){
    if(X.length < MIN_SAMPLES_PER_CLASS * 2){
      throw new Error('Amostras insuficientes (' + X.length + '). Sao necessarias pelo menos ' + (MIN_SAMPLES_PER_CLASS * 2) + ' amostras no total.');
    }

    var nFeatures = X[0].length;
    var nFeatSubset = Math.max(1, Math.floor(Math.sqrt(nFeatures)));
    var trees = [];

    for(var t = 0; t < RF_N_TREES; t++){
      var bootX = [], bootY = [];
      for(var i = 0; i < X.length; i++){
        var idx = Math.floor(Math.random() * X.length);
        bootX.push(X[idx]);
        bootY.push(y[idx]);
      }
      var tree = buildDecisionTree(bootX, bootY, 0, nFeatSubset);
      trees.push(tree);
    }

    return { trees: trees, nTrees: trees.length };
  }

  function buildDecisionTree(X, y, depth, nFeatSubset){
    var counts = [0, 0];
    y.forEach(function(v){ counts[v]++; });
    var total = y.length;

    if(depth >= RF_MAX_DEPTH || total < 3 || counts[0] === total || counts[1] === total){
      return { leaf: true, prediction: counts[1] > counts[0] ? 1 : 0, probability: counts[1] / total };
    }

    var nFeatures = X[0].length;
    var featureIndices = [];
    for(var i = 0; i < nFeatures; i++) featureIndices.push(i);
    var subset = shuffleArray(featureIndices).slice(0, nFeatSubset);

    var bestGini = 1;
    var bestFeature = 0;
    var bestThreshold = 0;

    subset.forEach(function(fi){
      var values = X.map(function(row){ return row[fi]; });
      var sorted = values.slice().sort(function(a, b){ return a - b; });
      var step = Math.max(1, Math.floor(sorted.length / 10));
      for(var ti = 0; ti < sorted.length; ti += step){
        var threshold = sorted[ti];
        var leftY = [], rightY = [];
        for(var j = 0; j < total; j++){
          if(X[j][fi] <= threshold) leftY.push(y[j]);
          else rightY.push(y[j]);
        }
        if(leftY.length === 0 || rightY.length === 0) continue;
        var gini = giniImpurity(leftY) * leftY.length / total + giniImpurity(rightY) * rightY.length / total;
        if(gini < bestGini){
          bestGini = gini;
          bestFeature = fi;
          bestThreshold = threshold;
        }
      }
    });

    if(bestGini >= 1){
      return { leaf: true, prediction: counts[1] > counts[0] ? 1 : 0, probability: counts[1] / total };
    }

    var leftX = [], leftY = [], rightX = [], rightY = [];
    for(var j = 0; j < total; j++){
      if(X[j][bestFeature] <= bestThreshold){
        leftX.push(X[j]); leftY.push(y[j]);
      } else {
        rightX.push(X[j]); rightY.push(y[j]);
      }
    }

    return {
      leaf: false,
      feature: bestFeature,
      threshold: bestThreshold,
      left: buildDecisionTree(leftX, leftY, depth + 1, nFeatSubset),
      right: buildDecisionTree(rightX, rightY, depth + 1, nFeatSubset)
    };
  }

  function giniImpurity(arr){
    if(arr.length === 0) return 0;
    var counts = [0, 0];
    arr.forEach(function(v){ counts[v]++; });
    var total = arr.length;
    var p0 = counts[0] / total;
    var p1 = counts[1] / total;
    return 1 - p0 * p0 - p1 * p1;
  }

  function shuffleArray(arr){
    var a = arr.slice();
    for(var i = a.length - 1; i > 0; i--){
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  /* ---- Classification ---- */
  function classifyAll(superpixels, models){
    var labels = new Float32Array(superpixels.nSuperpixels);
    var confidences = new Float32Array(superpixels.nSuperpixels);
    var nFeat = superpixels.nFeatures;

    for(var s = 0; s < superpixels.nSuperpixels; s++){
      var feat = [];
      for(var f = 0; f < nFeat; f++){
        feat.push(superpixels.centroidFeatures[s * nFeat + f]);
      }
      var result = classifyEnsemble(feat, models);
      labels[s] = result.prediction;
      confidences[s] = result.probability;
    }

    return { labels: labels, confidences: confidences, nSuperpixels: superpixels.nSuperpixels, gridCols: superpixels.gridCols, gridRows: superpixels.gridRows };
  }

  function predictRF(features, rf){
    var votes = [0, 0];
    rf.trees.forEach(function(tree){
      var pred = predictTree(features, tree);
      votes[pred.prediction]++;
    });
    var total = votes[0] + votes[1];
    return { prediction: votes[1] > votes[0] ? 1 : 0, probability: votes[1] / total };
  }

  function predictTree(features, node){
    if(node.leaf) return { prediction: node.prediction, probability: node.probability };
    if(features[node.feature] <= node.threshold) return predictTree(features, node.left);
    return predictTree(features, node.right);
  }

  /* ---- Naive Bayes ---- */
  function trainNaiveBayes(X, y){
    var nFeat = X[0].length;
    var nPos = 0, nNeg = 0;
    var meanPos = new Float64Array(nFeat);
    var meanNeg = new Float64Array(nFeat);
    var varPos = new Float64Array(nFeat);
    var varNeg = new Float64Array(nFeat);

    for(var i = 0; i < X.length; i++){
      if(y[i] === 1){ nPos++; for(var f = 0; f < nFeat; f++) meanPos[f] += X[i][f]; }
      else { nNeg++; for(var f = 0; f < nFeat; f++) meanNeg[f] += X[i][f]; }
    }
    var total = nPos + nNeg;
    var priorPos = nPos / total;
    var priorNeg = nNeg / total;

    for(var f = 0; f < nFeat; f++){
      meanPos[f] /= Math.max(nPos, 1);
      meanNeg[f] /= Math.max(nNeg, 1);
    }
    for(var i = 0; i < X.length; i++){
      var f = 0, feat = X[i][f];
      if(y[i] === 1){
        for(f = 0; f < nFeat; f++){
          var d = X[i][f] - meanPos[f];
          varPos[f] += d * d;
        }
      } else {
        for(f = 0; f < nFeat; f++){
          var d = X[i][f] - meanNeg[f];
          varNeg[f] += d * d;
        }
      }
    }
    for(var f = 0; f < nFeat; f++){
      varPos[f] = Math.max(varPos[f] / Math.max(nPos - 1, 1), 1e-10);
      varNeg[f] = Math.max(varNeg[f] / Math.max(nNeg - 1, 1), 1e-10);
    }

    return { priorPos: priorPos, priorNeg: priorNeg, meanPos: meanPos, meanNeg: meanNeg, varPos: varPos, varNeg: varNeg, nFeat: nFeat };
  }

  function predictNaiveBayes(features, nb){
    var logPos = Math.log(nb.priorPos);
    var logNeg = Math.log(nb.priorNeg);
    for(var f = 0; f < nb.nFeat; f++){
      var vp = nb.varPos[f];
      var vn = nb.varNeg[f];
      var dp = features[f] - nb.meanPos[f];
      var dn = features[f] - nb.meanNeg[f];
      logPos -= 0.5 * (Math.log(2 * Math.PI * vp) + dp * dp / vp);
      logNeg -= 0.5 * (Math.log(2 * Math.PI * vn) + dn * dn / vn);
    }
    var maxLog = Math.max(logPos, logNeg);
    var pPos = Math.exp(logPos - maxLog);
    var pNeg = Math.exp(logNeg - maxLog);
    var total = pPos + pNeg;
    var prob = pPos / total;
    return { prediction: prob > 0.5 ? 1 : 0, probability: prob };
  }

  /* ---- KNN (K-Nearest Neighbors) ---- */
  function trainKNN(X, y, k){
    return { X: X, y: y, k: k || 5 };
  }

  function predictKNN(features, knn){
    var dists = [];
    for(var i = 0; i < knn.X.length; i++){
      var d = 0;
      for(var f = 0; f < features.length; f++){
        var diff = features[f] - knn.X[i][f];
        d += diff * diff;
      }
      dists.push({ dist: Math.sqrt(d), label: knn.y[i] });
    }
    dists.sort(function(a, b){ return a.dist - b.dist; });
    var k = Math.min(knn.k, dists.length);
    var votes = [0, 0];
    var totalW = 0;
    for(var i = 0; i < k; i++){
      var w = 1 / (dists[i].dist + 1e-10);
      votes[dists[i].label] += w;
      totalW += w;
    }
    var prob = totalW > 0 ? votes[1] / totalW : 0.5;
    return { prediction: prob > 0.5 ? 1 : 0, probability: prob };
  }

  /* ---- Ensemble (weighted voting) ---- */
  function classifyEnsemble(features, models){
    var rfResult = predictRF(features, models.rf);
    var nbResult = predictNaiveBayes(features, models.nb);
    var knnResult = predictKNN(features, models.knn);

    var rfW = models.rfAccuracy || 0;
    var nbW = models.nbAccuracy || 0;
    var knnW = models.knnAccuracy || 0;
    var totalW = rfW + nbW + knnW;

    var prob;
    if(totalW > 0){
      prob = (rfResult.probability * rfW + nbResult.probability * nbW + knnResult.probability * knnW) / totalW;
    } else {
      prob = rfResult.probability;
    }
    if(isNaN(prob)) prob = 0.5;
    var prediction = prob > 0.5 ? 1 : 0;

    return {
      prediction: prediction,
      probability: prob,
      rf: rfResult.probability,
      nb: nbResult.probability,
      knn: knnResult.probability
    };
  }

  function evaluateModel(X, y, predictFn){
    var correct = 0;
    for(var i = 0; i < X.length; i++){
      var result = predictFn(X[i]);
      if(result.prediction === y[i]) correct++;
    }
    return X.length > 0 ? correct / X.length : 0;
  }

  /* ---- Validacao cruzada (k-fold estratificado) ----
     Estima a capacidade de generalizacao de um modelo SEM nunca avaliar um
     fold nos mesmos dados usados para o treinar. Para cada fold: treina em
     k-1 folds, testa no fold restante; a accuracy final e a media entre
     folds. O modelo "de producao" (usado depois para classificar a imagem
     toda) e treinado a parte, com TODOS os dados -- a CV serve so para medir
     accuracy/pesos, nunca para gerar o modelo final. */
  function chooseKFolds(y){
    var counts = [0, 0];
    y.forEach(function(v){ counts[v]++; });
    var minClass = Math.min(counts[0], counts[1]);
    /* no minimo 2 folds; no maximo 5; nunca mais folds do que exemplos
       da classe minoritaria, senao havera folds sem nenhum exemplo dessa
       classe no treino */
    return Math.max(2, Math.min(5, minClass));
  }

  function stratifiedFoldAssignment(y, k){
    /* atribui a cada amostra um indice de fold (0..k-1), preservando a
       proporcao de cada classe em cada fold */
    var foldOf = new Array(y.length);
    var byClass = { 0: [], 1: [] };
    for(var i = 0; i < y.length; i++) byClass[y[i]].push(i);
    [0, 1].forEach(function(cls){
      var idxs = shuffleArray(byClass[cls]);
      for(var j = 0; j < idxs.length; j++){
        foldOf[idxs[j]] = j % k;
      }
    });
    return foldOf;
  }

  function crossValidateAccuracy(X, y, k, trainFn, predictFn){
    if(X.length < 4 || k < 2){
      /* dados demasiado escassos para particionar com fiabilidade; ainda
         assim NAO avaliamos no proprio treino -- devolvemos uma accuracy
         neutra (0.5) para que o ensemble nao sobrevalorize este modelo */
      return 0.5;
    }
    var foldOf = stratifiedFoldAssignment(y, k);
    var totalCorrect = 0, totalCount = 0;
    for(var f = 0; f < k; f++){
      var trainX = [], trainY = [], testX = [], testY = [];
      for(var i = 0; i < X.length; i++){
        if(foldOf[i] === f){ testX.push(X[i]); testY.push(y[i]); }
        else { trainX.push(X[i]); trainY.push(y[i]); }
      }
      if(testX.length === 0 || trainX.length === 0) continue;
      /* se o fold de treino ficou sem uma das classes, salta este fold
         (nao ha como treinar um classificador binario sem as duas) */
      var hasPos = trainY.indexOf(1) !== -1, hasNeg = trainY.indexOf(0) !== -1;
      if(!hasPos || !hasNeg) continue;
      var model = trainFn(trainX, trainY);
      for(var j = 0; j < testX.length; j++){
        var result = predictFn(testX[j], model);
        if(result.prediction === testY[j]) totalCorrect++;
        totalCount++;
      }
    }
    return totalCount > 0 ? totalCorrect / totalCount : 0.5;
  }

  /* ---- Morphological cleanup ---- */
  function morphologicalCleanup(classified, w, h){
    var labels = classified.labels;
    var step = SLIC_GRID_STEP;
    var gridCols = classified.gridCols;
    var gridRows = classified.gridRows;

    var grid = new Float32Array(gridCols * gridRows);
    for(var s = 0; s < classified.nSuperpixels; s++){
      grid[s] = labels[s];
    }

    /* Antes: 2 erosoes + 1 dilatacao + 2 fechos = liquido de 1 erosao "a
       mais" sem dilatacao correspondente, o que encolhia sistematicamente
       todas as regioes e apagava edificios pequenos.
       Agora: 1 abertura (erode+dilate, remove ruido isolado sem encolher
       liquido) + 1 fecho (dilate+erode, preenche pequenos buracos), que e
       o par classico e equilibrado para limpeza morfologica binaria. */
    var cleaned = grid;
    cleaned = morphologyOpening(cleaned, gridCols, gridRows);
    cleaned = morphologyClose(cleaned, gridCols, gridRows);

    var finalLabels = new Float32Array(classified.nSuperpixels);
    for(var s = 0; s < classified.nSuperpixels; s++){
      finalLabels[s] = cleaned[s];
    }

    classified.labels = finalLabels;
    return classified;
  }

  function morphologyOpening(grid, cols, rows){
    var eroded = morphologyErode(grid, cols, rows);
    return morphologyDilate(eroded, cols, rows);
  }

  function morphologyErode(grid, cols, rows){
    var result = new Float32Array(cols * rows);
    for(var r = 0; r < rows; r++){
      for(var c = 0; c < cols; c++){
        var val = grid[r * cols + c];
        var minVal = val;
        for(var dr = -1; dr <= 1; dr++){
          for(var dc = -1; dc <= 1; dc++){
            var nr = r + dr, nc = c + dc;
            if(nr >= 0 && nr < rows && nc >= 0 && nc < cols){
              minVal = Math.min(minVal, grid[nr * cols + nc]);
            }
          }
        }
        result[r * cols + c] = minVal;
      }
    }
    return result;
  }

  function morphologyDilate(grid, cols, rows){
    var result = new Float32Array(cols * rows);
    for(var r = 0; r < rows; r++){
      for(var c = 0; c < cols; c++){
        var val = grid[r * cols + c];
        var maxVal = val;
        for(var dr = -1; dr <= 1; dr++){
          for(var dc = -1; dc <= 1; dc++){
            var nr = r + dr, nc = c + dc;
            if(nr >= 0 && nr < rows && nc >= 0 && nc < cols){
              maxVal = Math.max(maxVal, grid[nr * cols + nc]);
            }
          }
        }
        result[r * cols + c] = maxVal;
      }
    }
    return result;
  }

  function morphologyClose(grid, cols, rows){
    var dilated = morphologyDilate(grid, cols, rows);
    return morphologyErode(dilated, cols, rows);
  }

  /* ---- Raster to vector (simplified marching squares) ---- */
  function rasterToVector(classified, w, h, bounds){
    var step = SLIC_GRID_STEP;
    var gridCols = classified.gridCols;
    var gridRows = classified.gridRows;
    var grid = classified.labels;

    var polygons = [];
    var visited = new Uint8Array(gridCols * gridRows);

    for(var r = 0; r < gridRows; r++){
      for(var c = 0; c < gridCols; c++){
        var idx = r * gridCols + c;
        if(grid[idx] === 1 && !visited[idx]){
          var region = [];
          var queue = [idx];
          visited[idx] = 1;
          while(queue.length > 0){
            var cur = queue.shift();
            var cr = Math.floor(cur / gridCols);
            var cc = cur % gridCols;
            region.push(cur);

            var neighbors = [
              [cr-1, cc], [cr+1, cc], [cr, cc-1], [cr, cc+1]
            ];
            for(var n = 0; n < neighbors.length; n++){
              var nr = neighbors[n][0], nc = neighbors[n][1];
              if(nr >= 0 && nr < gridRows && nc >= 0 && nc < gridCols){
                var ni = nr * gridCols + nc;
                if(grid[ni] === 1 && !visited[ni]){
                  visited[ni] = 1;
                  queue.push(ni);
                }
              }
            }
          }

          var ring = regionToRing(region, gridCols, gridRows, step, bounds, w, h);
          if(ring.length >= 4){
            polygons.push({ ring: ring, confidence: avgConfidence(region, classified.confidences) });
          }
        }
      }
    }

    return polygons;
  }

  /* Contorno robusto por arestas DIRECIONADAS.
     O bug anterior usava um grafo de arestas NAO-direcionado: quando duas
     celulas da mesma regiao se tocavam so por um canto (comum com
     classificacao ruidosa celula-a-celula), o vertice desse canto tinha
     grau 4 e a heuristica de "vira mais a esquerda" nao tinha informacao
     suficiente para saber a que "loop" cada aresta pertencia -- por vezes
     saltava para o lobo errado da forma, criando os poligonos gigantes em
     diagonal que atravessavam a imagem toda.
     A correcao: cada celula gera as suas arestas de fronteira sempre no
     mesmo sentido horario (area preenchida fica sempre a direita de quem
     percorre a aresta na sua direcao). Isto e informacao LOCAL e inequivoca
     por aresta, por isso mesmo em vertices de grau 4 sabemos sempre a que
     lobo cada aresta pertence -- so falta escolher, em caso de ambiguidade
     no vertice de chegada, uma regra de desempate consistente (preferir a
     curva mais "a direita" disponivel). Isto separa corretamente os lobos
     que se tocam num unico ponto em vez de saltar entre eles. */
  function buildDirectedBoundaryEdges(region, gridCols, gridRows){
    var cellSet = {};
    region.forEach(function(idx){ cellSet[idx] = 1; });
    var edges = [];
    region.forEach(function(idx){
      var c = idx % gridCols;
      var r = Math.floor(idx / gridCols);
      var hasTop    = r > 0 && cellSet[(r-1) * gridCols + c];
      var hasBottom = r < gridRows - 1 && cellSet[(r+1) * gridCols + c];
      var hasLeft   = c > 0 && cellSet[r * gridCols + (c-1)];
      var hasRight  = c < gridCols - 1 && cellSet[r * gridCols + (c+1)];
      /* cantos da celula: TL=(c,r) TR=(c+1,r) BR=(c+1,r+1) BL=(c,r+1);
         percorridos sempre TL->TR->BR->BL->TL (sentido horario em
         coordenadas de imagem, y para baixo) quando o lado correspondente
         e fronteira (sem vizinho preenchido nesse lado) */
      if(!hasTop)    edges.push([[c, r], [c + 1, r]]);         // TL -> TR
      if(!hasRight)  edges.push([[c + 1, r], [c + 1, r + 1]]); // TR -> BR
      if(!hasBottom) edges.push([[c + 1, r + 1], [c, r + 1]]); // BR -> BL
      if(!hasLeft)   edges.push([[c, r + 1], [c, r]]);          // BL -> TL
    });
    return edges;
  }

  function edgeDir(edge){
    return [edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]];
  }

  /* Prioridade de escolha quando ha mais que uma aresta disponivel a partir
     do vertice de chegada: curva a direita (mantem-se a "abraçar" o mesmo
     lobo) > seguir em frente > curva a esquerda > inverter (ultimo recurso).
     Como as direcoes sao sempre axiais (0/90/180/270), dot/cross bastam
     para classificar a curva sem ambiguidade. */
  function turnPriority(dirIn, dirOut){
    var dot = dirIn[0] * dirOut[0] + dirIn[1] * dirOut[1];
    var cross = dirIn[0] * dirOut[1] - dirIn[1] * dirOut[0];
    if(cross > 0.5) return 0;  // curva a direita (sentido horario)
    if(dot > 0.5) return 1;    // segue em frente
    if(cross < -0.5) return 2; // curva a esquerda
    return 3;                  // inverte (nunca deveria acontecer num contorno valido)
  }

  /* Traca TODOS os loops fechados presentes no conjunto de arestas
     direcionadas (o contorno exterior e, se existirem, buracos). Devolve
     uma lista de aneis [c,r] fechados. */
  function traceDirectedLoops(edges){
    var vKey = function(v){ return v[0] + ',' + v[1]; };
    var entries = edges.map(function(e){ return { edge: e, used: false }; });
    var byStart = {};
    entries.forEach(function(en){
      var k = vKey(en.edge[0]);
      if(!byStart[k]) byStart[k] = [];
      byStart[k].push(en);
    });

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
        if(!candidates){ break; }
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
    return loops;
  }

  function regionToRing(region, gridCols, gridRows, step, bounds, mosaicW, mosaicH){
    var edges = buildDirectedBoundaryEdges(region, gridCols, gridRows);
    if(edges.length < 3) return [];

    var loops = traceDirectedLoops(edges);
    if(loops.length === 0) return [];

    /* Uma regiao pode produzir mais do que um loop (contorno exterior +
       eventuais buracos, ou lobos que so se tocam num ponto). Para
       edificios interessa-nos o contorno exterior: o de maior area
       absoluta. Loops mais pequenos (ex: buracos, lobos residuais) sao
       descartados aqui -- ja eram ignorados antes, so que de forma
       acidental (o traçado antigo simplesmente saltava para eles). */
    var bestRing = null, bestArea = -1;
    for(var i = 0; i < loops.length; i++){
      var area = Math.abs(signedArea(loops[i]));
      if(area > bestArea){ bestArea = area; bestRing = loops[i]; }
    }
    if(!bestRing) return [];

    var coords = bestRing.map(function(v){
      return cellToCoord(v[0], v[1], bounds, mosaicW, mosaicH);
    });
    coords.push(coords[0].slice());

    coords = removeConsecutiveDuplicates(coords);
    if(coords.length < 4) return [];
    if(!isRingClosed(coords)) coords.push(coords[0].slice());

    return coords;
  }

  function removeConsecutiveDuplicates(coords){
    if(coords.length === 0) return coords;
    var result = [coords[0]];
    for(var i = 1; i < coords.length; i++){
      var prev = result[result.length - 1];
      if(Math.abs(coords[i][0] - prev[0]) > 1e-12 || Math.abs(coords[i][1] - prev[1]) > 1e-12){
        result.push(coords[i]);
      }
    }
    return result;
  }

  function isRingClosed(coords){
    if(coords.length < 2) return false;
    var first = coords[0];
    var last = coords[coords.length - 1];
    return Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12;
  }

  function filterByMinArea(polygons, minAreaM2){
    return polygons.filter(function(p){
      return calcRingAreaM2(p.ring) >= minAreaM2;
    });
  }

  function splitLargeRegions(polygons, maxAreaM2){
    var result = [];
    var MAX_SPLIT_DEPTH = 6; // seguranca contra recursao infinita
    for(var i = 0; i < polygons.length; i++){
      var p = polygons[i];
      splitRegionRecursive(p.ring, p.confidence, maxAreaM2, 0, MAX_SPLIT_DEPTH, result);
    }
    return result;
  }

  // Divide uma regiao e volta a testar cada parte resultante contra o
  // limite de area, repetindo ate a regiao caber no limite, nao ser mais
  // divisivel (splitByConcavity devolve o proprio anel sem alteracoes) ou
  // atingir a profundidade maxima de seguranca.
  function splitRegionRecursive(ring, confidence, maxAreaM2, depth, maxDepth, result){
    var area = calcRingAreaM2(ring);
    if(area <= maxAreaM2 || ring.length < 6 || depth >= maxDepth){
      if(area >= 5){
        result.push({ ring: ring, confidence: confidence });
      }
      return;
    }

    var splits = splitByConcavity(ring, maxAreaM2);

    // splitByConcavity nao conseguiu dividir (devolveu o mesmo anel) -
    // parar aqui para evitar loop infinito
    if(splits.length <= 1){
      if(area >= 5){
        result.push({ ring: ring, confidence: confidence });
      }
      return;
    }

    for(var s = 0; s < splits.length; s++){
      splitRegionRecursive(splits[s], confidence, maxAreaM2, depth + 1, maxDepth, result);
    }
  }

  function splitByConcavity(ring, maxAreaM2){
    var n = ring.length - 1;
    if(n < 6) return [ring];

    var cx = 0, cy = 0;
    for(var i = 0; i < n; i++){ cx += ring[i][0]; cy += ring[i][1]; }
    cx /= n; cy /= n;

    var hull = convexHull(ring);
    var hullArea = Math.abs(signedArea(hull));

    if(hullArea < 1e-14) return [ring];

    var solidity = Math.abs(signedArea(ring)) / hullArea;

    if(solidity > 0.75){
      var dx = 0, dy = 0;
      for(var i = 0; i < n; i++){
        dx += Math.abs(ring[i][0] - cx);
        dy += Math.abs(ring[i][1] - cy);
      }
      dx /= n; dy /= n;

      if(dx > dy * 1.5){
        return splitAlongAxis(ring, cx, cy, 0);
      } else if(dy > dx * 1.5){
        return splitAlongAxis(ring, cx, cy, 1);
      }
      return [ring];
    }

    var maxDepth = 0;
    var splitIdx = -1;
    var hullSet = {};
    for(var i = 0; i < hull.length - 1; i++){
      hullSet[hull[i][0] + ',' + hull[i][1]] = 1;
    }

    for(var i = 0; i < n; i++){
      if(hullSet[ring[i][0] + ',' + ring[i][1]]) continue;
      var dx = ring[i][0] - cx;
      var dy = ring[i][1] - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if(dist > maxDepth){
        maxDepth = dist;
        splitIdx = i;
      }
    }

    if(splitIdx < 0 || maxDepth < 0.00002) return [ring];

    var perpDx = -(ring[splitIdx][1] - cy);
    var perpDy = ring[splitIdx][0] - cx;
    var perpLen = Math.sqrt(perpDx * perpDx + perpDy * perpDy);
    if(perpLen < 1e-14) return [ring];
    perpDx /= perpLen; perpDy /= perpLen;

    return splitAlongDirection(ring, cx, cy, perpDx, perpDy);
  }

  function splitAlongAxis(ring, cx, cy, axis){
    var n = ring.length - 1;
    var minVal = Infinity, maxVal = -Infinity;
    for(var i = 0; i < n; i++){
      var v = axis === 0 ? ring[i][0] : ring[i][1];
      if(v < minVal) minVal = v;
      if(v > maxVal) maxVal = v;
    }

    var bestSplit = cx;
    var bestScore = -1;
    var steps = 10;
    for(var s = 1; s < steps; s++){
      var t = s / steps;
      var splitVal = minVal + t * (maxVal - minVal);
      var leftCount = 0, rightCount = 0;
      var leftSum = 0, rightSum = 0;
      for(var i = 0; i < n; i++){
        var v = axis === 0 ? ring[i][0] : ring[i][1];
        var d = v - splitVal;
        var w = Math.abs(ring[(i+1)%n][axis === 0 ? 0 : 1] - ring[i][axis === 0 ? 0 : 1]);
        if(d < 0){ leftCount++; leftSum += w; }
        else { rightCount++; rightSum += w; }
      }
      if(leftCount > 0 && rightCount > 0){
        var ratio = Math.min(leftSum, rightSum) / Math.max(leftSum, rightSum);
        if(ratio > bestScore){
          bestScore = ratio;
          bestSplit = splitVal;
        }
      }
    }

    if(bestScore < 0.15) return [ring];

    if(axis === 0){
      return splitAlongDirection(ring, cx, cy, 1, 0);
    }
    return splitAlongDirection(ring, cx, cy, 0, 1);
  }

  function splitAlongDirection(ring, cx, cy, dirX, dirY){
    var n = ring.length - 1;
    var projections = [];
    for(var i = 0; i < n; i++){
      var dx = ring[i][0] - cx;
      var dy = ring[i][1] - cy;
      projections.push({ idx: i, proj: dx * dirX + dy * dirY });
    }

    projections.sort(function(a, b){ return a.proj - b.proj; });

    var bestIdx = -1;
    var bestWaist = Infinity;
    var mid = n / 2;
    var searchRange = Math.max(2, Math.floor(n * 0.3));

    for(var s = Math.floor(mid) - searchRange; s <= Math.ceil(mid) + searchRange; s++){
      if(s < 1 || s >= n - 1) continue;
      var splitProj = projections[s].proj;

      var leftCount = 0, rightCount = 0;
      for(var i = 0; i < n; i++){
        var dx = ring[i][0] - cx;
        var dy = ring[i][1] - cy;
        var proj = dx * dirX + dy * dirY;
        if(proj < splitProj) leftCount++;
        else rightCount++;
      }

      if(leftCount < 2 || rightCount < 2) continue;

      var perpX = -dirY, perpY = dirX;
      var minPerp = Infinity, maxPerp = -Infinity;
      for(var i = 0; i < n; i++){
        var dx = ring[i][0] - cx;
        var dy = ring[i][1] - cy;
        var perp = dx * perpX + dy * perpY;
        var proj = dx * dirX + dy * dirY;
        var nearSplit = Math.abs(proj - splitProj);
        if(nearSplit < 0.00005){
          if(perp < minPerp) minPerp = perp;
          if(perp > maxPerp) maxPerp = perp;
        }
      }

      var waist = (maxPerp - minPerp);
      if(waist < bestWaist && leftCount >= 2 && rightCount >= 2){
        bestWaist = waist;
        bestIdx = s;
      }
    }

    if(bestIdx < 0) return [ring];

    var splitProj = projections[bestIdx].proj;
    var splitPoint = [cx + dirX * splitProj, cy + dirY * splitProj];

    var perpX = -dirY, perpY = dirX;
    var minPerp = 0, maxPerp = 0;
    for(var i = 0; i < n; i++){
      var dx = ring[i][0] - cx;
      var dy = ring[i][1] - cy;
      var proj = dx * dirX + dy * dirY;
      var perp = dx * perpX + dy * perpY;
      var nearSplit = Math.abs(proj - splitProj);
      if(nearSplit < 0.00005){
        if(perp < minPerp) minPerp = perp;
        if(perp > maxPerp) maxPerp = perp;
      }
    }

    var p1 = [splitPoint[0] + perpX * minPerp, splitPoint[1] + perpY * minPerp];
    var p2 = [splitPoint[0] + perpX * maxPerp, splitPoint[1] + perpY * maxPerp];

    var leftPoly = [];
    var rightPoly = [];

    for(var i = 0; i < n; i++){
      var dx = ring[i][0] - cx;
      var dy = ring[i][1] - cy;
      var proj = dx * dirX + dy * dirY;
      if(proj <= splitProj){
        leftPoly.push(ring[i]);
      } else {
        rightPoly.push(ring[i]);
      }
    }

    leftPoly.push(p2);
    leftPoly.push(p1);
    leftPoly.push(leftPoly[0].slice());

    rightPoly.push(p1);
    rightPoly.push(p2);
    rightPoly.push(rightPoly[0].slice());

    var results = [];
    if(leftPoly.length >= 4) results.push(leftPoly);
    if(rightPoly.length >= 4) results.push(rightPoly);

    return results.length > 0 ? results : [ring];
  }

  function orthogonalizePolygon(ring, confidence){
    if(confidence < 0.4) return ring;
    if(ring.length < 5) return ring;

    var n = ring.length - 1;

    var origArea = Math.abs(signedArea(ring));
    if(origArea < 1e-14) return ring;

    var origCx = 0, origCy = 0;
    for(var i = 0; i < n; i++){ origCx += ring[i][0]; origCy += ring[i][1]; }
    origCx /= n; origCy /= n;

    var angles = [];
    for(var i = 0; i < n; i++){
      var prev = ring[(i - 1 + n) % n];
      var cur = ring[i];
      var next = ring[(i + 1) % n];
      var dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
      var dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
      var dot = dx1 * dx2 + dy1 * dy2;
      var cross = dx1 * dy2 - dy1 * dx2;
      var angle = Math.atan2(Math.abs(cross), dot);
      angles.push(angle);
    }

    var rightAngles = 0;
    for(var i = 0; i < angles.length; i++){
      if(Math.abs(angles[i] - Math.PI / 2) < 0.5) rightAngles++;
    }

    if(rightAngles < Math.floor(n * 0.3)) return ring;

    var result = ring.slice();
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
        if(len1 < 1e-14 || len2 < 1e-14) continue;

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

    var newArea = Math.abs(signedArea(result));
    if(newArea > 1e-14){
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

  function signedArea(ring){
    var a = 0;
    var n = ring.length - 1;
    for(var i = 0; i < n; i++){
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return a / 2;
  }

  function cellToCoord(c, r, bounds, mosaicW, mosaicH){
    var px = Math.min(c * SLIC_GRID_STEP, mosaicW);
    var py = Math.min(r * SLIC_GRID_STEP, mosaicH);
    var lng = bounds.west + (px / mosaicW) * (bounds.east - bounds.west);
    var lat = bounds.north - (py / mosaicH) * (bounds.north - bounds.south);
    return [lng, lat];
  }

  function avgConfidence(region, confidences){
    var sum = 0;
    region.forEach(function(idx){ var v = confidences[idx]; if(!isNaN(v)) sum += v; });
    return region.length > 0 ? sum / region.length : 0;
  }

  /* ---- Simplify (Douglas-Peucker com tolerancia em METROS) ----
     O ring esta em graus (lng,lat), onde 1 grau de longitude NAO tem o
     mesmo comprimento em metros que 1 grau de latitude (varia com
     cos(lat)). Por isso, cada poligono e projetado para um plano local
     em metros (equirectangular, centrado no proprio poligono) antes de
     simplificar, e depois reprojetado de volta para graus. Assim a
     tolerancia passa a ser uma distancia real e constante em metros,
     em vez de um valor arbitrario em graus que dependia da latitude e
     que apagava edificios pequenos ou os transformava em triangulos. */
  function simplifyGeometries(polygons, toleranceMeters){
    return polygons.map(function(p){
      if(!p.ring || p.ring.length < 4) return null;

      var proj = projectRingToLocalMeters(p.ring);

      var simplifiedM = douglasPeucker(proj.points, toleranceMeters);
      if(simplifiedM.length < 4){
        /* Se ficou degenerado, usa uma tolerancia MENOR (mais conservadora)
           para preservar mais vertices -- nunca uma maior, que so pioraria. */
        simplifiedM = douglasPeucker(proj.points, toleranceMeters * 0.25);
      }
      if(simplifiedM.length < 4) return null;

      var simplified = unprojectFromLocalMeters(simplifiedM, proj);
      return { ring: simplified, confidence: p.confidence };
    }).filter(function(p){ return p !== null && p.ring.length >= 4; });
  }

  /* Projeta um ring [lng,lat] para um plano local em metros (x=leste, y=norte),
     usando a latitude media do ring para o fator de escala este-oeste. */
  function projectRingToLocalMeters(ring){
    var n = ring.length - 1;
    var latSum = 0;
    for(var i = 0; i < n; i++){ latSum += ring[i][1]; }
    var latRef = latSum / n;
    var lngRef = ring[0][0];
    var mPerDegLat = 111320;
    var mPerDegLng = 111320 * Math.cos(latRef * Math.PI / 180);
    var points = ring.map(function(pt){
      return [(pt[0] - lngRef) * mPerDegLng, (pt[1] - latRef) * mPerDegLat];
    });
    return { points: points, lngRef: lngRef, latRef: latRef, mPerDegLng: mPerDegLng, mPerDegLat: mPerDegLat };
  }

  function unprojectFromLocalMeters(points, proj){
    return points.map(function(pt){
      return [pt[0] / proj.mPerDegLng + proj.lngRef, pt[1] / proj.mPerDegLat + proj.latRef];
    });
  }

  function convexHull(points){
    var n = points.length - 1;
    if(n < 3) return points.slice();
    var pts = points.slice(0, n).slice();
    pts.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1]; });
    var cross = function(O, A, B){
      return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
    };
    var lower = [];
    for(var i = 0; i < pts.length; i++){
      while(lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) < 0){
        lower.pop();
      }
      lower.push(pts[i]);
    }
    var upper = [];
    for(var i = pts.length - 1; i >= 0; i--){
      while(upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) < 0){
        upper.pop();
      }
      upper.push(pts[i]);
    }
    lower.pop();
    upper.pop();
    var hull = lower.concat(upper);
    hull.push(hull[0].slice());
    return hull;
  }

  function orientedBoundingBox(ring){
    var n = ring.length - 1;
    if(n < 3) return null;

    var cx = 0, cy = 0;
    for(var i = 0; i < n; i++){ cx += ring[i][0]; cy += ring[i][1]; }
    cx /= n; cy /= n;

    var cxx = 0, cyy = 0, cxy = 0;
    for(var i = 0; i < n; i++){
      var dx = ring[i][0] - cx;
      var dy = ring[i][1] - cy;
      cxx += dx * dx;
      cyy += dy * dy;
      cxy += dx * dy;
    }

    var theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    var cosT = Math.cos(theta);
    var sinT = Math.sin(theta);

    var minX = Infinity, maxX = -Infinity;
    var minY = Infinity, maxY = -Infinity;
    for(var i = 0; i < n; i++){
      var dx = ring[i][0] - cx;
      var dy = ring[i][1] - cy;
      var rx = dx * cosT + dy * sinT;
      var ry = -dx * sinT + dy * cosT;
      if(rx < minX) minX = rx;
      if(rx > maxX) maxX = rx;
      if(ry < minY) minY = ry;
      if(ry > maxY) maxY = ry;
    }

    var corners = [
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]
    ];

    var result = corners.map(function(p){
      return [
        cx + p[0] * cosT - p[1] * sinT,
        cy + p[0] * sinT + p[1] * cosT
      ];
    });
    result.push(result[0].slice());
    return result;
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

  /* ---- Build GeoJSON ---- */
  function buildGeoJSON(polygons, models, superpixels){
    var features = polygons.map(function(p, i){
      var coords = p.ring.map(function(pt){
        return [pt[0], pt[1]];
      });
      if(signedArea(coords) < 0){
        coords = coords.reverse();
      }
      return {
        type: 'Feature',
        properties: {
          id: i + 1,
          classe: 'Edificio',
          confianca_pct: Math.round((isNaN(p.confidence) ? 0.5 : p.confidence) * 100),
          area_m2: calcRingAreaM2(coords),
          perimetro_m: calcRingPerimeterM(coords),
          data_processamento: new Date().toISOString(),
          modelo: 'Ensemble (RF+' + models.rf.nTrees + 'a NB KNN)'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [coords]
        }
      };
    });
    return { type: 'FeatureCollection', features: features };
  }

  function calcRingAreaM2(coords){
    var area = 0;
    var n = coords.length - 1;
    for(var i = 0; i < n; i++){
      area += coords[i][0] * coords[i + 1][1] - coords[i + 1][0] * coords[i][1];
    }
    return Math.abs(area / 2) * 111320 * 111320 * Math.cos(coords[0][1] * Math.PI / 180);
  }

  function calcRingPerimeterM(coords){
    var perim = 0;
    for(var i = 0; i < coords.length - 1; i++){
      var dx = (coords[i + 1][0] - coords[i][0]) * 111320 * Math.cos(coords[i][1] * Math.PI / 180);
      var dy = (coords[i + 1][1] - coords[i][1]) * 111320;
      perim += Math.sqrt(dx * dx + dy * dy);
    }
    return perim;
  }

  /* ---- Helpers ---- */
  function calcTotalArea(bounds){
    var latM = 111320;
    var lngM = 111320 * Math.cos((bounds.north + bounds.south) / 2 * Math.PI / 180);
    return Math.abs(bounds.north - bounds.south) * latM * Math.abs(bounds.east - bounds.west) * lngM;
  }

  function calcAvgConfidence(geojson){
    if(!geojson.features || geojson.features.length === 0) return 0;
    var sum = 0;
    geojson.features.forEach(function(f){ sum += (f.properties.confianca_pct || 0); });
    return sum / geojson.features.length;
  }

  /* Sutherland-Hodgman: interseta um poligono convexo (ring fechado) com o
     retangulo bounds. Usado para garantir que poligonos nao extravasam a
     area de trabalho desenhada pelo utilizador. */
  function clipRingToBounds(ring, bounds){
    var west = bounds.west, east = bounds.east;
    var south = bounds.south, north = bounds.north;
    var output = ring.slice(0, ring.length - 1);
    var edges = [
      function(p){ return p[0] - west; },  // left
      function(p){ return east - p[0]; },  // right
      function(p){ return p[1] - south; }, // bottom
      function(p){ return north - p[1]; }  // top
    ];
    for(var e = 0; e < edges.length; e++){
      if(output.length === 0) return [];
      var input = output;
      output = [];
      for(var i = 0; i < input.length; i++){
        var cur = input[i];
        var prev = input[(i - 1 + input.length) % input.length];
        var curInside = edges[e](cur) >= 0;
        var prevInside = edges[e](prev) >= 0;
        if(curInside){
          if(!prevInside){
            var t = edges[e](prev) / (edges[e](prev) - edges[e](cur));
            output.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
          }
          output.push(cur);
        } else if(prevInside){
          var t = edges[e](prev) / (edges[e](prev) - edges[e](cur));
          output.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
        }
      }
    }
    if(output.length < 3) return [];
    output.push(output[0].slice());
    return output;
  }

})();
