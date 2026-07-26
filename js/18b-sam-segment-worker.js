/* FeatherGIS — Segment Anything (SAM) — Web Worker
   ============================================================
   Corre o encoder/decoder ONNX (onnxruntime-web) FORA da thread principal.
   ANTES (18-sam-segment.js, versao antiga): tudo -- captura, encoder.run,
   decoder.run, limpeza morfologica, tracado de contorno -- corria na main
   thread. O encoder/decoder de um ViT-B a 1024x1024 e' pesado (centenas de
   ms a segundos por chamada), e como JS e' single-threaded na main thread,
   o browser ficava completamente irresponsivo durante esse tempo (sem
   repintar, sem reagir a cliques, nada). AGORA esse trabalho pesado corre
   aqui, numa thread dedicada -- a main thread so' espera pela resposta via
   postMessage, ficando sempre livre para pintar e reagir.

   Protocolo de mensagens (ver 18-sam-segment.js, funcao callWorker):
     recebidas (self.onmessage):
       { type:'loadModels' }
         -> pre-carrega os modelos em background (fire-and-forget).
       { type:'encodeView', reqId, bitmap, w, h, zoom }
         -> corre o encoder sobre a vista inteira, guarda o embedding em
            cache local (VIEW_CACHE) e devolve so' um "ok" (os embeddings
            NUNCA saem daqui -- ficam residentes no worker, o que tambem
            poupa memoria/copias na main thread).
       { type:'decodeClick', reqId, x, y }
         -> corre so' o decoder sobre o VIEW_CACHE existente, devolve o
            contorno (em pixels do espaco do CANVAS capturado, nao lat/lng
            -- o worker nao sabe nada de Leaflet/bounds, isso fica para a
            main thread converter).
       { type:'invalidateView' }
         -> limpa o VIEW_CACHE (chamado pela main thread quando o mapa se
            mexe ou o modo SAM e' desativado).
     enviadas (self.postMessage):
       { type:'log', text, level }       -- espelhado no __console da UI
       { type:'progress', text }         -- progresso do download dos modelos
       { type:'modelsLoaded' }
       { type:'result', reqId, kind, ... }
       { type:'error', reqId, message }
   ============================================================ */
importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js');

/* IMPORTANTE: dentro de um Worker carregado via importScripts(), o ort.min.js
   nao consegue auto-detetar de onde foi carregado, e por defeito tenta ir
   buscar os ficheiros .wasm/.mjs auxiliares relativos a' propria pagina
   (ex.: http://localhost:8000/js/ort-wasm-simd-threaded.jsep.mjs), onde eles
   nao existem -- so' existem no CDN. Por isso tem de se apontar explicitamente
   para a mesma pasta de onde o ort.min.js veio. Isto tem de ser feito ANTES
   de qualquer ort.InferenceSession.create(). */
self.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

(function(){
  'use strict';

  // ========== CONFIG (identico ao que estava em 18-sam-segment.js) ==========
  var ENCODER_URL = 'https://huggingface.co/Xenova/sam-vit-base/resolve/main/onnx/vision_encoder_quantized.onnx';
  var DECODER_URL = 'https://huggingface.co/Xenova/sam-vit-base/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx';
  var SAM_IMAGE_SIZE = 1024;
  var SAM_PIXEL_MEAN = [123.675, 116.28, 103.53];
  var SAM_PIXEL_STD = [58.395, 57.12, 57.375];
  var SAM_CACHE_NAME = 'feathergis-sam-models-v1';

  var MODELS = {};
  var LOADED = false;
  var LOADING = false;
  var ENCODER_LAYOUT = 'nchw'; // ajustado automaticamente se o modelo esperar NHWC

  /* Cache do embedding da vista atual -- vive so' aqui no worker (nunca
     volta para a main thread). Um unico slot: so' interessa a vista mais
     recente, tal como o EMBED_CACHE que existia antes na main thread. */
  var VIEW_CACHE = null; // { emb, posEmb, prep(scale/padX/padY), w, h }

  function log(text, level){ self.postMessage({ type: 'log', text: text, level: level || 'info' }); }
  function progress(text){ self.postMessage({ type: 'progress', text: text }); }

  self.onmessage = function(e){
    var msg = e.data;
    if(msg.type === 'encodeView') encodeView(msg);
    else if(msg.type === 'decodeClick') decodeClick(msg);
    else if(msg.type === 'invalidateView') { VIEW_CACHE = null; }
    else if(msg.type === 'clearModelCache'){
      (typeof caches === 'undefined' ? Promise.resolve(false) : caches.delete(SAM_CACHE_NAME)).then(function(ok){
        log('cache local de modelos ' + (ok ? 'limpa.' : 'ja estava vazia.'), 'info');
        self.postMessage({ type: 'result', reqId: msg.reqId, kind: 'clearModelCache', ok: ok });
      }).catch(function(err){
        self.postMessage({ type: 'error', reqId: msg.reqId, message: err.message || String(err) });
      });
    }
    else if(msg.type === 'loadModels'){
      loadModels().then(function(){
        self.postMessage({ type: 'modelsLoaded' });
      }).catch(function(err){
        log('erro ao pre-carregar modelos: ' + err.message, 'error');
      });
    }
  };

  // ========== Fase 1: captura ja' feita na main thread (DOM/html2canvas
  // nao existe em Workers) -- aqui so' se recebe a ImageBitmap e se corre
  // o encoder. ==========
  async function encodeView(msg){
    try {
      if(!LOADED) await loadModels();

      var bitmap = msg.bitmap, w = msg.w, h = msg.h;
      var srcCanvas = new OffscreenCanvas(w, h);
      srcCanvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close(); // a bitmap so' serviu de transporte -- liberta assim que copiada

      var prep = preprocessImage(srcCanvas, ENCODER_LAYOUT);
      var feeds = {};
      feeds[MODELS.encoder.inputNames[0]] = prep.tensor;
      var encResult;
      try {
        encResult = await MODELS.encoder.run(feeds);
      } catch(encErr){
        /* Ver nota identica na versao antiga (main thread): o encoder pode
           esperar NCHW ou NHWC consoante o export -- tenta-se o oposto uma
           unica vez e fixa-se o que funcionar. */
        var altLayout = ENCODER_LAYOUT === 'nchw' ? 'nhwc' : 'nchw';
        log('encoder falhou com layout ' + ENCODER_LAYOUT + ' (' + encErr.message + '), a tentar ' + altLayout + '...', 'warning');
        prep = preprocessImage(srcCanvas, altLayout);
        feeds = {};
        feeds[MODELS.encoder.inputNames[0]] = prep.tensor;
        encResult = await MODELS.encoder.run(feeds);
        ENCODER_LAYOUT = altLayout;
        log('layout correto e "' + altLayout + '" -- fixado para as proximas vistas.', 'info');
      }
      var emb = encResult[MODELS.encoder.outputNames[0]];
      var posEmb = MODELS.encoder.outputNames[1] ? encResult[MODELS.encoder.outputNames[1]] : null;

      VIEW_CACHE = { emb: emb, posEmb: posEmb, prep: prep, w: w, h: h };
      log('embedding calculado no worker para esta vista (zoom ' + msg.zoom + ') -- proximos cliques na mesma vista so\' pedem o decode.', 'info');
      self.postMessage({ type: 'result', reqId: msg.reqId, kind: 'encodeView', ok: true });
    } catch(err){
      self.postMessage({ type: 'error', reqId: msg.reqId, message: err.message || String(err) });
    }
  }

  // ========== Fase 2: decoder apenas, sobre o VIEW_CACHE ==========
  async function decodeClick(msg){
    try {
      if(!VIEW_CACHE){
        throw new Error('Sem embedding em cache no worker (a vista pode ter mudado) -- tenta clicar outra vez.');
      }
      var prep = VIEW_CACHE.prep, emb = VIEW_CACHE.emb, posEmb = VIEW_CACHE.posEmb;
      var clickX = msg.x, clickY = msg.y;

      var ecx = (clickX * prep.scale) + prep.padX;
      var ecy = (clickY * prep.scale) + prep.padY;
      var ptCoords = new Float32Array([ecx, ecy]);
      var ptLabels = new BigInt64Array([1n]);

      var decNames = MODELS.decoder.inputNames;
      var decFeeds = {};
      decNames.forEach(function(name){
        if(name === 'image_embeddings'){
          decFeeds[name] = emb;
        } else if(name === 'image_positional_embeddings'){
          decFeeds[name] = posEmb;
        } else if(name === 'input_points'){
          decFeeds[name] = new ort.Tensor('float32', ptCoords, [1, 1, 1, 2]);
        } else if(name === 'input_labels'){
          decFeeds[name] = new ort.Tensor('int64', ptLabels, [1, 1, 1]);
        } else if(name === 'input_boxes'){
          // Nao usamos caixas nesta interacao -- omitido (input opcional nesta convencao).
        } else if(name.indexOf('mask') !== -1){
          decFeeds[name] = new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]);
        } else {
          log('aviso -- input do decoder nao mapeado: "' + name + '" (a sessao pode falhar se for obrigatorio).', 'warning');
        }
      });

      var decResult = await MODELS.decoder.run(decFeeds);
      var outNames = MODELS.decoder.outputNames;
      var maskName = outNames.filter(function(n){ return n.toLowerCase().indexOf('mask') !== -1; })[0] || outNames[0];
      var scoreName = outNames.filter(function(n){ return n.toLowerCase().indexOf('score') !== -1 || n.toLowerCase().indexOf('iou') !== -1; })[0] || outNames[1];
      var masks = decResult[maskName];
      var scores = decResult[scoreName];

      var maskDims = masks.dims;
      var numMasks = maskDims[maskDims.length - 3];
      var maskH = maskDims[maskDims.length - 2];
      var maskW = maskDims[maskDims.length - 1];
      var stride = maskH * maskW;

      var MASK_MAX_COVERAGE = 0.85; // acima disto, assume-se "mascara = vista inteira"
      var totalGridPx = maskW * maskH;

      var order = [];
      for(var oi = 0; oi < numMasks; oi++) order.push(oi);
      order.sort(function(a, b){ return scores.data[b] - scores.data[a]; });

      var chosen = null;
      var candidatesLog = [];

      for(var oidx = 0; oidx < order.length; oidx++){
        var idx = order[oidx];
        var mData = new Float32Array(stride);
        for(var i = 0; i < stride; i++){ mData[i] = masks.data[idx * stride + i]; }

        var mMin = Infinity, mMax = -Infinity;
        for(var mi = 0; mi < stride; mi++){
          if(mData[mi] < mMin) mMin = mData[mi];
          if(mData[mi] > mMax) mMax = mData[mi];
        }
        var looksLikeProbability = (mMin >= -0.001 && mMax <= 1.001);
        var mThreshold = looksLikeProbability ? 0.5 : 0.0;

        var mBinaryRaw = new Uint8Array(stride);
        for(var i2 = 0; i2 < stride; i2++){ mBinaryRaw[i2] = mData[i2] > mThreshold ? 1 : 0; }
        var mBinary = morphClose(morphOpen(mBinaryRaw, maskW, maskH), maskW, maskH);
        var onCount = 0;
        for(var i2b = 0; i2b < stride; i2b++){ if(mBinary[i2b]) onCount++; }
        var coverage = onCount / totalGridPx;

        var mContours = marchingSquares(mBinary, maskW, maskH);
        var mBestContour = null, mBestArea = -1;
        mContours.forEach(function(contour){
          if(contour.length <= 5) return;
          var a = contourAreaPx(contour);
          if(a > mBestArea){ mBestArea = a; mBestContour = contour; }
        });
        if(mBestContour) mBestContour = simplifyPolygon(mBestContour, 1.5);

        candidatesLog.push('#' + idx + ' score=' + scores.data[idx].toFixed(3) + ' cobertura=' + (coverage * 100).toFixed(0) + '%');

        if(coverage <= MASK_MAX_COVERAGE && mBestContour){
          chosen = { idx: idx, bestContour: mBestContour, bestArea: mBestArea, coverage: coverage };
          break;
        }
      }
      log('candidatas -> ' + candidatesLog.join(' | '), 'info');

      var usedFallback = false;
      if(!chosen){
        usedFallback = true;
        var idx0 = order[0];
        var mData0 = new Float32Array(stride);
        for(var i3 = 0; i3 < stride; i3++){ mData0[i3] = masks.data[idx0 * stride + i3]; }
        var mMin0 = Infinity, mMax0 = -Infinity;
        for(var mi0 = 0; mi0 < stride; mi0++){
          if(mData0[mi0] < mMin0) mMin0 = mData0[mi0];
          if(mData0[mi0] > mMax0) mMax0 = mData0[mi0];
        }
        var thr0 = (mMin0 >= -0.001 && mMax0 <= 1.001) ? 0.5 : 0.0;
        var bin0Raw = new Uint8Array(stride);
        for(var i4 = 0; i4 < stride; i4++){ bin0Raw[i4] = mData0[i4] > thr0 ? 1 : 0; }
        var bin0 = morphClose(morphOpen(bin0Raw, maskW, maskH), maskW, maskH);
        var contours0 = marchingSquares(bin0, maskW, maskH);
        var bc0 = null, ba0 = -1;
        contours0.forEach(function(contour){
          if(contour.length <= 5) return;
          var a = contourAreaPx(contour);
          if(a > ba0){ ba0 = a; bc0 = contour; }
        });
        if(bc0) bc0 = simplifyPolygon(bc0, 1.5);
        chosen = { idx: idx0, bestContour: bc0, bestArea: ba0, coverage: (ba0 >= 0 ? ba0 / totalGridPx : 1) };
        log('aviso -- todas as mascaras cobrem >' + (MASK_MAX_COVERAGE * 100) + '% da vista (provavelmente ambiguidade do modelo). A usar a de maior score na mesma.', 'warning');
      }

      var bestIdx = chosen.idx;
      var bestContour = chosen.bestContour;
      log('mascara #' + bestIdx + ' escolhida, contorno com area ' + Math.round(chosen.bestArea) + ' px^2 (' + (chosen.coverage * 100).toFixed(0) + '%' + (usedFallback ? ', fallback sem candidata boa' : '') + ').', 'info');

      /* Converter grelha da mascara -> espaco do encoder (1024) -> espaco
         do canvas capturado (desfazendo prep.scale/padX/padY). PARA AQUI
         -- o worker nao sabe nada de lat/lng/bounds Leaflet, isso e' feito
         na main thread (que e' quem tem o mapa), a partir destes pontos em
         pixels do canvas. */
      var maskToEncX = SAM_IMAGE_SIZE / maskW;
      var maskToEncY = SAM_IMAGE_SIZE / maskH;
      var points = null;
      if(bestContour){
        points = bestContour.map(function(pt){
          var encX = pt[0] * maskToEncX;
          var encY = pt[1] * maskToEncY;
          var gx = (encX - prep.padX) / prep.scale;
          var gy = (encY - prep.padY) / prep.scale;
          return [gx, gy];
        });
      }

      self.postMessage({ type: 'result', reqId: msg.reqId, kind: 'decodeClick', points: points, score: scores.data[bestIdx] });
    } catch(err){
      self.postMessage({ type: 'error', reqId: msg.reqId, message: err.message || String(err) });
    }
  }

  // ========== Preprocessamento (identico ao antigo main thread, so' que
  // usa OffscreenCanvas em vez de document.createElement('canvas') --
  // Workers nao tem DOM). ==========
  function buildNormalizedPixels(imgData, imgSize){
    var n = imgSize * imgSize;
    var r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
    for(var y = 0; y < imgSize; y++){
      for(var x = 0; x < imgSize; x++){
        var pi = (y * imgSize + x) * 4;
        var i = y * imgSize + x;
        r[i] = (imgData.data[pi]     - SAM_PIXEL_MEAN[0]) / SAM_PIXEL_STD[0];
        g[i] = (imgData.data[pi + 1] - SAM_PIXEL_MEAN[1]) / SAM_PIXEL_STD[1];
        b[i] = (imgData.data[pi + 2] - SAM_PIXEL_MEAN[2]) / SAM_PIXEL_STD[2];
      }
    }
    return { r: r, g: g, b: b, n: n };
  }

  function preprocessImage(canvas, layout){
    layout = layout || 'nchw';
    var imgSize = SAM_IMAGE_SIZE;
    var w = canvas.width, h = canvas.height;
    var scale = imgSize / Math.max(w, h);
    var newW = Math.round(w * scale);
    var newH = Math.round(h * scale);

    var tc = new OffscreenCanvas(imgSize, imgSize);
    var ctx = tc.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, imgSize, imgSize);
    var ox = Math.round((imgSize - newW) / 2);
    var oy = Math.round((imgSize - newH) / 2);
    ctx.drawImage(canvas, 0, 0, w, h, ox, oy, newW, newH);

    var imgData = ctx.getImageData(0, 0, imgSize, imgSize);
    var px = buildNormalizedPixels(imgData, imgSize);

    var data = new Float32Array(3 * px.n);
    if(layout === 'nhwc'){
      for(var i = 0; i < px.n; i++){
        data[i * 3]     = px.r[i];
        data[i * 3 + 1] = px.g[i];
        data[i * 3 + 2] = px.b[i];
      }
    } else {
      data.set(px.r, 0);
      data.set(px.g, px.n);
      data.set(px.b, px.n * 2);
    }

    var shape = layout === 'nhwc' ? [1, imgSize, imgSize, 3] : [1, 3, imgSize, imgSize];

    return {
      tensor: new ort.Tensor('float32', data, shape),
      scale: scale,
      padX: ox,
      padY: oy,
    };
  }

  // ========== Traçado de contorno (Moore-Neighbor, identico ao antigo) ==========
  function marchingSquares(mask, w, h){
    function px(x, y){
      if(x < 0 || y < 0 || x >= w || y >= h) return 0;
      return mask[y * w + x];
    }

    var contours = [];
    var boundaryVisited = new Uint8Array(w * h);
    var nbrs = [[1,0], [1,-1], [0,-1], [-1,-1], [-1,0], [-1,1], [0,1], [1,1]];

    function trace(sx, sy){
      var pts = [];
      var cx = sx, cy = sy;
      var backDir = 4;
      var safety = 0;
      var maxSteps = (w * h * 4) + 8;
      do {
        pts.push([cx, cy]);
        boundaryVisited[cy * w + cx] = 1;
        var found = -1;
        for(var k = 0; k < 8; k++){
          var dIdx = (backDir + 1 + k) % 8;
          var nx = cx + nbrs[dIdx][0], ny = cy + nbrs[dIdx][1];
          if(px(nx, ny)){ found = dIdx; break; }
        }
        if(found === -1) break;
        cx += nbrs[found][0];
        cy += nbrs[found][1];
        backDir = (found + 4) % 8;
        safety++;
      } while(!(cx === sx && cy === sy) && safety < maxSteps);
      return pts;
    }

    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        if(mask[y * w + x] && !px(x - 1, y) && !boundaryVisited[y * w + x]){
          var pts = trace(x, y);
          if(pts.length > 5) contours.push(pts);
        }
      }
    }
    return contours;
  }

  function contourAreaPx(contour){
    var area = 0;
    for(var ci = 0; ci < contour.length; ci++){
      var cj = (ci + 1) % contour.length;
      area += contour[ci][0] * contour[cj][1] - contour[cj][0] * contour[ci][1];
    }
    return Math.abs(area) / 2;
  }

  // ========== Limpeza morfologica (identico ao antigo) ==========
  function morphErode(mask, w, h){
    var out = new Uint8Array(w * h);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        var i = y * w + x;
        if(!mask[i]){ out[i] = 0; continue; }
        var ok = 1;
        for(var dy = -1; dy <= 1 && ok; dy++){
          for(var dx = -1; dx <= 1; dx++){
            var nx = x + dx, ny = y + dy;
            if(nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]){ ok = 0; break; }
          }
        }
        out[i] = ok;
      }
    }
    return out;
  }

  function morphDilate(mask, w, h){
    var out = new Uint8Array(w * h);
    for(var y = 0; y < h; y++){
      for(var x = 0; x < w; x++){
        var i = y * w + x;
        if(mask[i]){ out[i] = 1; continue; }
        var any = 0;
        for(var dy = -1; dy <= 1 && !any; dy++){
          for(var dx = -1; dx <= 1; dx++){
            var nx = x + dx, ny = y + dy;
            if(nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]){ any = 1; break; }
          }
        }
        out[i] = any;
      }
    }
    return out;
  }

  function morphOpen(mask, w, h){ return morphDilate(morphErode(mask, w, h), w, h); }
  function morphClose(mask, w, h){ return morphErode(morphDilate(mask, w, h), w, h); }

  // ========== Simplificacao de poligono (Ramer-Douglas-Peucker, identico) ==========
  function simplifyPolygon(points, tolerance){
    if(points.length < 3) return points;

    function perpDist(p, a, b){
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len2 = dx * dx + dy * dy;
      if(len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
      var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
      var projX = a[0] + t * dx, projY = a[1] + t * dy;
      return Math.hypot(p[0] - projX, p[1] - projY);
    }

    function rdp(pts, tol){
      if(pts.length < 3) return pts.slice();
      var maxDist = -1, idx = -1;
      for(var i = 1; i < pts.length - 1; i++){
        var d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
        if(d > maxDist){ maxDist = d; idx = i; }
      }
      if(maxDist > tol){
        var left = rdp(pts.slice(0, idx + 1), tol);
        var right = rdp(pts.slice(idx), tol);
        return left.slice(0, -1).concat(right);
      }
      return [pts[0], pts[pts.length - 1]];
    }

    var withEnd = points.concat([points[0]]);
    var simplified = rdp(withEnd, tolerance);
    simplified.pop();
    return simplified.length >= 3 ? simplified : points;
  }

  // ========== Cache persistente dos modelos (Cache Storage API -- tambem
  // disponivel em Workers, nao so' em Service Workers, por isso o download
  // e a cache continuam a viver no mesmo sitio que fazem o trabalho pesado,
  // sem precisar de transferir ~106 MB de bytes da main thread para aqui). ==========
  async function getCachedModelBuffer(url, label){
    if(typeof caches === 'undefined') return null;
    try {
      var cache = await caches.open(SAM_CACHE_NAME);
      var cachedResp = await cache.match(url);
      if(!cachedResp) return null;
      var buf = await cachedResp.arrayBuffer();
      log(label + ' encontrado em cache local (' + (buf.byteLength / 1048576).toFixed(0) + ' MB) -- sem novo download.', 'info');
      return buf;
    } catch(e){
      return null;
    }
  }

  async function setCachedModelBuffer(url, buffer, label){
    if(typeof caches === 'undefined') return;
    try {
      var cache = await caches.open(SAM_CACHE_NAME);
      var resp = new Response(buffer, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.byteLength) }
      });
      await cache.put(url, resp);
      log(label + ' guardado em cache local para os proximos loads.', 'info');
    } catch(e){
      log('nao foi possivel guardar ' + label + ' em cache local (' + e.message + ') -- proximo load volta a descarregar.', 'warning');
    }
  }

  async function fetchModelBuffer(url, label){
    var cached = await getCachedModelBuffer(url, label);
    if(cached) return cached;

    var resp;
    try {
      resp = await fetch(url);
    } catch(networkErr){
      throw new Error('Falha de rede ao descarregar ' + label + ' (' + networkErr.message + '). Verifica a ligacao ou bloqueios de CORS.');
    }
    if(!resp.ok){
      throw new Error('HTTP ' + resp.status + ' ao descarregar ' + label + ' (' + url + ')');
    }

    var totalStr = resp.headers.get('content-length');
    var total = totalStr ? parseInt(totalStr, 10) : 0;

    if(!resp.body || !resp.body.getReader){
      var directBuf = await resp.arrayBuffer();
      await setCachedModelBuffer(url, directBuf, label);
      return directBuf;
    }

    var reader = resp.body.getReader();
    var chunks = [];
    var received = 0;
    var lastLoggedPct = -10;

    while(true){
      var step = await reader.read();
      if(step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if(total){
        var pct = Math.floor((received / total) * 100);
        if(pct >= lastLoggedPct + 10){
          lastLoggedPct = pct;
          progress(label + ' ' + pct + '% (' + (received/1048576).toFixed(0) + '/' + (total/1048576).toFixed(0) + ' MB)');
        }
      }
    }

    var buf = new Uint8Array(received);
    var offset = 0;
    for(var i = 0; i < chunks.length; i++){
      buf.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    await setCachedModelBuffer(url, buf.buffer, label);
    return buf.buffer;
  }

  async function loadModels(){
    if(LOADED) return;
    if(LOADING){
      while(!LOADED) await new Promise(function(r){ setTimeout(r, 500); });
      return;
    }
    LOADING = true;

    try {
      // 'webgl' removido: o backend webgl do onnxruntime-web precisa de um
      // WebGLRenderingContext ligado ao DOM da pagina, que nao existe dentro
      // de um Worker -- tentar usa-lo aqui so' gera o erro "[webgl] backend
      // not found" antes do fallback (inevitavel) para wasm.
      var opts = { executionProviders: ['wasm'] };

      log('a descarregar encoder (~101 MB, pode demorar)...', 'info');
      var encoderBuf = await fetchModelBuffer(ENCODER_URL, 'encoder');
      log('encoder descarregado, a inicializar sessao...', 'info');
      MODELS.encoder = await ort.InferenceSession.create(encoderBuf, opts);
      log('encoder OK', 'info');

      log('a descarregar decoder...', 'info');
      var decoderBuf = await fetchModelBuffer(DECODER_URL, 'decoder');
      MODELS.decoder = await ort.InferenceSession.create(decoderBuf, opts);
      log('decoder OK', 'info');

      log('inputs do encoder = ' + MODELS.encoder.inputNames.join(', ') + ' | outputs = ' + MODELS.encoder.outputNames.join(', '), 'info');
      log('inputs do decoder = ' + MODELS.decoder.inputNames.join(', ') + ' | outputs = ' + MODELS.decoder.outputNames.join(', '), 'info');

      LOADED = true;
    } catch(e){
      LOADING = false;
      log('erro ao carregar: ' + e.message, 'error');
      throw e;
    }
  }

})();
