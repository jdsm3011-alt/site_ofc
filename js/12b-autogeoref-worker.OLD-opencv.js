/* ============================================================
   12b-AUTOGEOREF-WORKER.JS — deteção + RANSAC (12-autogeoref.js)
   a correr num Web Worker dedicado, para não bloquear a UI.
   ------------------------------------------------------------
   PORQUÊ ESTE FICHEIRO EXISTE:
   O OpenCV.js compila o WASM (~8-10MB) de forma SÍNCRONA na
   thread onde é carregado. Em 12-autogeoref.js isso acontecia na
   main thread da página — por isso a app ficava "presa" (não é
   um crash: é o browser mesmo ocupado a compilar) durante a
   compilação + deteção ORB + RANSAC, ao ponto de nem a consola
   abrir.
   Este ficheiro corre exatamente a MESMA lógica, mas dentro de
   um Worker à parte: a compilação e o processamento pesado ficam
   nesta thread separada, e a página principal continua
   responsiva. O UMD wrapper do próprio opencv.js já prevê este
   uso («else if (typeof importScripts === 'function') { root.cv
   = factory(); }») — não há truque nenhum aqui, é o modo de
   utilização suportado.

   NOTA: um Worker não tem DOM nem `window`. Por isso este
   ficheiro NÃO pode fazer `importScripts('11-georef.js')`
   diretamente (esse ficheiro escreve em `window.Georef`, que não
   existe aqui) — o solver de mínimos quadrados está copiado
   abaixo tal e qual, para o worker ser autónomo.
   ------------------------------------------------------------
   Protocolo de mensagens:
     main → worker:  { type:'detect', id, imgBitmap, refBitmap,
                        refTileBounds, refTileSize, opts }
     worker → main:   { type:'status', id, text }
                       { type:'done',   id, success, gcps?, quality?, reason? }
                       { type:'error',  id, message }
   ============================================================ */

const OPENCV_JS_URLS = (()=>{
  const localUrl = (()=>{
    try{
      return new URL('./vendor/opencv.js', self.location.href).href;
    }catch(err){
      return './vendor/opencv.js';
    }
  })();
  return [localUrl, 'https://docs.opencv.org/4.x/opencv.js'];
})();

/* ------------------------------------------------------------
   0) cópia autónoma de Georef.solveAffineLeastSquares (11-georef.js)
      — ver esse ficheiro para os comentários completos sobre o
      método (equações normais 3x3 por regra de Cramer).
   ------------------------------------------------------------ */
function solveAffineLeastSquares(gcps){
  if(!Array.isArray(gcps) || gcps.length < 3){
    throw new Error('São necessários pelo menos 3 pontos de controlo.');
  }
  let Sxx=0, Sxy=0, Sx=0, Syy=0, Sy=0;
  let SxX=0, SyX=0, SX=0;
  let SxY=0, SyY=0, SY=0;
  const n = gcps.length;
  gcps.forEach(p=>{
    const x = p.img.x, y = p.img.y;
    const X = p.map.lng, Y = p.map.lat;
    Sxx += x*x; Sxy += x*y; Sx += x;
    Syy += y*y; Sy += y;
    SxX += x*X; SyX += y*X; SX += X;
    SxY += x*Y; SyY += y*Y; SY += Y;
  });
  const A = [[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,n]];
  const bX = [SxX, SyX, SX];
  const bY = [SxY, SyY, SY];
  const [a,b,c] = solve3x3(A, bX);
  const [d,e,f] = solve3x3(A, bY);
  let sumSq = 0;
  gcps.forEach(p=>{
    const x = p.img.x, y = p.img.y;
    const dx = (a*x + b*y + c) - p.map.lng;
    const dy = (d*x + e*y + f) - p.map.lat;
    sumSq += dx*dx + dy*dy;
  });
  return {a,b,c,d,e,f, rms: Math.sqrt(sumSq / n)};
}
function solve3x3(A, b){
  const det3 = M => (
      M[0][0]*(M[1][1]*M[2][2] - M[1][2]*M[2][1])
    - M[0][1]*(M[1][0]*M[2][2] - M[1][2]*M[2][0])
    + M[0][2]*(M[1][0]*M[2][1] - M[1][1]*M[2][0])
  );
  const D = det3(A);
  if(Math.abs(D) < 1e-9) throw new Error('Sistema mal-condicionado — pontos colineares ou repetidos.');
  const withCol = (col, vec)=> A.map((row,i)=> row.map((v,j)=> j===col ? vec[i] : v));
  return [det3(withCol(0,b))/D, det3(withCol(1,b))/D, det3(withCol(2,b))/D];
}

/* ------------------------------------------------------------
   0b) rede de segurança para falhas SILENCIOSAS dentro do worker.
   Uma CSP sem 'wasm-unsafe-eval' bloqueia a compilação do WebAssembly,
   e consoante o browser isso pode rejeitar uma Promise interna do
   próprio opencv.js sem nunca chamar onRuntimeInitialized NEM lançar
   um erro que o nosso try/catch apanhe — fica só um
   "Uncaught (in promise)" na consola do PRÓPRIO worker (contexto que
   é fácil não estar a ver no DevTools). Isto reencaminha esses casos
   para o main thread, com id do pedido atual.
   ------------------------------------------------------------ */
let currentRequestId = null;
self.addEventListener('error', (evt)=>{
  self.postMessage({
    type:'status', id: currentRequestId,
    text: `[worker error global] ${evt.message} (${evt.filename}:${evt.lineno})`
  });
});
self.addEventListener('unhandledrejection', (evt)=>{
  const reason = evt && evt.reason;
  const text = reason && reason.message ? reason.message : String(reason);
  self.postMessage({
    type:'status', id: currentRequestId,
    text: `[worker unhandledrejection] ${text}`
  });
});


/* ------------------------------------------------------------
   1) carregamento do OpenCV.js dentro do worker
   ------------------------------------------------------------
   IMPORTANTE (bug corrigido): a versão anterior usava importScripts(url)
   dentro da Promise. importScripts é SÍNCRONO e BLOQUEANTE — enquanto o
   worker está a tentar descarregar o ficheiro pela rede, o thread inteiro
   fica parado, e isso inclui o próprio setTimeout(60000) que devia servir
   de rede de segurança aqui dentro (um timer só dispara quando o thread
   está livre para processar o event loop). Resultado: se a rede ficasse
   lenta ou bloqueada em silêncio (proxy, CSP, CDN em baixo), nem esse
   timeout de 60s nem o heartbeat do self.onmessage principal disparavam —
   só o timeout de 90s do lado do main thread (que corre numa thread
   diferente, não bloqueada) acabava por rebentar, sem UMA mensagem sequer
   ter chegado a sair do worker.
   Agora usa-se fetch() com AbortController: um timeout que realmente
   consegue cancelar o pedido de rede, e diz-nos com precisão qual dos
   dois URLs falhou e porquê (rede vs. timeout vs. CSP/CORS).
   ------------------------------------------------------------ */
const OPENCV_FETCH_TIMEOUT_MS = 20000; // por URL tentado

async function fetchAndRunScript(url, postStatus){
  const emit = (text)=> { if(postStatus) postStatus(text); };
  const controller = new AbortController();
  const timer = setTimeout(()=> controller.abort(), OPENCV_FETCH_TIMEOUT_MS);
  const t0 = performance.now();
  let blobUrl = null;
  try{
    emit(`[timing] a pedir ${url} (timeout ${OPENCV_FETCH_TIMEOUT_MS/1000}s)…`);
    const resp = await fetch(url, { signal: controller.signal });
    if(!resp.ok){
      throw new Error(`HTTP ${resp.status} ao pedir ${url}`);
    }
    const code = await resp.text();
    emit(`[timing] ${url}: ${Math.round(code.length/1024)}KB recebidos em ${Math.round(performance.now() - t0)}ms, a executar…`);
    // importScripts continua a ser usado para executar o código (evita
    // precisar de 'unsafe-eval' na CSP), mas agora sobre um Blob URL local
    // — sem componente de rede, por isso não pode ficar "pendurado": o
    // download (a única parte que podia bloquear indefinidamente) já
    // aconteceu acima, via fetch, que É cancelável pelo AbortController.
    blobUrl = URL.createObjectURL(new Blob([code], {type:'application/javascript'}));
    importScripts(blobUrl);
    emit(`[timing] ${url}: executado em ${Math.round(performance.now() - t0)}ms no total.`);
  }catch(err){
    if(err && err.name === 'AbortError'){
      throw new Error(`Timeout de ${OPENCV_FETCH_TIMEOUT_MS/1000}s ao pedir ${url} (rede lenta, CSP a bloquear o fetch, ou servidor a não responder).`);
    }
    throw err;
  }finally{
    clearTimeout(timer);
    if(blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

let cvReady = null;
function loadOpenCV(postStatus){
  if(cvReady) return cvReady;
  cvReady = (async ()=>{
    const TIMEOUT_MS = 100000; // valor de produção — ver 12-autogeoref.js para o motivo do ajuste

    let lastError = null;
    for(const url of OPENCV_JS_URLS){
      try{
        await fetchAndRunScript(url, postStatus);
        lastError = null;
        break;
      }catch(err){
        lastError = err;
        if(postStatus) postStatus(`[timing] falha em ${url}: ${err.message} — a tentar próximo URL, se houver.`);
      }
    }

    if(lastError){
      throw new Error('Não foi possível carregar o OpenCV.js no worker: ' + lastError.message);
    }

    /* ------------------------------------------------------------
       CORREÇÃO (confirmada com um teste isolado em Node, fora do
       browser, sobre este mesmo ficheiro opencv.js): esta build NÃO
       lê nenhum `Module`/`self.Module` definido antes de o script
       correr — cria o seu próprio `Module` interno, fechado dentro
       da função `factory()`, e ignora por completo qualquer objeto
       externo com esse nome. Um `self.Module.onRuntimeInitialized`
       definido ANTES do importScripts nunca é chamado por esta build
       — fica pendurado para sempre (era a causa do bloqueio de 120s:
       o script corria e executava em <1s, mas o loadOpenCV ficava à
       espera de um callback que nunca ia disparar).

       O objeto certo só existe DEPOIS do script correr: o próprio
       UMD wrapper do ficheiro faz, no ramo "Web worker"
       (`typeof importScripts === 'function'`), exatamente
       `root.cv = factory()` — e dentro de um worker, `root` (o
       `this` de topo) é `self`. Ou seja, mesmo antes do WASM
       terminar de compilar, `self.cv` já existe como objeto
       (incompleto). A forma verificada de saber quando fica
       completo é atribuir `onRuntimeInitialized` a ESSE objeto,
       logo a seguir a ele existir.
       ------------------------------------------------------------ */
    if(typeof self.cv === 'undefined'){
      throw new Error('O opencv.js executou mas não definiu self.cv — build incompatível ou UMD wrapper alterado.');
    }
    if(self.cv.Mat) return self.cv; // já estava pronto (ex.: cvReady reaproveitado por um pedido anterior)

    return await new Promise((resolve, reject)=>{
      const timer = setTimeout(()=>{
        clearInterval(poll);
        reject(new Error(`OpenCV.js executou mas o runtime WASM não ficou pronto em ${TIMEOUT_MS/1000}s.`));
      }, TIMEOUT_MS);

      self.cv['onRuntimeInitialized'] = ()=>{
        clearTimeout(timer);
        clearInterval(poll);
        resolve(self.cv);
      };

      // rede de segurança: cobre a janela de corrida em que o runtime já
      // ficou pronto (ex.: build já em cache do V8) antes de a linha acima
      // correr — sem isto, essa janela deixava a promise pendente para
      // sempre, exatamente como o bug original descrito em 12-autogeoref.js.
      const poll = setInterval(()=>{
        if(self.cv && self.cv.Mat){
          clearInterval(poll);
          clearTimeout(timer);
          resolve(self.cv);
        }
      }, 100);
    });
  })();
  return cvReady;
}

/* ------------------------------------------------------------
   2) ImageBitmap -> cv.Mat, via OffscreenCanvas (não há <canvas>
      nem document dentro de um worker — OffscreenCanvas é o
      equivalente aqui)
   ------------------------------------------------------------ */
function bitmapToMat(cv, bitmap, scale){
  if(!bitmap || typeof bitmap.width !== 'number' || typeof bitmap.height !== 'number'){
    throw new Error('Bitmap inválido ou sem dimensões para converter para Mat.');
  }
  if(typeof OffscreenCanvas === 'undefined'){
    throw new Error('OffscreenCanvas não está disponível neste ambiente.');
  }

  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if(!ctx){
    throw new Error('Não foi possível criar um contexto 2D para o OffscreenCanvas.');
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  return cv.matFromImageData(imageData);
}

/* ------------------------------------------------------------
   3) deteção + correspondência (ORB + BFMatcher + ratio test) —
      mesma lógica de 12-autogeoref.js, já com a correção de
      devolver os pontos no espaço de pixels de CADA bitmap
      original (não no espaço reduzido por maxImageDim).
   ------------------------------------------------------------ */
function getErrorMessage(err){
  if(!err) return 'Erro desconhecido';
  if(typeof err === 'string') return err;
  if(err.message) return err.message;
  try{ return JSON.stringify(err); }catch{ return String(err); }
}

/* computeFeatures: bitmap -> {kp, desc, scale}. Isolado de detectAndMatch
   para que o lado da REFERÊNCIA (que não muda entre escalas nem entre
   tentativas de fallback) possa ser calculado UMA VEZ SÓ e reutilizado —
   ver nota grande mais abaixo, em detectAndMatchMultiScale, sobre porque
   isto era a causa mais provável do bloqueio de 90s. */
function computeFeatures(cv, bitmap, nFeatures, maxImageDim, label, postStatus){
  const emit = (text)=> postStatus && postStatus(text);
  const scale = Math.min(1, maxImageDim / Math.max(bitmap.width, bitmap.height));

  let t = performance.now();
  const mat = bitmapToMat(cv, bitmap, scale);
  emit(`[timing] ${label}: bitmapToMat em ${Math.round(performance.now() - t)}ms (scale=${scale.toFixed(2)}, ${mat.cols}x${mat.rows})`);

  const gray = new cv.Mat();
  t = performance.now();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  emit(`[timing] ${label}: cvtColor em ${Math.round(performance.now() - t)}ms`);

  t = performance.now();
  const orb = typeof cv.ORB?.create === 'function' ? cv.ORB.create(nFeatures) : new cv.ORB(nFeatures);
  const kp = new cv.KeyPointVector();
  const desc = new cv.Mat();
  const mask = new cv.Mat();
  orb.detectAndCompute(gray, mask, kp, desc);
  emit(`[timing] ${label}: ORB.detectAndCompute em ${Math.round(performance.now() - t)}ms (${desc.rows} descritores, nFeatures=${nFeatures})`);

  mat.delete(); gray.delete(); mask.delete(); orb.delete();
  return { kp, desc, scale };
}

/* matchFeatures: cruza duas features já calculadas (BFMatcher + ratio test
   de Lowe). Não toca em cv.Mat pesados — só nos vetores kp/desc já prontos. */
function matchFeatures(cv, feat1, feat2, ratioTestThreshold, label, postStatus){
  const emit = (text)=> postStatus && postStatus(text);
  const { kp: kp1, desc: desc1, scale: scale1 } = feat1;
  const { kp: kp2, desc: desc2, scale: scale2 } = feat2;
  let matches = [];
  if(desc1.rows > 0 && desc2.rows > 0){
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const knnMatches = new cv.DMatchVectorVector();
    const t = performance.now();
    bf.knnMatch(desc1, desc2, knnMatches, 2);
    emit(`[timing] ${label}: BFMatcher.knnMatch em ${Math.round(performance.now() - t)}ms`);
    for(let i = 0; i < knnMatches.size(); i++){
      const pair = knnMatches.get(i);
      if(pair.size() < 2) continue;
      const m = pair.get(0), n = pair.get(1);
      if(m.distance < ratioTestThreshold * n.distance){
        const p1 = kp1.get(m.queryIdx).pt;
        const p2 = kp2.get(m.trainIdx).pt;
        matches.push({
          p1: { x: p1.x / scale1, y: p1.y / scale1 },
          p2: { x: p2.x / scale2, y: p2.y / scale2 },
          distance: m.distance
        });
      }
    }
    bf.delete(); knnMatches.delete();
  }
  return matches;
}

/* Mantido só por compatibilidade com chamadas manuais na consola
   (window.AutoGeoref-like); o caminho automático usa agora computeFeatures
   + matchFeatures directamente, para poder cachear o lado da referência. */
function detectAndMatch(cv, bitmap1, bitmap2, opts, postStatus){
  if(!bitmap1 || !bitmap2){
    throw new Error('As duas imagens precisam de existir para a deteção ORB.');
  }
  const {
    nFeatures = 1200,
    ratioTestThreshold = 0.75,
    maxImageDim = 1200
  } = opts || {};
  const feat1 = computeFeatures(cv, bitmap1, nFeatures, maxImageDim, 'imagem', postStatus);
  const feat2 = computeFeatures(cv, bitmap2, nFeatures, maxImageDim, 'referência', postStatus);
  const matches = matchFeatures(cv, feat1, feat2, ratioTestThreshold, 'match', postStatus);
  [feat1.kp, feat1.desc, feat2.kp, feat2.desc].forEach(m=> m.delete());
  return matches;
}

/* ------------------------------------------------------------
   4) RANSAC afim — cópia de ransacAffine (12-autogeoref.js),
      trocando Georef.solveAffineLeastSquares pela cópia local.
   ------------------------------------------------------------ */
async function ransacAffine(matches, opts){
  const {
    iterations = 180,
    inlierThresholdPx = 6,
    minInliers = 8,
    timeoutMs = 2200
  } = opts || {};

  if(matches.length < 3){
    return {success:false, reason:'Menos de 3 correspondências — impossível calcular uma transformação afim.'};
  }

  const startTime = performance.now();
  const toGcpFormat = m => ({img: m.p1, map: {lng: m.p2.x, lat: m.p2.y}});
  let best = {inlierCount: -1, inlierIdx: null, transform: null};

  for(let iter = 0; iter < iterations; iter++){
    if(iter % 20 === 0 && performance.now() - startTime > timeoutMs) break;

    const sampleIdx = sampleThreeDistinctIndices(matches.length);
    const sample = sampleIdx.map(i => toGcpFormat(matches[i]));

    let candidate;
    try{ candidate = solveAffineLeastSquares(sample); }
    catch(err){ continue; }

    const inlierIdx = [];
    for(let i = 0; i < matches.length; i++){
      const m = matches[i];
      const predX = candidate.a*m.p1.x + candidate.b*m.p1.y + candidate.c;
      const predY = candidate.d*m.p1.x + candidate.e*m.p1.y + candidate.f;
      const err = Math.hypot(predX - m.p2.x, predY - m.p2.y);
      if(err <= inlierThresholdPx) inlierIdx.push(i);
    }
    if(inlierIdx.length > best.inlierCount) best = {inlierCount: inlierIdx.length, inlierIdx, transform: candidate};
  }

  if(best.inlierCount < minInliers){
    return {
      success:false,
      reason:`Só ${Math.max(best.inlierCount,0)} inliers encontrados (mínimo exigido: ${minInliers}).`,
      inlierCount: best.inlierCount,
      totalMatches: matches.length
    };
  }

  const inlierGcps = best.inlierIdx.map(i => toGcpFormat(matches[i]));
  const refined = solveAffineLeastSquares(inlierGcps);

  return {
    success:true,
    transform: refined,
    inlierIdx: best.inlierIdx,
    inlierCount: best.inlierCount,
    totalMatches: matches.length,
    inlierRatio: best.inlierCount / matches.length,
    rmsPx: refined.rms
  };
}
function sampleThreeDistinctIndices(n){
  const idx = new Set();
  while(idx.size < 3){ idx.add(Math.floor(Math.random() * n)); }
  return Array.from(idx);
}

/* ------------------------------------------------------------
   4b) MULTIESCALA: tenta várias versões escaladas da imagem a
       georreferenciar (opts.scales), porque a foto e o tile de
       referência raramente estão à mesma escala. Mantém o melhor
       resultado por número de inliers — cópia adaptada de
       detectAndMatchMultiScale (12-autogeoref.js) para trabalhar
       com ImageBitmap/OffscreenCanvas em vez de <img>/<canvas> do DOM.
   ------------------------------------------------------------ */
function scaleBitmapSync(bitmap, scale){
  if(scale === 1) return bitmap;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas; // serve tal e qual como fonte para bitmapToMat (drawImage aceita OffscreenCanvas)
}

async function detectAndMatchMultiScale(cv, imgBitmap, refBitmap, opts, postStatus){
  // aceita tanto opts.detect.scales (o que 05-app-main.js/runAutoGeorefDetection
  // realmente envia) como opts.scales (compatibilidade com chamadas manuais mais
  // simples) — antes disto, opts.detect.scales era sempre ignorado silenciosamente
  // e a app testava sempre uma única escala, mesmo pedindo várias.
  const rawScales = Array.isArray(opts && opts.detect && opts.detect.scales) ? opts.detect.scales
                   : Array.isArray(opts && opts.scales) ? opts.scales
                   : [1];
  // nunca fazer upscale (>1): amplia o custo de decodificação/getImageData sem
  // benefício real para o ORB, e é precisamente o tipo de coisa que pode prender
  // a página com uma imagem de entrada já grande.
  const filteredScales = rawScales.filter(s => Number.isFinite(s) && s > 0 && s <= 1);
  const scales = filteredScales.length ? filteredScales : [1];
  const detectOpts = opts && opts.detect;
  const ransacOpts = opts && opts.ransac;
  let best = null;
  const emit = (text)=> { if(postStatus) postStatus(text); };

  /* ------------------------------------------------------------------
     PONTO CRÍTICO — provável causa principal do bloqueio de 90s:
     `refBitmap` (o tile DGT 256×256) é o MESMO em todas as escalas e em
     todas as tentativas de fallback. Antes desta alteração, cada chamada
     a detectAndMatch(source, refBitmap, …) recalculava do zero
     bitmapToMat + cvtColor + ORB.detectAndCompute também PARA A
     REFERÊNCIA — ou seja, com N escalas e um fallback por escala, as
     features da referência eram recalculadas até 2×N vezes, sempre
     produzindo exatamente o mesmo resultado. Com scales:[1,0.75,0.5,1.25]
     (3 escalas válidas após filtrar upscale) isso são até 6 recomputações
     idênticas. Calculamos agora as features da referência UMA ÚNICA VEZ,
     aqui fora do loop, e reutilizamo-las em todas as escalas/fallbacks.
     ------------------------------------------------------------------ */
  const refNFeatures = (detectOpts && detectOpts.nFeatures) || 1200;
  const refMaxDim = (detectOpts && detectOpts.maxImageDim) || 1200;
  emit('a calcular features ORB da referência (uma única vez, reutilizadas em todas as escalas)…');
  const tRef = performance.now();
  const refFeatures = computeFeatures(cv, refBitmap, refNFeatures, refMaxDim, 'referência', postStatus);
  emit(`referência: ${refFeatures.desc.rows} descritores em ${Math.round(performance.now() - tRef)}ms.`);

  const tryDetectWithFallback = (source, label, baseOpts) => {
    const effectiveOpts = baseOpts ? { ...baseOpts } : {};
    const feat1 = computeFeatures(cv, source, effectiveOpts.nFeatures || 1200, effectiveOpts.maxImageDim || 1200, label, postStatus);
    const matches = matchFeatures(cv, feat1, refFeatures, effectiveOpts.ratioTestThreshold || 0.75, label, postStatus);
    feat1.kp.delete(); feat1.desc.delete();
    if(matches.length >= 3) return matches;

    const fallbackOpts = {
      ...effectiveOpts,
      nFeatures: Math.max(400, Math.floor((effectiveOpts.nFeatures || 1200) / 2)),
      ratioTestThreshold: Math.min(0.9, (effectiveOpts.ratioTestThreshold || 0.75) + 0.1),
      maxImageDim: Math.max(800, Math.floor((effectiveOpts.maxImageDim || 1200) * 0.9))
    };
    emit(`${label}: poucas correspondências (${matches.length}); a tentar fallback mais permissivo…`);
    const feat1b = computeFeatures(cv, source, fallbackOpts.nFeatures, fallbackOpts.maxImageDim, `${label} (fallback)`, postStatus);
    const matchesFallback = matchFeatures(cv, feat1b, refFeatures, fallbackOpts.ratioTestThreshold, `${label} (fallback)`, postStatus);
    feat1b.kp.delete(); feat1b.desc.delete();
    return matchesFallback;
  };

  try{
    for(let i = 0; i < scales.length; i++){
      const scale = scales[i];
      const label = `escala ${i + 1}/${scales.length} (×${scale})`;
      let matches;
      const t0 = performance.now();
      try{
        emit(`${label}: a redimensionar e a detetar features ORB…`);
        const source = scaleBitmapSync(imgBitmap, scale);
        matches = tryDetectWithFallback(source, label, detectOpts);
        emit(`${label}: ${matches.length} correspondências candidatas em ${Math.round(performance.now() - t0)}ms.`);
      }catch(err){
        const msg = getErrorMessage(err);
        console.error(`[WORKER] ${label} falhou`, { scale, detectOpts, ransacOpts, error: err && err.stack ? err.stack : err });
        emit(`${label}: falhou (${msg}) — a passar à seguinte.`);
        continue;
      }
      if(matches.length < 3) continue;

      const rescaled = scale === 1 ? matches : matches.map(m => ({
        p1: { x: m.p1.x / scale, y: m.p1.y / scale },
        p2: m.p2,
        distance: m.distance
      }));

      emit(`${label}: a correr RANSAC sobre ${rescaled.length} correspondências…`);
      const tRansac = performance.now();
      const result = await ransacAffine(rescaled, ransacOpts);
      emit(`${label}: RANSAC concluído em ${Math.round(performance.now() - tRansac)}ms (${result.success ? result.inlierCount + ' inliers' : 'sem modelo fiável'}).`);
      if(!result.success) continue;

      if(!best || result.inlierCount > best.inlierCount ||
         (result.inlierCount === best.inlierCount && result.inlierRatio > best.inlierRatio)){
        best = { matches: rescaled, scale, ...result };
      }

      // atalho: um resultado já claramente bom não justifica pagar o
      // custo de testar as escalas restantes.
      if(best && best.inlierCount >= 20 && best.inlierRatio >= 0.5){
        emit(`${label}: resultado já muito bom (${best.inlierCount} inliers, ${(best.inlierRatio*100).toFixed(0)}%) — a saltar escalas restantes.`);
        break;
      }
    }
  } finally {
    refFeatures.kp.delete();
    refFeatures.desc.delete();
  }

  return best; // null se nenhuma escala produziu um modelo fiável
}

/* ------------------------------------------------------------
   5) pixel do tile de referência -> lat/lng real
   ------------------------------------------------------------ */
function pixelPointToLatLng(point, bounds, tileSize){
  const {west, east, north, south} = bounds;
  return {
    lng: west + (point.x / tileSize.width) * (east - west),
    lat: north + (point.y / tileSize.height) * (south - north)
  };
}
function buildGcpsFromMatches(matches, inlierIdx, refBounds, tileSize){
  return inlierIdx.map((i, index)=>{
    const m = matches[i];
    return { img: {x: m.p1.x, y: m.p1.y}, map: pixelPointToLatLng(m.p2, refBounds, tileSize), source: 'auto', index: index + 1 };
  });
}

/* ------------------------------------------------------------
   6) orquestração — mensagens do main thread
   ------------------------------------------------------------ */
/* ------------------------------------------------------------
   6b) WARM-UP: pedido disparado por AutoGeoref.warmUp() (12-autogeoref.js)
       assim que o utilizador entra em modo de georreferenciação — muito
       antes de clicar "Autogeoreferenciar". Só dispara o carregamento do
       OpenCV.js (que fica cacheado em `cvReady` e é reaproveitado por
       qualquer pedido 'detect' seguinte) e confirma a compilação de WASM;
       não faz deteção nenhuma, não faz sentido ter id nem resposta 'done'.
       Fire-and-forget do lado do main thread — se isto falhar, é só
       silenciosamente ignorado aqui: o próximo 'detect' real vai tentar o
       carregamento outra vez e reportar o erro como sempre.
   ------------------------------------------------------------ */
async function handleWarmUp(){
  try{
    const trivialWasm = new Uint8Array([0,97,115,109,1,0,0,0]);
    await WebAssembly.instantiate(trivialWasm);
    self.postMessage({type:'status', id:'warmup', text:'[warmup] a pré-carregar OpenCV.js em segundo plano…'});
    await loadOpenCV((text)=> self.postMessage({type:'status', id:'warmup', text: '[warmup] ' + text}));
    self.postMessage({type:'status', id:'warmup', text:'[warmup] OpenCV.js pronto — Autogeoreferenciar vai arrancar quase instantaneamente.'});
  }catch(err){
    // não propaga como 'error': o warm-up é best-effort. O pedido 'detect'
    // real, quando vier, vai tentar loadOpenCV() de novo e reportar como
    // erro visível ao utilizador se continuar a falhar.
    self.postMessage({type:'status', id:'warmup', text:'[warmup] falhou (sem impacto imediato, o próximo pedido tenta de novo): ' + getErrorMessage(err)});
  }
}

self.onmessage = async (evt)=>{
  const msg = evt.data;
  if(!msg) return;
  if(msg.type === 'warmup'){
    handleWarmUp();
    return;
  }
  if(msg.type !== 'detect') return;
  const { id, imgBitmap, refBitmap, refTileBounds, refTileSize, opts } = msg;
  currentRequestId = id;
  const heartbeat = setInterval(() => {
    self.postMessage({
      type: 'status',
      id,
      text: 'heartbeat ' + Math.round(performance.now()) + ' ms'
    });
  }, 1000);

  try{
    // teste rápido: confirma que o browser consegue mesmo compilar
    // WebAssembly aqui dentro. Se a CSP não incluir 'wasm-unsafe-eval'
    // (ou 'unsafe-eval' em browsers mais antigos), isto falha em
    // milissegundos com um erro claro, em vez de deixarmos o opencv.js
    // tentar e ficar preso/silencioso lá dentro.
    try{
      const trivialWasm = new Uint8Array([0,97,115,109,1,0,0,0]); // módulo WASM vazio válido
      await WebAssembly.instantiate(trivialWasm);
      self.postMessage({type:'status', id, text:'[timing] WebAssembly.instantiate disponível — CSP não está a bloquear WASM.'});
    }catch(wasmErr){
      throw new Error('WebAssembly não pode ser compilado neste worker (provável CSP sem "wasm-unsafe-eval"): ' + (wasmErr && wasmErr.message ? wasmErr.message : String(wasmErr)));
    }

    const t0 = performance.now();
    self.postMessage({type:'status', id, text:'a carregar OpenCV.js…'});
    const cv = await loadOpenCV((text)=> self.postMessage({type:'status', id, text}));
    self.postMessage({type:'status', id, text:`OpenCV.js pronto em ${Math.round(performance.now() - t0)}ms.`});

    const postStatus = (text)=> self.postMessage({type:'status', id, text});
    const best = await detectAndMatchMultiScale(cv, imgBitmap, refBitmap, opts, postStatus);
    if(!best){
      self.postMessage({type:'done', id, success:false, reason:'Não foi possível encontrar um modelo fiável entre as imagens (correspondências insuficientes ou RANSAC sem inliers suficientes em nenhuma escala testada).'});
      return;
    }

    const gcps = buildGcpsFromMatches(best.matches, best.inlierIdx, refTileBounds, refTileSize);
    self.postMessage({
      type:'done', id, success:true, gcps,
      quality: {
        inlierCount: best.inlierCount,
        totalMatches: best.totalMatches,
        inlierRatio: best.inlierRatio,
        rmsPx: best.rmsPx,
        scale: best.scale
      }
    });
  }catch(err){
    const msg = getErrorMessage(err);
    console.error('[WORKER] erro geral no processamento', { id, error: err && err.stack ? err.stack : err });
    self.postMessage({type:'error', id, message: msg});
  }finally{
    clearInterval(heartbeat);
    if(imgBitmap && imgBitmap.close) imgBitmap.close();
    if(refBitmap && refBitmap.close) refBitmap.close();
  }
};
