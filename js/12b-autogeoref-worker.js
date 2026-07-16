/* ============================================================
   12b-AUTOGEOREF-WORKER.JS — deteção + RANSAC (12-autogeoref.js)
   a correr num Web Worker dedicado, para não bloquear a UI.
   ------------------------------------------------------------
   REESCRITA (v2): já não depende do OpenCV.js.

   Motivo: o build "oficial" do OpenCV.js (~8-10MB) compila o WASM
   de forma SÍNCRONA dentro da própria thread que o carrega — mesmo
   já isolado neste worker (ver histórico: fetch com AbortController,
   verificação de WebAssembly.instantiate para apanhar CSP sem
   'wasm-unsafe-eval', etc.), continuava a ser uma dependência de
   rede + compilação pesada, com falhas difíceis de diagnosticar
   (CSP, CDN em baixo, rede lenta) para uma tarefa que na prática é
   um algoritmo pequeno e bem definido.

   Esta versão implementa ORB (deteção FAST + descritor BRIEF
   orientado) + matching por Hamming (força bruta) + RANSAC afim
   diretamente em JavaScript puro, sem WASM nenhum:
     - sem download de 8-10MB (nem local em vendor/opencv.js, nem CDN)
     - sem compilação síncrona a bloquear a thread
     - sem depender de CSP permitir 'wasm-unsafe-eval'
     - tempo de execução previsível (função das dimensões da imagem
       e do número de features pedido, não da velocidade a compilar
       WASM)

   Tudo o que era operacionalmente importante na versão OpenCV foi
   preservado:
     - protocolo de mensagens inalterado (main → worker: 'detect'/
       'warmup'; worker → main: 'status'/'done'/'error') — 12-autogeoref.js
       e 05-app-main.js não precisam de nenhuma alteração;
     - rede de segurança para erros/rejeições silenciosas dentro do worker;
     - heartbeat a cada 1s durante um pedido 'detect', para o main
       thread distinguir "ainda a processar" de "worker morto";
     - features da referência (tile DGT) calculadas UMA ÚNICA VEZ e
       reutilizadas em todas as escalas/fallbacks, em vez de
       recalculadas a cada tentativa;
     - fallback automático mais permissivo quando uma escala produz
       poucas correspondências;
     - filtro de escalas (nunca upscale, s<=1) — já era assim no
       worker OpenCV: com scales:[1,0.75,0.5,1.25] só 3 são usadas.

   O RANSAC afim (solveAffineLeastSquares, ransacAffine) já era JS
   puro na versão anterior — fica exatamente igual.

   Protocolo de mensagens (inalterado):
     main → worker:  { type:'detect', id, imgBitmap, refBitmap,
                        refTileBounds, refTileSize, opts }
                      { type:'warmup' }
     worker → main:   { type:'status', id, text }
                       { type:'done',   id, success, gcps?, quality?, reason? }
                       { type:'error',  id, message }
   ============================================================ */

/* ------------------------------------------------------------
   MARCADOR DE VERSÃO — imprime-se sempre que este script é
   carregado pelo browser/Electron, ANTES de qualquer mensagem
   'warmup'/'detect'. Serve só para confirmar sem ambiguidade, na
   consola, que é mesmo ESTE ficheiro (com equalização de histograma
   + nFeatures=2000) que está a correr, e não uma versão em cache —
   Web Workers têm cache próprio, separado do cache normal da
   página, que sobrevive muitas vezes a um reload simples.
   ------------------------------------------------------------ */
console.log('[AutoGeoref worker] build: equalização de histograma + DEFAULT_N_FEATURES=2000 (mosaico 3×3)');

/* ------------------------------------------------------------
   0) rede de segurança para falhas SILENCIOSAS dentro do worker
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

function getErrorMessage(err){
  if(!err) return 'Erro desconhecido';
  if(typeof err === 'string') return err;
  if(err.message) return err.message;
  try{ return JSON.stringify(err); }catch{ return String(err); }
}

/* ------------------------------------------------------------
   1) solveAffineLeastSquares / solve3x3 — INALTERADO (já era JS
      puro). Ver comentários originais em 11-georef.js.
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
   2) RANSAC afim — INALTERADO.
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
      reason:`Só ${Math.max(best.inlierCount,0)} inliers encontrados (mínimo exigido: ${minInliers}) — provavelmente as duas imagens não têm sobreposição suficiente ou são de zonas/épocas demasiado diferentes.`,
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
   3) IMAGEM: ImageBitmap -> escala de cinzentos (Uint8ClampedArray),
      via OffscreenCanvas — substitui bitmapToMat (que dependia de
      cv.Mat/cv.imread).
   ------------------------------------------------------------ */
function bitmapToGray(bitmap, scale){
  if(!bitmap || typeof bitmap.width !== 'number' || typeof bitmap.height !== 'number'){
    throw new Error('Bitmap inválido ou sem dimensões.');
  }
  if(typeof OffscreenCanvas === 'undefined'){
    throw new Error('OffscreenCanvas não está disponível neste ambiente.');
  }
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if(!ctx) throw new Error('Não foi possível criar um contexto 2D para o OffscreenCanvas.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const src = imageData.data;
  const gray = new Uint8ClampedArray(w*h);
  for(let i=0, j=0; i<src.length; i+=4, j++){
    // método da luminosidade (pesos padrão Rec. 601, iguais ao cv.COLOR_RGBA2GRAY)
    gray[j] = (src[i]*0.299 + src[i+1]*0.587 + src[i+2]*0.114) | 0;
  }
  return { data: gray, width: w, height: h };
}

function scaleBitmapSync(bitmap, scale){
  if(scale === 1) return bitmap;
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

/* ------------------------------------------------------------
   3b) EQUALIZAÇÃO DE HISTOGRAMA (Fase B) — normaliza o contraste
      global antes do FAST/BRIEF. Sem isto, FAST_THRESHOLD (uma
      diferença de intensidade ABSOLUTA, 0-255) tem um efeito muito
      diferente consoante a fonte: uma ortofoto DGT, uma tile de
      satélite Esri e uma foto arbitrária do utilizador raramente
      partilham o mesmo alcance de contraste/exposição, o que ajuda a
      explicar o nº de candidatos FAST tão díspar entre fontes nos
      logs (23k a 50k). Equalização global (CDF stretch, O(w*h), um
      único varrimento) é a alternativa "rápida" mencionada nas notas
      de autogeoref — CLAHE local (por blocos) fica para depois, é
      mais trabalho e só compensa se isto não for suficiente.
      Aplica-se ANTES do blur (tal como um CLAHE seguido de suavização
      num pipeline OpenCV "a sério"), para não equalizar ruído já
      espalhado pelo blur. */
function equalizeHistogram(gray){
  const n = gray.length;
  if(n === 0) return gray;
  const hist = new Uint32Array(256);
  for(let i=0; i<n; i++) hist[gray[i]]++;

  // CDF acumulada, normalizada a 0-255. Ignora-se o "bin" mais baixo não-vazio
  // na normalização (equalização clássica de Gonzalez/Woods) para não
  // desperdiçar gama dinâmica quando a imagem já tem alguns pixels no preto puro.
  let cdfMin = 0;
  for(let i=0; i<256; i++){ if(hist[i] > 0){ cdfMin = hist[i]; break; } }
  const denom = Math.max(1, n - cdfMin);

  const lut = new Uint8ClampedArray(256);
  let cdf = 0;
  for(let i=0; i<256; i++){
    cdf += hist[i];
    lut[i] = Math.round(((cdf - cdfMin) / denom) * 255);
  }

  const out = new Uint8ClampedArray(n);
  for(let i=0; i<n; i++) out[i] = lut[gray[i]];
  return out;
}

/* box blur separável (janela deslizante, O(w*h) independente do raio) —
   suaviza ruído antes do BRIEF, tal como um ORB "a sério" faz (a build
   OpenCV usava um Gaussian blur interno equivalente antes de amostrar) */
function clampInt(v, lo, hi){ return v<lo?lo:(v>hi?hi:v); }
function boxBlur(src, w, h, radius){
  const tmp = new Float32Array(w*h);
  const out = new Uint8ClampedArray(w*h);
  const size = radius*2+1;

  for(let y=0; y<h; y++){
    const rowOff = y*w;
    let sum = 0;
    for(let x=-radius; x<=radius; x++) sum += src[rowOff + clampInt(x,0,w-1)];
    for(let x=0; x<w; x++){
      tmp[rowOff+x] = sum/size;
      const addX = clampInt(x+radius+1, 0, w-1);
      const subX = clampInt(x-radius, 0, w-1);
      sum += src[rowOff+addX] - src[rowOff+subX];
    }
  }
  for(let x=0; x<w; x++){
    let sum = 0;
    for(let y=-radius; y<=radius; y++) sum += tmp[clampInt(y,0,h-1)*w+x];
    for(let y=0; y<h; y++){
      out[y*w+x] = Math.round(sum/size);
      const addY = clampInt(y+radius+1, 0, h-1);
      const subY = clampInt(y-radius, 0, h-1);
      sum += tmp[addY*w+x] - tmp[subY*w+x];
    }
  }
  return out;
}

/* ------------------------------------------------------------
   4) FAST-9 — deteção de cantos, círculo de Bresenham raio 3
      (16 pontos, os mesmos offsets padrão do OpenCV/paper original
      de Rosten & Drummond).
   ------------------------------------------------------------ */
const FAST_OFFSETS = [
  [0,-3],[1,-3],[2,-2],[3,-1],
  [3,0],[3,1],[2,2],[1,3],
  [0,3],[-1,3],[-2,2],[-3,1],
  [-3,0],[-3,-1],[-2,-2],[-1,-3]
];
const FAST_THRESHOLD = 22;   // diferença de intensidade mínima (0-255) para contar como mais claro/escuro
const FAST_ARC_LEN = 9;      // nº mínimo de pontos contíguos no círculo de 16 para ser canto
const FAST_BORDER = 17;      // margem: cobre o círculo do FAST (raio 3) + a mancha da orientação/BRIEF (raio 15)
const NMS_MIN_DIST = 6;      // distância mínima (px) entre cantos aceites, para espalhar os pontos pela imagem

/* Fase C: o mosaico de referência (768×768, ver 05-app-main.js) faz o FAST
   encontrar 20k-28k candidatos, mas o NMS estava a saturar sempre no teto de
   1200 — ou seja, a densidade extra do mosaico estava a ser descartada antes
   de sequer chegar ao BRIEF/matching. Subir o teto deixa passar mais pontos
   verdadeiros (o custo é O(n²) no matching por força bruta: 1200×1200≈1.4M
   comparações a ~45ms nos logs; 2000×2000≈4M ainda fica bem dentro do
   orçamento por escala). Continua a ser sobreponível por opts.detect.nFeatures. */
const DEFAULT_N_FEATURES = 2000;

function contiguousArcScore(vals, p, thresh, bright){
  const N = vals.length;
  let run=0, bestRun=0, sum=0, bestSum=0;
  for(let i=0; i<2*N; i++){
    const v = vals[i % N];
    const cond = bright ? v > thresh : v < thresh;
    if(cond){
      run++; sum += Math.abs(v-p);
      if(run > bestRun){ bestRun = run; bestSum = sum; }
    } else {
      run = 0; sum = 0;
    }
    if(i >= N && bestRun >= FAST_ARC_LEN) break;
  }
  return bestRun >= FAST_ARC_LEN ? bestSum : 0;
}

function detectFastCorners(gray, w, h, threshold, border){
  const corners = [];
  const hiOff = threshold, loOff = -threshold;
  for(let y=border; y<h-border; y++){
    const rowOff = y*w;
    for(let x=border; x<w-border; x++){
      const idx = rowOff + x;
      const p = gray[idx];
      const hi = p + hiOff, lo = p + loOff;

      // rejeição rápida: pelo menos 3 dos 4 pontos cardinais (topo/direita/baixo/esquerda
      // do círculo) têm de ser todos mais claros OU todos mais escuros — descarta a
      // grande maioria dos pixels em <10 leituras, sem precisar do teste completo de 16.
      const c0 = gray[idx-3*w], c4 = gray[idx+3], c8 = gray[idx+3*w], c12 = gray[idx-3];
      let bright=0, dark=0;
      if(c0>hi)bright++; else if(c0<lo)dark++;
      if(c4>hi)bright++; else if(c4<lo)dark++;
      if(c8>hi)bright++; else if(c8<lo)dark++;
      if(c12>hi)bright++; else if(c12<lo)dark++;
      if(bright<3 && dark<3) continue;

      const vals = new Int16Array(16);
      for(let k=0;k<16;k++){
        const off = FAST_OFFSETS[k];
        vals[k] = gray[idx + off[1]*w + off[0]];
      }
      const score = Math.max(
        contiguousArcScore(vals, p, hi, true),
        contiguousArcScore(vals, p, lo, false)
      );
      if(score > 0) corners.push({x, y, score});
    }
  }
  return corners;
}

/* supressão de não-máximos por grelha: mantém os cantos com maior score,
   espalhados pela imagem em vez de amontoados na mesma zona texturada */
function nonMaxSuppress(corners, w, h, nFeatures, minDist){
  corners.sort((a,b)=> b.score - a.score);
  const cell = Math.max(1, minDist);
  const gridW = Math.ceil(w/cell), gridH = Math.ceil(h/cell);
  const occupied = new Uint8Array(gridW*gridH);
  const result = [];
  for(const c of corners){
    const gx = Math.floor(c.x/cell), gy = Math.floor(c.y/cell);
    let taken = false;
    for(let dy=-1; dy<=1 && !taken; dy++){
      for(let dx=-1; dx<=1 && !taken; dx++){
        const nx=gx+dx, ny=gy+dy;
        if(nx>=0 && nx<gridW && ny>=0 && ny<gridH && occupied[ny*gridW+nx]) taken = true;
      }
    }
    if(taken) continue;
    occupied[gy*gridW+gx] = 1;
    result.push(c);
    if(result.length >= nFeatures) break;
  }
  return result;
}

/* ------------------------------------------------------------
   5) ORIENTAÇÃO — centroide de intensidade sobre uma mancha circular
      de raio 15 (tal como o ORB "a sério"), para o BRIEF poder ser
      rodado e ficar invariante à rotação entre a foto e o tile.
   ------------------------------------------------------------ */
const ORIENT_RADIUS = 15;
const ORIENT_UMAX = (function(){
  const u = new Int32Array(ORIENT_RADIUS+1);
  const rr = ORIENT_RADIUS*ORIENT_RADIUS;
  for(let y=0; y<=ORIENT_RADIUS; y++) u[y] = Math.round(Math.sqrt(Math.max(0, rr - y*y)));
  return u;
})();

function computeOrientation(gray, w, h, cx, cy){
  let m01=0, m10=0;
  for(let y=-ORIENT_RADIUS; y<=ORIENT_RADIUS; y++){
    const yy = cy+y;
    if(yy<0 || yy>=h) continue;
    const rowMax = ORIENT_UMAX[Math.abs(y)];
    const rowOff = yy*w;
    let rowSum = 0;
    const xStart = Math.max(0, cx-rowMax), xEnd = Math.min(w-1, cx+rowMax);
    for(let xx=xStart; xx<=xEnd; xx++){
      const val = gray[rowOff+xx];
      rowSum += val;
      m10 += (xx-cx)*val;
    }
    m01 += y*rowSum;
  }
  return Math.atan2(m01, m10);
}

/* ------------------------------------------------------------
   6) DESCRITOR rBRIEF (256 bits / 32 bytes) com padrão de amostragem
      fixo, gerado uma única vez com um PRNG semeado (mulberry32) —
      não é o padrão treinado exato do OpenCV (esse é proprietário/
      aprendido offline), mas segue a mesma receita: pares de pontos
      distribuídos em Gauss dentro de uma mancha de raio 15, rodados
      pela orientação do ponto-chave ("steered BRIEF", o que torna o
      ORB invariante à rotação). Como só comparamos descritores
      gerados pelo MESMO padrão nas duas imagens, não precisa de
      corresponder ao padrão de mais ninguém para funcionar bem.
   ------------------------------------------------------------ */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussianPair(rand){
  let u=0, v=0;
  while(u===0) u = rand();
  while(v===0) v = rand();
  const mag = Math.sqrt(-2*Math.log(u));
  return [mag*Math.cos(2*Math.PI*v), mag*Math.sin(2*Math.PI*v)];
}
const BRIEF_BITS = 256;
const BRIEF_PATCH_RADIUS = 15;
const BRIEF_SIGMA = BRIEF_PATCH_RADIUS / 2.5;
const BRIEF_PATTERN = (function(){
  const rand = mulberry32(0xC0FFEE);
  const pts = [];
  const sampleWithin = ()=>{
    let x, y;
    do{
      const [gx, gy] = gaussianPair(rand);
      x = Math.round(gx*BRIEF_SIGMA); y = Math.round(gy*BRIEF_SIGMA);
    } while(Math.abs(x) > BRIEF_PATCH_RADIUS || Math.abs(y) > BRIEF_PATCH_RADIUS);
    return [x, y];
  };
  for(let i=0; i<BRIEF_BITS; i++){
    const [x1,y1] = sampleWithin();
    const [x2,y2] = sampleWithin();
    pts.push([x1,y1,x2,y2]);
  }
  return pts;
})();

function sampleGray(gray, w, h, x, y){
  x = clampInt(x, 0, w-1); y = clampInt(y, 0, h-1);
  return gray[y*w+x];
}
function computeBRIEFDescriptor(gray, w, h, cx, cy, angle){
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const desc = new Uint8Array(32);
  for(let i=0; i<BRIEF_BITS; i++){
    const p = BRIEF_PATTERN[i];
    const rx1 = Math.round(p[0]*cosA - p[1]*sinA), ry1 = Math.round(p[0]*sinA + p[1]*cosA);
    const rx2 = Math.round(p[2]*cosA - p[3]*sinA), ry2 = Math.round(p[2]*sinA + p[3]*cosA);
    const v1 = sampleGray(gray, w, h, cx+rx1, cy+ry1);
    const v2 = sampleGray(gray, w, h, cx+rx2, cy+ry2);
    if(v1 < v2) desc[i>>3] |= (1 << (i&7));
  }
  return desc;
}

/* Hamming distance via XOR + tabela de popcount de 8 bits */
const POPCOUNT8 = (function(){
  const t = new Uint8Array(256);
  for(let i=0;i<256;i++){ let c=0, v=i; while(v){ c += v&1; v >>= 1; } t[i]=c; }
  return t;
})();
function hammingDistance(a, b){
  let d=0;
  for(let i=0;i<32;i++) d += POPCOUNT8[a[i]^b[i]];
  return d;
}

/* ------------------------------------------------------------
   7) computeFeatures / matchFeaturesJS — substituem computeFeatures/
      matchFeatures baseados em cv.ORB/cv.BFMatcher. Mesma assinatura
      /contrato (bitmap -> {keypoints, descriptors, scale, count}) que
      o resto do ficheiro (detectAndMatchMultiScale) já espera — e a
      MESMA otimização já usada na versão OpenCV: computeFeatures é
      isolado para a referência poder ser calculada uma única vez.
   ------------------------------------------------------------ */
function computeFeatures(bitmap, nFeatures, maxImageDim, label, postStatus, equalize){
  const emit = (text)=> postStatus && postStatus(text);
  const scale = Math.min(1, maxImageDim / Math.max(bitmap.width, bitmap.height));

  let t = performance.now();
  const { data: rawGray, width, height } = bitmapToGray(bitmap, scale);
  emit(`[timing] ${label}: bitmapToGray em ${Math.round(performance.now()-t)}ms (scale=${scale.toFixed(2)}, ${width}x${height})`);

  // Fase B: equalização de histograma ANTES do blur — normaliza contraste/
  // exposição entre fontes (DGT/Satélite/foto do utilizador) para que
  // FAST_THRESHOLD tenha um efeito consistente independentemente da origem.
  // Desligável via opts.detect.equalize:false, para comparação A/B.
  let normalizedGray = rawGray;
  if(equalize !== false){
    t = performance.now();
    normalizedGray = equalizeHistogram(rawGray);
    emit(`[timing] ${label}: equalização de histograma em ${Math.round(performance.now()-t)}ms`);
  }

  t = performance.now();
  const gray = boxBlur(normalizedGray, width, height, 1);
  emit(`[timing] ${label}: blur em ${Math.round(performance.now()-t)}ms`);

  t = performance.now();
  let corners = detectFastCorners(gray, width, height, FAST_THRESHOLD, FAST_BORDER);
  emit(`[timing] ${label}: FAST detetou ${corners.length} candidatos em ${Math.round(performance.now()-t)}ms`);

  t = performance.now();
  corners = nonMaxSuppress(corners, width, height, nFeatures, NMS_MIN_DIST);
  emit(`[timing] ${label}: NMS reduziu para ${corners.length} pontos em ${Math.round(performance.now()-t)}ms`);

  t = performance.now();
  const keypoints = new Array(corners.length);
  const descriptors = new Array(corners.length);
  for(let i=0; i<corners.length; i++){
    const c = corners[i];
    const angle = computeOrientation(gray, width, height, c.x, c.y);
    keypoints[i] = { x: c.x, y: c.y, angle, score: c.score };
    descriptors[i] = computeBRIEFDescriptor(gray, width, height, c.x, c.y, angle);
  }
  emit(`[timing] ${label}: orientação + BRIEF em ${Math.round(performance.now()-t)}ms (${descriptors.length} descritores, nFeatures=${nFeatures})`);

  return { keypoints, descriptors, scale, count: descriptors.length };
}

function matchFeaturesJS(feat1, feat2, ratioTestThreshold, label, postStatus){
  const emit = (text)=> postStatus && postStatus(text);
  const { keypoints: kp1, descriptors: desc1, scale: scale1 } = feat1;
  const { keypoints: kp2, descriptors: desc2, scale: scale2 } = feat2;
  const matches = [];
  const t = performance.now();
  for(let i=0; i<desc1.length; i++){
    let best = Infinity, second = Infinity, bestJ = -1;
    const d1 = desc1[i];
    for(let j=0; j<desc2.length; j++){
      const d = hammingDistance(d1, desc2[j]);
      if(d < best){ second = best; best = d; bestJ = j; }
      else if(d < second){ second = d; }
    }
    if(bestJ === -1) continue;
    // ratio test de Lowe, adaptado a distância de Hamming: só aceita se a
    // melhor correspondência for claramente melhor do que a segunda hipótese
    if(second === Infinity || best < ratioTestThreshold * second){
      matches.push({
        p1: { x: kp1[i].x/scale1, y: kp1[i].y/scale1 },
        p2: { x: kp2[bestJ].x/scale2, y: kp2[bestJ].y/scale2 },
        distance: best
      });
    }
  }
  emit(`[timing] ${label}: matching (força bruta, ${desc1.length}×${desc2.length}) em ${Math.round(performance.now()-t)}ms — ${matches.length} correspondências`);
  return matches;
}

/* Mantido só por compatibilidade com chamadas manuais na consola. */
function detectAndMatch(bitmap1, bitmap2, opts, postStatus){
  const { nFeatures = DEFAULT_N_FEATURES, ratioTestThreshold = 0.75, maxImageDim = 1200, equalize } = opts || {};
  const feat1 = computeFeatures(bitmap1, nFeatures, maxImageDim, 'imagem', postStatus, equalize);
  const feat2 = computeFeatures(bitmap2, nFeatures, maxImageDim, 'referência', postStatus, equalize);
  return matchFeaturesJS(feat1, feat2, ratioTestThreshold, 'match', postStatus);
}

/* ------------------------------------------------------------
   8) MULTIESCALA — mesma orquestração/otimizações da versão OpenCV
      (features da referência calculadas uma única vez, fallback
      mais permissivo, atalho de "resultado já muito bom"), só troca
      as chamadas a cv.* por computeFeatures/matchFeaturesJS.
   ------------------------------------------------------------ */
async function detectAndMatchMultiScale(imgBitmap, refBitmap, opts, postStatus){
  // aceita tanto opts.detect.scales (o que 05-app-main.js/runAutoGeorefDetection
  // realmente envia) como opts.scales (compatibilidade com chamadas manuais mais
  // simples).
  const rawScales = Array.isArray(opts && opts.detect && opts.detect.scales) ? opts.detect.scales
                   : Array.isArray(opts && opts.scales) ? opts.scales
                   : [1];
  // nunca fazer upscale (>1): amplia o custo de deteção sem benefício real
  // para o ORB. Mesmo comportamento que o worker OpenCV — com
  // scales:[1,0.75,0.5,1.25] só as 3 primeiras são usadas.
  const filteredScales = rawScales.filter(s => Number.isFinite(s) && s > 0 && s <= 1);
  const scales = filteredScales.length ? filteredScales : [1];
  const detectOpts = opts && opts.detect;
  const ransacOpts = opts && opts.ransac;
  let best = null;
  const emit = (text)=> { if(postStatus) postStatus(text); };

  // features da referência: iguais em todas as escalas/fallbacks, calculadas
  // uma única vez e reutilizadas (mesma otimização da versão OpenCV — ver
  // 12b-autogeoref-worker.js.opencv-backup para o histórico do bloqueio de
  // 90s que isto resolveu).
  const refNFeatures = (detectOpts && detectOpts.nFeatures) || DEFAULT_N_FEATURES;
  const refMaxDim = (detectOpts && detectOpts.maxImageDim) || 1200;
  const refEqualize = detectOpts && detectOpts.equalize;
  emit('a calcular features da referência (uma única vez, reutilizadas em todas as escalas)…');
  const tRef = performance.now();
  const refFeatures = computeFeatures(refBitmap, refNFeatures, refMaxDim, 'referência', postStatus, refEqualize);
  emit(`referência: ${refFeatures.count} descritores em ${Math.round(performance.now() - tRef)}ms.`);

  const tryDetectWithFallback = (source, label, baseOpts) => {
    const effectiveOpts = baseOpts ? { ...baseOpts } : {};
    const feat1 = computeFeatures(source, effectiveOpts.nFeatures || DEFAULT_N_FEATURES, effectiveOpts.maxImageDim || 1200, label, postStatus, effectiveOpts.equalize);
    const matches = matchFeaturesJS(feat1, refFeatures, effectiveOpts.ratioTestThreshold || 0.75, label, postStatus);
    if(matches.length >= 3) return matches;

    const fallbackOpts = {
      ...effectiveOpts,
      nFeatures: Math.max(400, Math.floor((effectiveOpts.nFeatures || DEFAULT_N_FEATURES) / 2 * 1.5)), // mais generoso que o dobro em baixo, já que não há custo de compilação a poupar
      ratioTestThreshold: Math.min(0.9, (effectiveOpts.ratioTestThreshold || 0.75) + 0.1),
      maxImageDim: Math.max(800, Math.floor((effectiveOpts.maxImageDim || 1200) * 0.9))
    };
    emit(`${label}: poucas correspondências (${matches.length}); a tentar fallback mais permissivo…`);
    const feat1b = computeFeatures(source, fallbackOpts.nFeatures, fallbackOpts.maxImageDim, `${label} (fallback)`, postStatus, fallbackOpts.equalize);
    return matchFeaturesJS(feat1b, refFeatures, fallbackOpts.ratioTestThreshold, `${label} (fallback)`, postStatus);
  };

  for(let i = 0; i < scales.length; i++){
    const scale = scales[i];
    const label = `escala ${i + 1}/${scales.length} (×${scale})`;
    let matches;
    const t0 = performance.now();
    try{
      emit(`${label}: a redimensionar e a detetar features…`);
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

  return best; // null se nenhuma escala produziu um modelo fiável
}

/* ------------------------------------------------------------
   9) pixel do tile de referência -> lat/lng real
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
   10) orquestração — mensagens do main thread
   ------------------------------------------------------------
   WARM-UP: pedido disparado por AutoGeoref.warmUp() (12-autogeoref.js)
   assim que o utilizador entra em modo de georreferenciação. Sem
   OpenCV a carregar, já não há nada pesado para pré-aquecer — a única
   latência real agora é o arranque do próprio worker (instantâneo em
   comparação com os 8-10MB de antes). Mantido só por compatibilidade
   de protocolo: 12-autogeoref.js continua a chamar {type:'warmup'}
   sem precisar de saber que já não faz falta.
   ------------------------------------------------------------ */
self.onmessage = async (evt)=>{
  const msg = evt.data;
  if(!msg) return;

  if(msg.type === 'warmup'){
    self.postMessage({type:'status', id:'warmup', text:'[warmup] worker pronto (sem dependências pesadas a carregar).'});
    return;
  }

  if(msg.type !== 'detect') return;
  const { id, imgBitmap, refBitmap, refTileBounds, refTileSize, opts } = msg;
  currentRequestId = id;
  const heartbeat = setInterval(() => {
    self.postMessage({ type: 'status', id, text: 'heartbeat ' + Math.round(performance.now()) + ' ms' });
  }, 1000);

  try{
    const postStatus = (text)=> self.postMessage({type:'status', id, text});
    const best = await detectAndMatchMultiScale(imgBitmap, refBitmap, opts, postStatus);
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
    const msg2 = getErrorMessage(err);
    console.error('[WORKER] erro geral no processamento', { id, error: err && err.stack ? err.stack : err });
    self.postMessage({type:'error', id, message: msg2});
  }finally{
    clearInterval(heartbeat);
    if(imgBitmap && imgBitmap.close) imgBitmap.close();
    if(refBitmap && refBitmap.close) refBitmap.close();
  }
};
