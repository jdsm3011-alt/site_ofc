/* ============================================================
   12-AUTOGEOREF.JS — Georreferenciação automática (fotos aéreas /
   ortofotos), por deteção e correspondência de features
   ------------------------------------------------------------
   FASE 0 (preparação / spike técnico) — tal como o 11-georef.js,
   este ficheiro ainda NÃO está ligado à interface da aplicação.
   Serve só para validar, isoladamente, as duas peças de maior
   risco técnico ANTES de o ligar a tiles reais da DGT e à UI:

     1) deteção + correspondência de features (ORB) entre duas
        imagens do mesmo local (a foto a georreferenciar e um
        excerto da ortofoto de referência) — isto é o "consegue a
        biblioteca sequer encontrar pontos em comum entre uma foto
        aérea antiga e uma ortofoto atual?", a pergunta que decide
        se esta abordagem é viável de todo;
     2) ajuste robusto (RANSAC) de uma transformação afim a partir
        dessas correspondências, muitas das quais serão erradas
        (falsos matches) — reaproveitando o MESMO solver de
        mínimos quadrados já validado em 11-georef.js
        (`Georef.solveAffineLeastSquares`), só que agora a escolher
        que pontos lhe entregar em vez de receber sempre pontos
        corretos vindos de cliques manuais.

   O QUE FICA DE FORA DESTE SPIKE (propositadamente, para fases
   seguintes):
     - ir buscar tiles reais da ortofoto DGT para a zona do
       município selecionado (aqui recebe-se já as duas imagens
       prontas, ex.: um screenshot do basemap);
     - converter pixels do tile de referência em lat/lng reais
       (trivial depois de se souber o bounding box do tile — não é
       risco técnico, por isso não está aqui);
     - qualquer UI (botão "🪄 Detetar automaticamente", pré-
       preenchimento da lista de GCPs em georef.css/11-georef.js).

   Depende do OpenCV.js (carregado dinamicamente, só quando usado —
   não faz sentido pesar o carregamento inicial da app com isto
   para quem nunca usar a georreferenciação automática).

   Nada aqui corre automaticamente. As funções ficam disponíveis em
   `window.AutoGeoref`, para uso manual na consola.
   ============================================================ */

(function(){

  const OPENCV_JS_URL = 'https://docs.opencv.org/4.x/opencv.js';

  /* ------------------------------------------------------------
     0) Carregamento preguiçoso do OpenCV.js (~8MB de WASM) — só na
        primeira vez que for preciso. Reentrante: chamadas repetidas
        devolvem a mesma promise em vez de injetar o script 2x.

        CUIDADO (bug bem conhecido do opencv.js): se tentarmos
        atribuir `cv.onRuntimeInitialized` só depois do evento
        `onload` do <script>, existe uma janela de corrida — se o
        WASM compilar rápido (ex.: já em cache), o runtime pode
        ficar pronto e disparar esse callback ANTES de o atribuirmos,
        e a promise fica pendente para sempre (foi o que aconteceu
        no teste: "Promise {<pending>}" nunca resolve). A forma
        correta é definir `window.Module` com o callback já pronto
        ANTES de sequer inserir o <script> — assim não há janela de
        tempo nenhuma onde o runtime possa ficar pronto "sem ninguém
        a ouvir". Ver também: o WASM compila de forma síncrona na
        thread principal, por isso é normal a página ficar sem
        resposta por alguns segundos (não é um crash real).
     ------------------------------------------------------------ */
  let openCvLoadingPromise = null;
  function loadOpenCV(){
    if(typeof cv !== 'undefined' && cv.Mat){
      return Promise.resolve(cv);
    }
    if(openCvLoadingPromise) return openCvLoadingPromise;

    openCvLoadingPromise = new Promise((resolve, reject)=>{
      const TIMEOUT_MS = 200000; // WASM grande (build "oficial" ~8-10MB, com dnn/ml/etc. incluídos)
                                 // compila de forma SÍNCRONA — em CPUs mais lentas isto pode
                                 // passar bem de 90s; 200s dá folga real em vez de abortar cedo.
                                 // Ver 12b-autogeoref-worker.js para a correção definitiva
                                 // (build reduzido do OpenCV.js só com os módulos usados).
      let settled = false;
      const timer = setTimeout(()=>{
        if(settled) return;
        settled = true;
        reject(new Error(
          `OpenCV.js não ficou pronto em ${TIMEOUT_MS/1000}s. ` +
          `Verifica a aba Network do browser: se "opencv.js" não aparece a ` +
          `descarregar, é bloqueio de rede/CSP; se aparece completo mas na ` +
          `mesma sem resposta, o separador pode só estar ocupado a compilar ` +
          `o WASM (normal demorar em máquinas mais lentas) — tenta esperar mais ` +
          `ou recarregar a página.`
        ));
      }, TIMEOUT_MS);

      const finish = (err, result)=>{
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        if(err) reject(err); else resolve(result);
      };

      // define o callback ANTES de o script ser inserido — elimina a
      // corrida descrita acima. A maioria dos builds do opencv.js lê
      // `window.Module` neste formato (padrão Emscripten); se o build
      // usar antes `cv.onRuntimeInitialized`, o polling abaixo apanha-o.
      window.Module = window.Module || {};
      const previousOnRuntimeInitialized = window.Module.onRuntimeInitialized;
      window.Module.onRuntimeInitialized = function(){
        if(typeof previousOnRuntimeInitialized === 'function') previousOnRuntimeInitialized();
        finish(null, typeof cv !== 'undefined' ? cv : window.Module);
      };

      // fallback por polling, para builds que não sigam a convenção acima
      const startPoll = ()=>{
        const pollInterval = setInterval(()=>{
          if(settled){ clearInterval(pollInterval); return; }
          if(typeof cv !== 'undefined' && cv.Mat){
            clearInterval(pollInterval);
            finish(null, cv);
          }
        }, 100);
      };

      const script = document.createElement('script');
      script.src = OPENCV_JS_URL;
      script.async = true;
      script.onerror = ()=> finish(new Error('Não foi possível carregar o OpenCV.js (' + OPENCV_JS_URL + ') — verifica a ligação de rede ou se o URL está acessível.'));
      script.onload = startPoll; // rede começa fora daqui; isto só confirma que o ficheiro chegou
      document.head.appendChild(script);
    });

    return openCvLoadingPromise;
  }

  /* ------------------------------------------------------------
     FASE 1 — PRÉ-PROCESSAMENTO PARA MATCHING MULTI-FONTE
     ------------------------------------------------------------
     Pensado para o caso que motivou esta fase: comparar uma foto
     aérea/ortofoto DGT com imagery de satélite (ou fontes de épocas
     diferentes) — situações em que a COR e a TEXTURA fina variam
     muito (sensor diferente, exposição diferente, vegetação/sombras
     de estação diferente), mas a ESTRUTURA geométrica da cena
     (estradas, limites de parcelas, edifícios) se mantém estável.

     Dois passos, cada um opcional:

       1) CLAHE (Contrast Limited Adaptive Histogram Equalization) —
          normaliza exposição/contraste local, para que a mesma cena
          fotografada com exposições diferentes fique com um
          histograma comparável antes da deteção de features.

       2) Domínio de gradiente (Sobel) — deteta features sobre o
          MAPA DE BORDAS em vez da imagem de intensidade crua. Cor
          e textura fina desaparecem; estrutura (bordas) mantém-se.
          É este passo que ataca diretamente o problema de "cores
          mais vivas"/sensor diferente entre ortofoto e satélite.

     Devolve um novo cv.Mat (o chamador é responsável por o apagar
     com .delete() tal como qualquer outro Mat OpenCV). Nunca modifica
     `grayMat` no local.
     ------------------------------------------------------------ */
  function preprocessForMatching(cv, grayMat, opts){
    const {
      clahe = true,
      claheClipLimit = 3.0,
      claheTileGridSize = 8,
      gradientDomain = true
    } = opts || {};

    let working = grayMat;
    let ownsWorking = false;

    if(clahe){
      const equalized = new cv.Mat();
      try{
        const claheObj = new cv.CLAHE(claheClipLimit, new cv.Size(claheTileGridSize, claheTileGridSize));
        claheObj.apply(working, equalized);
        claheObj.delete();
      }catch(err){
        // fallback: algumas builds do opencv.js não expõem cv.CLAHE — equalizeHist
        // simples é pior (não é adaptativo por região) mas ainda ajuda mais do que nada
        cv.equalizeHist(working, equalized);
      }
      if(ownsWorking) working.delete();
      working = equalized;
      ownsWorking = true;
    }

    if(gradientDomain){
      const gradX = new cv.Mat(), gradY = new cv.Mat();
      const absGradX = new cv.Mat(), absGradY = new cv.Mat();
      const grad = new cv.Mat();
      cv.Sobel(working, gradX, cv.CV_16S, 1, 0, 3);
      cv.Sobel(working, gradY, cv.CV_16S, 0, 1, 3);
      cv.convertScaleAbs(gradX, absGradX);
      cv.convertScaleAbs(gradY, absGradY);
      cv.addWeighted(absGradX, 0.5, absGradY, 0.5, 0, grad);
      [gradX, gradY, absGradX, absGradY].forEach(m=> m.delete());
      if(ownsWorking) working.delete();
      working = grad;
      ownsWorking = true;
    }

    // se nenhum passo foi aplicado, devolve sempre uma cópia — assim o chamador
    // pode fazer sempre .delete() ao resultado sem ter de saber se é o original
    if(!ownsWorking){
      const copy = new cv.Mat();
      working.copyTo(copy);
      return copy;
    }
    return working;
  }

  /* ------------------------------------------------------------
     FASE 2 — MATCHING COM RATIO TEST + CROSS-CHECK (mutual NN)
     ------------------------------------------------------------
     Função partilhada por ORB e AKAZE (ambos produzem KeyPointVector
     + Mat de descritores no mesmo formato, por isso a lógica de
     correspondência é idêntica para os dois).

     matchStrategy:
       'ratio'      — só o ratio test de Lowe (comportamento original)
       'crossCheck' — só mutual nearest-neighbour (1→2 tem de ser
                      também o vizinho mais próximo de 2→1)
       'both'       — ratio test E cross-check (omissão nova) — mais
                      restritivo, mas em pares "difíceis" (muita
                      textura repetida/ambígua) reduz bastante os
                      falsos positivos que só o ratio test deixa
                      passar, o que dá ao RANSAC um conjunto de
                      partida mais limpo.
     ------------------------------------------------------------ */
  function matchDescriptors(cv, desc1, desc2, kp1, kp2, opts){
    const {
      norm = cv.NORM_HAMMING,
      ratioTestThreshold = 0.75, // padrão da literatura (Lowe, 2004)
      matchStrategy = 'both',
      scale1 = 1,
      scale2 = 1
    } = opts || {};

    const matches = [];
    if(desc1.rows === 0 || desc2.rows === 0) return matches;

    const bf = new cv.BFMatcher(norm, false);

    // direção 1→2, sempre com k=2 (precisamos da 2ª melhor hipótese para o ratio test,
    // mesmo quando a estratégia final é só crossCheck, porque também precisamos do
    // melhor match em si)
    const knnMatches12 = new cv.DMatchVectorVector();
    bf.knnMatch(desc1, desc2, knnMatches12, 2);

    const candidates = []; // {queryIdx, trainIdx, distance} — já filtrados por ratio test se aplicável
    for(let i = 0; i < knnMatches12.size(); i++){
      const pair = knnMatches12.get(i);
      if(pair.size() < 2) continue;
      const m = pair.get(0), n = pair.get(1);
      // ratio test de Lowe: só aceita a correspondência se for claramente melhor
      // do que a segunda melhor hipótese — descarta zonas ambíguas/repetitivas
      // (ex. campos agrícolas). Ignorado quando a estratégia é só 'crossCheck'.
      const passesRatio = matchStrategy === 'crossCheck' || m.distance < ratioTestThreshold * n.distance;
      if(passesRatio){
        candidates.push({queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance});
      }
    }
    knnMatches12.delete();

    let finalPairs = candidates;

    if(matchStrategy === 'crossCheck' || matchStrategy === 'both'){
      // direção 2→1: confirma que cada match também é, na direção inversa,
      // o vizinho mais próximo — elimina correspondências "assimétricas"
      // que sobrevivem ao ratio test só porque a imagem 1 tem uma zona
      // ambígua, mas que não são mutuamente consistentes.
      const knnMatches21 = new cv.DMatchVectorVector();
      bf.knnMatch(desc2, desc1, knnMatches21, 1);
      const nearestFrom2 = new Map(); // idx em desc2 -> idx em desc1 mais próximo
      for(let i = 0; i < knnMatches21.size(); i++){
        const pair = knnMatches21.get(i);
        if(pair.size() < 1) continue;
        const m = pair.get(0);
        nearestFrom2.set(m.queryIdx, m.trainIdx);
      }
      knnMatches21.delete();
      finalPairs = candidates.filter(p => nearestFrom2.get(p.trainIdx) === p.queryIdx);
    }

    finalPairs.forEach(p=>{
      const p1 = kp1.get(p.queryIdx).pt;
      const p2 = kp2.get(p.trainIdx).pt;
      // reconverte para o espaço de pixels de CADA imagem tal como recebida
      // (imgEl1/imgEl2) — sem isto, os pontos ficavam no espaço reduzido por
      // maxImageDim sempre que a imagem de entrada era maior do que 1200px,
      // o que desalinhava tudo a partir daqui (buildGcpsFromMatches, RANSAC).
      matches.push({p1: {x: p1.x / scale1, y: p1.y / scale1}, p2: {x: p2.x / scale2, y: p2.y / scale2}, distance: p.distance});
    });

    bf.delete();
    return matches;
  }

  /* ------------------------------------------------------------
     1) DETEÇÃO + CORRESPONDÊNCIA (ORB): rápido, roda bem em WASM,
        com alguma invariância a escala/rotação — importante porque
        a foto aérea e o tile de referência raramente estão à mesma
        escala/orientação exatas. BFMatcher (Hamming, próprio para
        descritores binários) + matchDescriptors (FASE 2, acima).

        imgEl1, imgEl2: elementos <img> ou <canvas> já carregados
        (ex.: a foto a georreferenciar, e um excerto do basemap).

        opts.clahe / opts.gradientDomain (FASE 1): ligados por
        omissão — pensados para o caso ortofoto DGT vs satélite.
        Passa {clahe:false, gradientDomain:false} para o
        comportamento original (imagem de intensidade crua).

        Devolve: [{ p1:{x,y}, p2:{x,y}, distance }, ...]
        em pixels de cada imagem respetivamente.
     ------------------------------------------------------------ */
  async function detectAndMatch(imgEl1, imgEl2, opts){
    const cv = await loadOpenCV();
    await new Promise(resolve => setTimeout(resolve, 0));
    const {
      nFeatures = 1200,      // mais features = mais hipótese de encontrar, mas também mais custo
      ratioTestThreshold = 0.75,
      matchStrategy = 'both',
      maxImageDim = 1200,
      clahe = true,
      gradientDomain = true
    } = opts || {};

    const scale1 = (imgEl1.naturalWidth || imgEl1.width) ? Math.min(1, maxImageDim / Math.max(imgEl1.naturalWidth || imgEl1.width, imgEl1.naturalHeight || imgEl1.height)) : 1;
    const scale2 = (imgEl2.naturalWidth || imgEl2.width) ? Math.min(1, maxImageDim / Math.max(imgEl2.naturalWidth || imgEl2.width, imgEl2.naturalHeight || imgEl2.height)) : 1;
    const source1 = scale1 === 1 ? imgEl1 : imageElementToCanvas(imgEl1, scale1);
    const source2 = scale2 === 1 ? imgEl2 : imageElementToCanvas(imgEl2, scale2);

    const mat1 = cv.imread(source1);
    const mat2 = cv.imread(source2);
    const gray1 = new cv.Mat(); const gray2 = new cv.Mat();
    cv.cvtColor(mat1, gray1, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(mat2, gray2, cv.COLOR_RGBA2GRAY);

    const proc1 = preprocessForMatching(cv, gray1, {clahe, gradientDomain});
    const proc2 = preprocessForMatching(cv, gray2, {clahe, gradientDomain});

    let orb;
    if(typeof cv.ORB?.create === 'function'){
      orb = cv.ORB.create(nFeatures);
    }else if(typeof cv.ORB === 'function'){
      orb = new cv.ORB(nFeatures);
    }else{
      throw new Error('O OpenCV.js não expõe ORB; verifica a versão da biblioteca.');
    }
    const kp1 = new cv.KeyPointVector(); const kp2 = new cv.KeyPointVector();
    const desc1 = new cv.Mat(); const desc2 = new cv.Mat();
    const mask1 = new cv.Mat(); const mask2 = new cv.Mat(); // máscaras vazias = usa a imagem toda; têm de ser apagadas como qualquer outro Mat
    orb.detectAndCompute(proc1, mask1, kp1, desc1);
    orb.detectAndCompute(proc2, mask2, kp2, desc2);

    const matches = matchDescriptors(cv, desc1, desc2, kp1, kp2, {
      norm: cv.NORM_HAMMING, ratioTestThreshold, matchStrategy, scale1, scale2
    });

    [mat1, mat2, gray1, gray2, proc1, proc2, kp1, kp2, desc1, desc2, mask1, mask2].forEach(m=> m.delete());
    orb.delete();

    return matches;
  }

  /* ------------------------------------------------------------
     1b) DETEÇÃO + CORRESPONDÊNCIA (AKAZE) — alternativa ao ORB.
        Usa descritores M-LDB (ainda binários, por isso continua a
        usar NORM_HAMMING no matcher), mas com deteção multi-escala
        interna e melhor tolerância a diferenças de iluminação e
        textura do que o ORB — é a mudança de detector recomendada
        para o caso "ortofoto DGT vs imagery de satélite" descrito
        no plano da FASE 2.

        Mesma assinatura e mesmo formato de devolução que
        detectAndMatch, para poder ser usada de forma intermutável
        (ex. em detectAndMatchEnsemble, abaixo).
     ------------------------------------------------------------ */
  async function detectAndMatchAkaze(imgEl1, imgEl2, opts){
    const cv = await loadOpenCV();
    await new Promise(resolve => setTimeout(resolve, 0));
    const {
      ratioTestThreshold = 0.75,
      matchStrategy = 'both',
      maxImageDim = 1200,
      clahe = true,
      gradientDomain = true
    } = opts || {};

    if(typeof cv.AKAZE?.create !== 'function'){
      throw new Error('O OpenCV.js não expõe AKAZE; verifica a versão/build da biblioteca.');
    }

    const scale1 = (imgEl1.naturalWidth || imgEl1.width) ? Math.min(1, maxImageDim / Math.max(imgEl1.naturalWidth || imgEl1.width, imgEl1.naturalHeight || imgEl1.height)) : 1;
    const scale2 = (imgEl2.naturalWidth || imgEl2.width) ? Math.min(1, maxImageDim / Math.max(imgEl2.naturalWidth || imgEl2.width, imgEl2.naturalHeight || imgEl2.height)) : 1;
    const source1 = scale1 === 1 ? imgEl1 : imageElementToCanvas(imgEl1, scale1);
    const source2 = scale2 === 1 ? imgEl2 : imageElementToCanvas(imgEl2, scale2);

    const mat1 = cv.imread(source1);
    const mat2 = cv.imread(source2);
    const gray1 = new cv.Mat(); const gray2 = new cv.Mat();
    cv.cvtColor(mat1, gray1, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(mat2, gray2, cv.COLOR_RGBA2GRAY);

    const proc1 = preprocessForMatching(cv, gray1, {clahe, gradientDomain});
    const proc2 = preprocessForMatching(cv, gray2, {clahe, gradientDomain});

    const akaze = cv.AKAZE.create();
    const kp1 = new cv.KeyPointVector(); const kp2 = new cv.KeyPointVector();
    const desc1 = new cv.Mat(); const desc2 = new cv.Mat();
    const mask1 = new cv.Mat(); const mask2 = new cv.Mat(); // máscaras vazias = usa a imagem toda; têm de ser apagadas como qualquer outro Mat
    akaze.detectAndCompute(proc1, mask1, kp1, desc1);
    akaze.detectAndCompute(proc2, mask2, kp2, desc2);

    const matches = matchDescriptors(cv, desc1, desc2, kp1, kp2, {
      norm: cv.NORM_HAMMING, ratioTestThreshold, matchStrategy, scale1, scale2
    });

    [mat1, mat2, gray1, gray2, proc1, proc2, kp1, kp2, desc1, desc2, mask1, mask2].forEach(m=> m.delete());
    akaze.delete();

    return matches;
  }

  /* ------------------------------------------------------------
     1c) Corre ORB e AKAZE sobre o mesmo par de imagens e devolve os
         dois conjuntos de matches em bruto (sem RANSAC ainda) — usado
         por detectAndMatchEnsemble e por detectAndMatchMultiScale,
         para não duplicar a lógica de "correr os dois detectores"
         nos dois sítios.

         Se um detector falhar (ex. build sem AKAZE), o outro
         continua a funcionar — só regista o aviso na consola.
     ------------------------------------------------------------ */
  async function detectMatchesAllDetectors(imgEl1, imgEl2, opts){
    const result = {};
    try{
      result.orb = await detectAndMatch(imgEl1, imgEl2, opts);
    }catch(err){
      console.warn('[AutoGeoref] deteção ORB falhou:', err);
      result.orb = [];
    }
    try{
      result.akaze = await detectAndMatchAkaze(imgEl1, imgEl2, opts);
    }catch(err){
      console.warn('[AutoGeoref] deteção AKAZE falhou:', err);
      result.akaze = [];
    }
    return result;
  }

  /* ------------------------------------------------------------
     1d) ENSEMBLE: corre ORB e AKAZE, ajusta RANSAC a cada um
         separadamente, e fica com o resultado com mais inliers.
         Mais lento do que um único detector, mas mais robusto —
         cobre casos em que um dos dois falha nalgum tipo de imagem
         mas o outro não.
     ------------------------------------------------------------ */
  async function detectAndMatchEnsemble(imgEl1, imgEl2, opts){
    const detectOpts = (opts && opts.detect) || opts;
    const ransacOpts = opts && opts.ransac;

    const raw = await detectMatchesAllDetectors(imgEl1, imgEl2, detectOpts);

    const results = [];
    for(const detector of ['orb', 'akaze']){
      const matches = raw[detector] || [];
      if(matches.length < 3) continue;
      try{
        const ransacResult = await ransacAffine(matches, ransacOpts);
        if(ransacResult.success){
          results.push({detector, matches, ...ransacResult});
        }
      }catch(err){
        console.warn(`[AutoGeoref] ensemble: RANSAC falhou para ${detector}:`, err);
      }
    }

    if(results.length === 0){
      return {
        success: false,
        reason: 'Nem ORB nem AKAZE encontraram um modelo fiável entre as imagens.',
        detectorsAttempted: ['orb', 'akaze']
      };
    }

    results.sort((a, b)=> (b.inlierCount - a.inlierCount) || (b.inlierRatio - a.inlierRatio));
    const best = results[0];

    return {
      success: true,
      detector: best.detector,
      matches: best.matches,
      transform: best.transform,
      inlierIdx: best.inlierIdx,
      inlierCount: best.inlierCount,
      totalMatches: best.totalMatches,
      inlierRatio: best.inlierRatio,
      rmsPx: best.rmsPx,
      allResults: results.map(r=> ({detector: r.detector, inlierCount: r.inlierCount, inlierRatio: r.inlierRatio, totalMatches: r.totalMatches}))
    };
  }

  /* ------------------------------------------------------------
     2) AJUSTE ROBUSTO: RANSAC sobre uma transformação afim.
        A maioria dos matches do ORB vai estar errada (falsos
        positivos, texturas repetidas, etc.) — RANSAC encontra o
        maior subconjunto de matches consistente com UM modelo afim
        (os "inliers"), ignorando o resto, e no fim reajusta esse
        modelo com mínimos quadrados só sobre os inliers.

        Reaproveita Georef.solveAffineLeastSquares (11-georef.js)
        tal como está — é genérico a qualquer unidade, por isso
        tanto serve para pixel→lat/lng (uso original) como aqui
        para pixel→pixel entre as duas imagens.
     ------------------------------------------------------------ */
  async function ransacAffine(matches, opts){
    if(typeof Georef === 'undefined' || !Georef.solveAffineLeastSquares){
      throw new Error('Georef.solveAffineLeastSquares (11-georef.js) não está disponível — este módulo depende dele.');
    }
    const {
      iterations = 180,
      inlierThresholdPx = 6,   // tolerância, em pixels da imagem 2, para contar como inlier
      minInliers = 8,          // abaixo disto, não há confiança suficiente no resultado
      timeoutMs = 2200         // evita bloquear o browser demasiado tempo
    } = opts || {};

    if(matches.length < 3){
      return {success: false, reason: 'Menos de 3 correspondências — impossível calcular uma transformação afim.'};
    }

    const startTime = performance.now();

    // adapta os matches ao formato esperado pelo solver: {img:{x,y}, map:{lng,lat}}
    // (aqui "map" é só a imagem 2, não coordenadas geográficas reais)
    const toGcpFormat = (m)=> ({img: m.p1, map: {lng: m.p2.x, lat: m.p2.y}});

    let best = {inlierCount: -1, inlierIdx: null, transform: null};

    for(let iter = 0; iter < iterations; iter++){
      if(iter % 20 === 0){
        await new Promise(resolve => setTimeout(resolve, 0));
        if(performance.now() - startTime > timeoutMs){
          break;
        }
      }

      // amostra mínima de 3 pontos distintos
      const sampleIdx = sampleThreeDistinctIndices(matches.length);
      const sample = sampleIdx.map(i => toGcpFormat(matches[i]));

      let candidate;
      try{ candidate = Georef.solveAffineLeastSquares(sample); }
      catch(err){ continue; } // pontos colineares na amostra — tenta outra

      // conta inliers: matches cujo erro de reprojeção fica dentro da tolerância
      const inlierIdx = [];
      for(let i = 0; i < matches.length; i++){
        const m = matches[i];
        const predX = candidate.a*m.p1.x + candidate.b*m.p1.y + candidate.c;
        const predY = candidate.d*m.p1.x + candidate.e*m.p1.y + candidate.f;
        const err = Math.hypot(predX - m.p2.x, predY - m.p2.y);
        if(err <= inlierThresholdPx) inlierIdx.push(i);
      }

      if(inlierIdx.length > best.inlierCount){
        best = {inlierCount: inlierIdx.length, inlierIdx, transform: candidate};
      }
    }

    if(best.inlierCount < minInliers){
      return {
        success: false,
        reason: `Só ${Math.max(best.inlierCount,0)} inliers encontrados (mínimo exigido: ${minInliers}) — provavelmente as duas imagens não têm sobreposição suficiente ou são de zonas/épocas demasiado diferentes.`,
        inlierCount: best.inlierCount,
        totalMatches: matches.length
      };
    }

    // reajuste final: mínimos quadrados só sobre os inliers do melhor modelo,
    // em vez de ficar com o ajuste "exato" da amostra mínima de 3 pontos
    const inlierGcps = best.inlierIdx.map(i => toGcpFormat(matches[i]));
    const refined = Georef.solveAffineLeastSquares(inlierGcps);

    return {
      success: true,
      transform: refined,
      inlierIdx: best.inlierIdx,
      inlierCount: best.inlierCount,
      totalMatches: matches.length,
      inlierRatio: best.inlierCount / matches.length,
      rmsPx: refined.rms // aqui "rms" está em pixels da imagem 2, não graus
    };
  }

  function sampleThreeDistinctIndices(n){
    const idx = new Set();
    while(idx.size < 3){ idx.add(Math.floor(Math.random() * n)); }
    return Array.from(idx);
  }

  /* ------------------------------------------------------------
     3) SPIKE MANUAL — a correr à mão na consola, com duas imagens
        já no DOM (ex.: <img id="foto-aerea"> e <img id="tile-dgt">),
        para responder à pergunta central deste spike: "isto sequer
        encontra correspondências fiáveis?"

        Uso (na consola, com as duas imagens carregadas na página):

          AutoGeoref.spikeTest(
            document.getElementById('foto-aerea'),
            document.getElementById('tile-dgt')
          ).then(r => console.log(r));

        Por omissão usa o ENSEMBLE (ORB + AKAZE, FASE 2) com pré-
        processamento CLAHE + gradiente (FASE 1) — passa
        { ensemble: { detect: {clahe:false, gradientDomain:false} } ...
        na prática, para comparar com o comportamento antigo, o mais
        simples é chamar diretamente AutoGeoref.detectAndMatch(...) +
        AutoGeoref.ransacAffine(...) à mão, ou passar
        opts.useSingleDetector = 'orb' aqui para forçar só ORB sem
        pré-processamento novo.

        Devolve o resultado do RANSAC (ver ransacAffine/
        detectAndMatchEnsemble acima) e, se tiver sucesso, desenha as
        correspondências inlier num canvas temporário anexado ao
        body, para inspeção visual — a forma mais rápida de confirmar
        que os pontos fazem sentido antes de confiar numa única
        métrica (RMS/nº de inliers).
     ------------------------------------------------------------ */
  async function spikeTest(imgEl1, imgEl2, opts){
    console.log('[AutoGeoref spike] a carregar OpenCV.js (pode demorar — WASM grande, compila na thread principal)…');
    try{
      await loadOpenCV();
    }catch(err){
      console.error('[AutoGeoref spike] falha a carregar o OpenCV.js:', err.message);
      throw err;
    }
    console.log('[AutoGeoref spike] OpenCV.js pronto.');

    const useSingleDetector = opts && opts.useSingleDetector; // 'orb' | 'akaze' | undefined
    let matches, result;

    if(useSingleDetector){
      console.log(`[AutoGeoref spike] a detetar e a corresponder features (${useSingleDetector.toUpperCase()})…`);
      const detectFn = useSingleDetector === 'akaze' ? detectAndMatchAkaze : detectAndMatch;
      matches = await detectFn(imgEl1, imgEl2, opts && opts.detect);
      console.log(`[AutoGeoref spike] ${matches.length} correspondências candidatas.`);

      if(matches.length < 3){
        console.warn('[AutoGeoref spike] correspondências insuficientes — as imagens podem não ter sobreposição visível.');
        return {success: false, reason: 'Correspondências insuficientes.', totalMatches: matches.length};
      }

      console.log('[AutoGeoref spike] a ajustar transformação afim com RANSAC…');
      result = await ransacAffine(matches, opts && opts.ransac);
      result = result.success ? {...result, detector: useSingleDetector} : result;
    } else {
      console.log('[AutoGeoref spike] a detetar e a corresponder features (ensemble ORB + AKAZE, com CLAHE + gradiente)…');
      result = await detectAndMatchEnsemble(imgEl1, imgEl2, opts);
      matches = result.matches || [];
      if(result.success){
        console.log('[AutoGeoref spike] resultados por detector:', result.allResults);
      }
    }

    if(!result.success){
      console.warn('[AutoGeoref spike] não foi encontrado um modelo fiável:', result.reason);
      return result;
    }

    console.log(`[AutoGeoref spike] sucesso com ${result.detector.toUpperCase()}: ${result.inlierCount}/${result.totalMatches} inliers (${(result.inlierRatio*100).toFixed(0)}%), RMS ${result.rmsPx.toFixed(2)}px.`);
    console.log('[AutoGeoref spike] transformação afim (pixel imagem 1 → pixel imagem 2):', result.transform);

    drawMatchesDebugCanvas(imgEl1, imgEl2, matches, result);

    return result;
  }

  /* desenha as duas imagens lado a lado com linhas entre correspondências
     (verde = inlier aceite pelo RANSAC, vermelho ténue = descartado) —
     só para inspeção visual manual, remove-se sozinho ao fim de 30s */
  function drawMatchesDebugCanvas(imgEl1, imgEl2, matches, result){
    const w1 = imgEl1.naturalWidth || imgEl1.width, h1 = imgEl1.naturalHeight || imgEl1.height;
    const w2 = imgEl2.naturalWidth || imgEl2.width, h2 = imgEl2.naturalHeight || imgEl2.height;
    const scale = Math.min(1, 700 / Math.max(w1, w2));

    const canvas = document.createElement('canvas');
    canvas.width = (w1 + w2) * scale;
    canvas.height = Math.max(h1, h2) * scale;
    canvas.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;border:2px solid #3c5a45;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:90vw;';
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl1, 0, 0, w1*scale, h1*scale);
    ctx.drawImage(imgEl2, w1*scale, 0, w2*scale, h2*scale);

    const inlierSet = new Set(result.inlierIdx || []);
    matches.forEach((m, i)=>{
      const isInlier = inlierSet.has(i);
      ctx.strokeStyle = isInlier ? 'rgba(60,90,69,0.9)' : 'rgba(200,60,60,0.15)';
      ctx.lineWidth = isInlier ? 1.5 : 0.5;
      ctx.beginPath();
      ctx.moveTo(m.p1.x*scale, m.p1.y*scale);
      ctx.lineTo(w1*scale + m.p2.x*scale, m.p2.y*scale);
      ctx.stroke();
    });

    document.body.appendChild(canvas);
    setTimeout(()=> canvas.remove(), 30000);
    console.log('[AutoGeoref spike] canvas de depuração anexado ao body (canto superior direito, some em 30s).');
  }

  /* ------------------------------------------------------------
     4) MULTIESCALA: tenta a deteção em várias versões escaladas da
        imagem que se quer georreferenciar, para lidar com fotos aéreas
        de resolução muito diferente do tile de referência. Mantém o
        melhor resultado em função do número de inliers.
     ------------------------------------------------------------ */
  function imageElementToCanvas(imgEl, scale){
    const width = Math.round((imgEl.naturalWidth || imgEl.width) * scale);
    const height = Math.round((imgEl.naturalHeight || imgEl.height) * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, width, height);
    return canvas;
  }

  async function detectAndMatchMultiScale(imgEl1, imgEl2, opts){
    const scales = Array.isArray(opts && opts.scales) ? opts.scales : [0.5, 0.75, 1];
    // FASE 2: por omissão, cada escala é tentada com ORB E com AKAZE (ver
    // detectMatchesAllDetectors) — mais lento, mas cobre o caso em que um dos
    // dois detectores simplesmente não encontra nada naquele par de imagens
    // (ex. AKAZE costuma aguentar melhor diferenças de iluminação/sensor do
    // que o ORB). Passa opts.ensemble = false para voltar ao comportamento
    // antigo (só ORB, mais rápido) se precisares de comparar/depurar.
    const useEnsemble = !opts || opts.ensemble !== false;
    let best = null;

    for(const scale of scales){
      const scaledImg = scale === 1 ? imgEl1 : imageElementToCanvas(imgEl1, scale);

      let detectorMatches;
      try{
        detectorMatches = useEnsemble
          ? await detectMatchesAllDetectors(scaledImg, imgEl2, opts)
          : { orb: await detectAndMatch(scaledImg, imgEl2, opts) };
      }catch(err){
        console.warn('[AutoGeoref] falha na deteção, escala', scale, err);
        continue;
      }

      for(const detector of Object.keys(detectorMatches)){
        const rawMatches = detectorMatches[detector];
        if(!rawMatches || rawMatches.length < 3){
          await new Promise(resolve => setTimeout(resolve, 0));
          continue;
        }

        const scaledMatches = scale === 1 ? rawMatches : rawMatches.map(m=>({
          p1: { x: m.p1.x / scale, y: m.p1.y / scale },
          p2: m.p2,
          distance: m.distance
        }));

        try{
          const result = await ransacAffine(scaledMatches, opts && opts.ransac);
          if(!result.success){
            await new Promise(resolve => setTimeout(resolve, 0));
            continue;
          }

          const candidate = {
            success: true,
            scale,
            detector,
            matches: scaledMatches,
            inlierIdx: result.inlierIdx,
            inlierCount: result.inlierCount,
            totalMatches: result.totalMatches,
            inlierRatio: result.inlierRatio,
            rmsPx: result.rmsPx,
            transform: result.transform
          };

          if(!best || candidate.inlierCount > best.inlierCount ||
             (candidate.inlierCount === best.inlierCount && candidate.inlierRatio > best.inlierRatio)){
            best = candidate;
          }
        }catch(err){
          console.warn('[AutoGeoref] falha no RANSAC, escala', scale, 'detector', detector, err);
        }
      }
    }

    return best;
  }

  function pixelPointToLatLng(point, bounds, tileSize){
    if(!bounds || !tileSize || !Number.isFinite(tileSize.width) || !Number.isFinite(tileSize.height)){
      throw new Error('É necessário informar os limites do tile e o tamanho em pixels.');
    }
    const west = bounds.west;
    const east = bounds.east;
    const north = bounds.north;
    const south = bounds.south;

    const lng = west + (point.x / tileSize.width) * (east - west);
    const lat = north + (point.y / tileSize.height) * (south - north);
    return { lng, lat };
  }

  function buildGcpsFromMatches(matches, inlierIdx, refBounds, tileSize){
    const inliers = inlierIdx.map(i => matches[i]);
    return inliers.map((m, index) => ({
      img: { x: m.p1.x, y: m.p1.y },
      map: pixelPointToLatLng(m.p2, refBounds, tileSize),
      source: 'auto',
      index: index + 1
    }));
  }

  function publishGcpsToUI(gcps, info){
    if(typeof window.renderGeorefGCPList === 'function'){
      window.renderGeorefGCPList(gcps, info);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------
     5) autoGeoref — ponto de entrada público, usado por
        05-app-main.js (runAutoGeorefDetection). Corre a deteção
        num Web Worker dedicado (12b-autogeoref-worker.js) em vez de
        na main thread: o OpenCV.js compila ~8-10MB de WASM de forma
        SÍNCRONA, e fazer isso aqui prendia a página inteira (nem a
        consola abria) durante a compilação + deteção ORB + RANSAC.
        As funções acima (loadOpenCV, detectAndMatch,
        detectAndMatchMultiScale, ransacAffine) continuam
        disponíveis para spikes manuais na consola — só deixaram de
        ser o caminho usado automaticamente pela app.
     ------------------------------------------------------------ */
  // Cache-buster: `new Worker(url)` fica sujeito ao cache HTTP normal do
  // browser/Electron, que por vezes sobrevive a um reload simples da janela
  // (foi o que aconteceu ao testar a Fase B — o worker antigo continuou a
  // correr mesmo depois do ficheiro ter sido substituído no disco). Ao
  // incluir uma query string de versão, cada alteração a este ficheiro tem
  // de vir acompanhada de um bump aqui para o browser ser obrigado a pedir
  // o ficheiro de novo — sem isto, uma alteração ao worker pode nunca
  // chegar a correr até a pessoa limpar o cache manualmente.
  const AUTOGEOREF_WORKER_VERSION = '2025-fase-b-equalizacao';
  const AUTOGEOREF_WORKER_URL = 'js/12b-autogeoref-worker.js?v=' + encodeURIComponent(AUTOGEOREF_WORKER_VERSION);
  // Valor de produção. Com o opencv.js self-hosted em js/vendor/opencv.js
  // (ver 12b-autogeoref-worker.js), o caso normal carrega em poucos segundos;
  // 120s dá margem real para dispositivos lentos sem deixar o utilizador à
  // espera de 10 minutos como no valor de diagnóstico anterior.
  const AUTOGEOREF_REQUEST_TIMEOUT_MS = 120000;
  let autoGeorefWorker = null;
  let autoGeorefReqSeq = 1;
  const pendingAutoGeorefRequests = new Map(); // id -> {resolve, reject, onMessage}

  function rejectAllPendingAutoGeorefRequests(err){
    pendingAutoGeorefRequests.forEach(({reject, onMessage})=>{
      if(autoGeorefWorker) autoGeorefWorker.removeEventListener('message', onMessage);
      reject(err);
    });
    pendingAutoGeorefRequests.clear();
  }

  function getAutoGeorefWorker(){
    if(!autoGeorefWorker){
      try{
        autoGeorefWorker = new Worker(AUTOGEOREF_WORKER_URL);
      }catch(err){
        throw new Error('Não foi possível iniciar o worker de autogeoreferenciação (' + AUTOGEOREF_WORKER_URL + '): ' + err.message);
      }
      // sem isto, um worker que falhe a carregar (404, erro de sintaxe, CSP a
      // bloquear o importScripts do OpenCV.js lá dentro) fica completamente
      // silencioso e qualquer pedido pendente fica preso para sempre.
      autoGeorefWorker.addEventListener('error', (evt)=>{
        console.error('[AutoGeoref] erro no worker de autogeoreferenciação:', evt.message || evt);
        rejectAllPendingAutoGeorefRequests(new Error(
          'O worker de autogeoreferenciação falhou a carregar (' + AUTOGEOREF_WORKER_URL + '). ' +
          'Confirma que o ficheiro está publicado nesse caminho. Detalhe: ' + (evt.message || 'erro desconhecido')
        ));
        try{ autoGeorefWorker.terminate(); }catch(e){}
        autoGeorefWorker = null;
      });
    }
    return autoGeorefWorker;
  }

  /* ------------------------------------------------------------
     WARM-UP: arranca o worker e pede-lhe para começar já a carregar
     o OpenCV.js, SEM fazer nenhuma deteção. Chamado a partir de
     enterGeorefMode (05-app-main.js) — ou seja, no momento em que o
     utilizador entra no modo de georreferenciação, não no clique em
     "Autogeoreferenciar". Isto esconde a latência de rede/compilação:
     enquanto a pessoa está a aproximar o mapa e a escolher a imagem
     (normalmente vários segundos), o OpenCV já está a compilar em
     paralelo, e quando ela clica no botão o worker já está pronto ou
     quase pronto — em vez de só aí começar a carregar 1-10MB.
     Falhas aqui são engolidas silenciosamente (só um aviso na
     consola): o warm-up é uma otimização, não algo de que o resto do
     fluxo dependa — se falhar, runAutoGeorefDetection tenta o
     carregamento normal (com timeout e mensagens de erro) na mesma.
     ------------------------------------------------------------ */
  let warmUpStarted = false;
  function warmUp(){
    if(warmUpStarted) return;
    warmUpStarted = true;
    try{
      const worker = getAutoGeorefWorker();
      worker.postMessage({type:'warmup'});
    }catch(err){
      console.warn('[AutoGeoref] warm-up falhou (sem impacto — o carregamento normal tenta de novo):', err);
      warmUpStarted = false; // permite tentar de novo na próxima entrada em modo georref
    }
  }

  function requestAutoGeorefFromWorker({imgBitmap, refBitmap, refTileBounds, refTileSize, opts}, onStatus){
    const worker = getAutoGeorefWorker();
    const id = autoGeorefReqSeq++;

    return new Promise((resolve, reject)=>{
      const timeoutTimer = setTimeout(()=>{
        pendingAutoGeorefRequests.delete(id);
        worker.removeEventListener('message', onMessage);
        reject(new Error(`Sem resposta do worker em ${AUTOGEOREF_REQUEST_TIMEOUT_MS/1000}s — provavelmente o OpenCV.js não carregou (rede/CSP). Confirma a consola.`));
      }, AUTOGEOREF_REQUEST_TIMEOUT_MS);

      function settle(fn, arg){
        clearTimeout(timeoutTimer);
        pendingAutoGeorefRequests.delete(id);
        worker.removeEventListener('message', onMessage);
        fn(arg);
      }

      function onMessage(evt){
        const msg = evt.data;
        if(!msg || msg.id !== id) return;
        if(msg.type === 'status'){
          // o heartbeat só serve para confirmar que a thread do worker
          // ainda está viva (ver 12b-autogeoref-worker.js); se for mostrado
          // na UI a cada 1s, tapa as mensagens [timing]/de progresso reais
          // que é precisamente o que precisamos de ver para diagnosticar
          // onde é que o pipeline está a demorar.
          if(typeof msg.text === 'string' && msg.text.indexOf('heartbeat ') === 0){
            // console.debug fica ESCONDIDO por omissão no filtro da consola do
            // Chrome (só aparece com "Verbose" ligado) — por isso passa a
            // console.log: precisamos de ver isto sem depender de o utilizador
            // saber mexer no filtro de nível de log.
            console.log('[AutoGeoref] worker vivo —', msg.text);
          } else {
            console.log('[AutoGeoref]', msg.text);
            onStatus && onStatus(msg.text);
          }
        } else if(msg.type === 'done'){
          settle(resolve, msg);
        } else if(msg.type === 'error'){
          settle(reject, new Error(msg.message));
        }
      }

      pendingAutoGeorefRequests.set(id, {resolve: v=>settle(resolve, v), reject: e=>settle(reject, e), onMessage});
      worker.addEventListener('message', onMessage);

      try{
        worker.postMessage(
          {type:'detect', id, imgBitmap, refBitmap, refTileBounds, refTileSize, opts},
          [imgBitmap, refBitmap]
        );
      }catch(err){
        settle(reject, new Error('Falha ao enviar as imagens para o worker: ' + err.message));
      }
    });
  }

  /* ------------------------------------------------------------
     LIMITE DE SEGURANÇA: fotos aéreas/scans usados para georreferenciar
     podem facilmente ter dezenas de megapixels (ex.: 8000x6000). Sem
     isto, `createImageBitmap(imgEl)` abaixo decodifica a imagem TODA
     em memória, esse bitmap gigante é transferido para o worker, e lá
     dentro é redesenhado + lido pixel a pixel (getImageData) em MAIS
     do que uma escala antes de finalmente ser reduzido a maxImageDim
     (1200px) — o que pode consumir centenas de MB a GB e prender a
     página inteira só a fazer downscale de algo que no fim de contas
     vai ser reduzido de qualquer forma. Ao limitar aqui, ANTES de criar
     o ImageBitmap, o resto do pipeline nunca vê a resolução original.
     ------------------------------------------------------------ */
  const AUTOGEOREF_MAX_INPUT_DIM = 2400;
  function capImageElementSize(imgEl, maxDim){
    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;
    if(!w || !h || Math.max(w, h) <= maxDim) return imgEl;
    const scale = maxDim / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function autoGeoref(imgEl, refEl, refTileBounds, refTileSize, opts, onStatus){
    if(!imgEl || !refEl || !refTileBounds || !refTileSize){
      throw new Error('Parâmetros obrigatórios: imgEl, refEl, refTileBounds, refTileSize.');
    }

    const cappedImgSource = capImageElementSize(imgEl, AUTOGEOREF_MAX_INPUT_DIM);

    onStatus && onStatus('A preparar imagens…');
    const [imgBitmap, refBitmap] = await Promise.all([
      createImageBitmap(cappedImgSource),
      createImageBitmap(refEl)
    ]);

    /* Se a imagem foi encaixotada para AUTOGEOREF_MAX_INPUT_DIM, os keypoints
       e GCPs do worker ficam no espaço de pixels encaixotados — mas o overlay
       usa as dimensões originais (entry.width/entry.height). Escalamos os
       GCPs img de volta para o espaço original para que o transform afim
       resultante seja coerente com as dimensões do raster. */
    const origW = imgEl.naturalWidth || imgEl.width;
    const origH = imgEl.naturalHeight || imgEl.height;
    const scaleX = (imgBitmap.width && imgBitmap.width !== origW) ? origW / imgBitmap.width : 1;
    const scaleY = (imgBitmap.height && imgBitmap.height !== origH) ? origH / imgBitmap.height : 1;

    const msg = await requestAutoGeorefFromWorker({imgBitmap, refBitmap, refTileBounds, refTileSize, opts}, onStatus);

    if(!msg.success){
      return { success: false, reason: msg.reason || 'Não foi possível encontrar um modelo fiável entre as imagens.' };
    }

    const scaledGcps = (scaleX === 1 && scaleY === 1) ? msg.gcps : msg.gcps.map(g => ({
      ...g,
      img: { x: g.img.x * scaleX, y: g.img.y * scaleY }
    }));

    const published = publishGcpsToUI(scaledGcps, msg.quality);
    return {
      success: true,
      gcps: scaledGcps,
      quality: msg.quality,
      publishedToUI: published
    };
  }

  window.AutoGeoref = {
    loadOpenCV,
    preprocessForMatching,
    matchDescriptors,
    detectAndMatch,
    detectAndMatchAkaze,
    detectMatchesAllDetectors,
    detectAndMatchEnsemble,
    detectAndMatchMultiScale,
    ransacAffine,
    autoGeoref,
    warmUp,
    spikeTest,
    pixelPointToLatLng,
    buildGcpsFromMatches,
    publishGcpsToUI
  };

})();
