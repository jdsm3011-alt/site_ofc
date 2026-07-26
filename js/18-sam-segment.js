/* FeatherGIS — Segment Anything (SAM) via ONNX Runtime Web (main thread)
   Clique → captura → worker (SAM) → contorno → polígono no mapa
   ============================================================
   O encoder/decoder ONNX corre num Web Worker dedicado
   (18b-sam-segment-worker.js), NAO aqui. ANTES tudo corria nesta thread
   (captura + inferencia + pos-processamento) e o browser ficava
   completamente irresponsivo durante a segmentacao (single-thread do JS +
   um ViT-B a 1024x1024 e' pesado). AGORA esta thread so' trata de DOM/
   Leaflet (captura via html2canvas, que precisa de DOM e por isso NAO pode
   correr no worker) e de orquestrar pedidos ao worker por postMessage --
   toda a computacao pesada (encoder.run, decoder.run, limpeza morfologica,
   tracado de contorno) corre la', deixando esta thread livre para pintar
   e reagir a cliques durante o processamento.
*/
(function(){
  'use strict';

  // ========== Estado ==========
  var active = false;
  var overlayEl = null;
  var overlayGuide = null;
  var LOADED = false; // refletido a partir da mensagem 'modelsLoaded' do worker

  /* Metadados da vista atualmente codificada (o embedding em si fica no
     worker, nunca vem para aqui -- ver VIEW_CACHE em 18b-sam-segment-
     worker.js). Serve para 1) decidir se um novo clique pode reaproveitar
     a vista ja codificada (mesmos bounds/zoom) e 2) converter os pontos
     que o worker devolve (em pixels do canvas) para lat/lng.
     Campos: { previewCanvas, previewScale, w, h, bounds, zoom }. */
  var VIEW_META = null;
  var processingClick = false; // evita dois cliques a processar em simultaneo
  var mapInvalidateHandler = null; // listener movestart/zoomstart p/ invalidar VIEW_META

  /* O botão da Vetorização Assistida só existe visualmente enquanto
     #map tem a classe "pm-toolbar-visible" (ver css/pm-toolbar.css --
     o botão vive no mesmo grupo da toolbar de edição do Geoman). Se
     essa classe for removida por qualquer motivo (fechar a toolbar de
     edição, por exemplo) enquanto o modo SAM ainda está ativo, o botão
     desaparece e deixa de haver forma de clicar para desligar -- só
     restava a tecla Esc. Este observer garante que o próprio modo se
     desativa sozinho nesse caso, em vez de depender de o utilizador
     saber que o Esc ainda funciona. */
  var toolbarVisibilityObserver = null;

  function ensureToolbarVisibilityObserver(){
    if(toolbarVisibilityObserver) return;
    var mapDiv = document.getElementById('map');
    if(!mapDiv || typeof MutationObserver === 'undefined') return;
    toolbarVisibilityObserver = new MutationObserver(function(){
      if(active && !mapDiv.classList.contains('pm-toolbar-visible')){
        if(typeof __console !== 'undefined'){
          __console.log('SAM: toolbar de edição fechada -- a desativar a Vetorização Assistida automaticamente.', 'info');
        }
        deactivate();
      }
    });
    toolbarVisibilityObserver.observe(mapDiv, { attributes: true, attributeFilter: ['class'] });
  }

  // ========== Worker + protocolo de mensagens ==========
  var samWorker = null;
  var pendingRequests = {}; // reqId -> {resolve, reject}
  var nextReqId = 1;

  function ensureWorker(){
    if(!samWorker){
      samWorker = new Worker('js/18b-sam-segment-worker.js');
      samWorker.onmessage = onWorkerMessage;
      samWorker.onerror = function(e){
        var errMsg = e && e.message ? e.message : 'Erro desconhecido no worker SAM.';
        if(typeof __console !== 'undefined') __console.log('SAM: erro no worker: ' + errMsg, 'error');
        // Nenhum pedido pendente vai ser respondido -- rejeitar todos para nao ficarem presos.
        Object.keys(pendingRequests).forEach(function(id){
          pendingRequests[id].reject(new Error(errMsg));
          delete pendingRequests[id];
        });
      };
    }
    return samWorker;
  }

  function onWorkerMessage(e){
    var msg = e.data;
    if(msg.type === 'log'){
      if(typeof __console !== 'undefined') __console.log('SAM: ' + msg.text, msg.level || 'info');
      return;
    }
    if(msg.type === 'progress'){
      if(typeof __console !== 'undefined') __console.log('SAM: ' + msg.text, 'info');
      return;
    }
    if(msg.type === 'modelsLoaded'){
      LOADED = true;
      return;
    }
    // Respostas a pedidos concretos (encodeView/decodeClick) tem reqId.
    var pending = pendingRequests[msg.reqId];
    if(!pending) return;
    delete pendingRequests[msg.reqId];
    if(msg.type === 'error') pending.reject(new Error(msg.message));
    else pending.resolve(msg);
  }

  // Envia um pedido ao worker e devolve uma Promise que resolve/rejeita
  // quando a resposta com o mesmo reqId chegar (ver onWorkerMessage).
  function callWorker(payload, transferList){
    return new Promise(function(resolve, reject){
      var reqId = nextReqId++;
      pendingRequests[reqId] = { resolve: resolve, reject: reject };
      payload.reqId = reqId;
      ensureWorker().postMessage(payload, transferList || []);
    });
  }

  function loadModels(){
    ensureWorker().postMessage({ type: 'loadModels' });
  }

  // ========== API pública ==========
  window.__sam = {
    get active(){ return active; },
    get loaded(){ return LOADED; },
    activate: activate,
    deactivate: deactivate,
    load: loadModels,
  };

  // ========== Ativar / desativar modo SAM ==========
  /* Basemap CORS-safe exigido pela captura via html2canvas (ver
     ensureEmbedding/isCanvasBlank) -- 'dgt' (Ortos2021,
     cartografia.dgterritorio.gov.pt) nao envia cabecalhos CORS, pelo que
     qualquer captura feita com esse basemap ativo fica em branco. Ha
     ainda o agravante da troca automatica satelite<->dgt por zoom
     (maybeAutoSwitchBasemap em 05-app-main.js, ativa >=zoom 17 dentro de
     Portugal) -- exatamente o nivel de zoom tipico para traçar um
     edificio -- o que explicava os resultados inconsistentes: a mesma
     sessao podia comecar no satelite e trocar sozinha para dgt mesmo a
     meio do trabalho. */
  var SAM_REQUIRED_BASEMAP = 'satelite';

  function activate(){
    if(active) return;
    loadModels(); // fire-and-forget -- o worker debate internamente se ja esta LOADED/LOADING
    active = true;
    if(typeof window.dispatchEvent === 'function'){
      window.dispatchEvent(new CustomEvent('sam:state', { detail: { active: true } }));
    }

    // Forçar o basemap CORS-safe e desligar a troca automatica por zoom.
    // ANTES: só se chamava __forceBasemap quando o basemap ainda NAO era
    // "satelite" -- mas se já estava em "satelite" no momento do clique
    // no botão SAM, a resolução automática (maybeAutoSwitchBasemap,
    // 05-app-main.js) ficava LIGADA na mesma, e disparava sozinha assim
    // que se desse zoom >=17 para acertar no edifício -- exatamente o
    // que se estava a passar aqui. AGORA chama-se sempre, independente-
    // mente do basemap atual, porque o que importa nao e' só trocar de
    // basemap uma vez, e' garantir que a resolução automática fica
    // desligada durante toda a sessao de SAM.
    if(typeof window.__forceBasemap === 'function'){
      var wasBasemap = window.__activeBaseLayerKey;
      window.__forceBasemap(SAM_REQUIRED_BASEMAP);
      if(typeof __console !== 'undefined'){
        __console.log('SAM: basemap fixado em "satelite" (CORS-safe) e resolução automática desligada para toda a sessão' +
          (wasBasemap !== SAM_REQUIRED_BASEMAP ? ' (trocou de "' + wasBasemap + '")' : ' (já estava em "satelite")') + '.', 'info');
      }
    } else if(typeof __console !== 'undefined'){
      __console.log('SAM: aviso -- window.__forceBasemap não encontrado; o ficheiro 05-app-main.js pode não estar atualizado. A captura pode falhar se o basemap ativo for "dgt".', 'warning');
    }

    // Mostrar indicador visual
    var mapDiv = document.getElementById('map');
    if(!mapDiv) return;

    overlayEl = document.createElement('div');
    overlayEl.style.cssText = 'position:absolute;inset:0;z-index:602;cursor:crosshair;background:rgba(0,180,100,.07);';
    mapDiv.appendChild(overlayEl);

    overlayGuide = document.createElement('div');
    overlayGuide.style.cssText = 'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);z-index:603;background:rgba(0,0,0,.7);color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;font-family:sans-serif;pointer-events:none;white-space:nowrap;';
    overlayGuide.textContent = 'Clica num edifício para segmentar. Esc para cancelar.';
    mapDiv.appendChild(overlayGuide);

    mapDiv.style.cursor = 'crosshair';

    // Vigiar o fecho da toolbar de edição para auto-desativar (ver comentário acima)
    ensureToolbarVisibilityObserver();

    // Águia animada: indicador visual do estado da IA (ver 19-eagle-assistant.js)
    if(window.__eagleAssistant) window.__eagleAssistant.showIdle();

    overlayEl.addEventListener('click', handleClick);

    /* Invalidar a vista codificada assim que o mapa comeca a mexer --
       'movestart'/'zoomstart' (nao 'moveend'/'zoomend') porque queremos
       cortar a cache ANTES de qualquer clique poder chegar a meio de um
       pan/zoom em curso, nao so' depois de ele terminar. Avisa-se tambem
       o worker, para nao ficar a decodificar sobre um embedding de uma
       vista que ja nao e' a atual. */
    if(window.map && typeof window.map.on === 'function'){
      mapInvalidateHandler = function(){
        VIEW_META = null;
        if(samWorker) samWorker.postMessage({ type: 'invalidateView' });
      };
      map.on('movestart zoomstart', mapInvalidateHandler);
    }
  }

  function deactivate(){
    if(!active) return;
    active = false;
    if(overlayEl && overlayEl.parentNode){
      overlayEl.parentNode.removeChild(overlayEl);
      overlayGuide.parentNode.removeChild(overlayGuide);
    }
    overlayEl = null;
    overlayGuide = null;
    var mapDiv = document.getElementById('map');
    if(mapDiv) mapDiv.style.cursor = '';
    if(map) map.dragging.enable();

    if(window.map && mapInvalidateHandler){
      map.off('movestart zoomstart', mapInvalidateHandler);
      mapInvalidateHandler = null;
    }
    VIEW_META = null; // basemap ou vista podem mudar entre sessoes -- nao arriscar cache stale
    if(samWorker) samWorker.postMessage({ type: 'invalidateView' });
    processingClick = false;

    // Águia animada: remover completamente e libertar timers/animações
    if(window.__eagleAssistant) window.__eagleAssistant.hide();

    if(typeof window.dispatchEvent === 'function'){
      window.dispatchEvent(new CustomEvent('sam:state', { detail: { active: false } }));
    }
  }

  // ========== Handler de clique no mapa ==========
  function handleClick(e){
    e.stopPropagation();
    if(!window.map) return;

    /* O modo fica ativo entre cliques (para aproveitar a cache do
       embedding no worker ao traçar varios edificios seguidos na mesma
       vista); so' se ignora um novo clique enquanto o anterior ainda
       esta a processar. */
    if(processingClick) return;
    processingClick = true;

    var mapDiv = document.getElementById('map');
    var rect = mapDiv.getBoundingClientRect();
    var clickX = e.clientX - rect.left;
    var clickY = e.clientY - rect.top;
    var bounds = map.getBounds();
    var zoom = map.getZoom();

    if(overlayEl) overlayEl.style.cursor = 'wait';

    // Mostrar "a processar"
    var status = document.createElement('div');
    status.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:610;background:rgba(0,0,0,.8);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;font-family:sans-serif;pointer-events:none;';
    status.textContent = 'A segmentar...';
    mapDiv.appendChild(status);

    // Águia animada: começa a piscar enquanto a IA analisa a imagem
    if(window.__eagleAssistant) window.__eagleAssistant.startBlinking();

    runSegmentation(clickX, clickY, bounds, zoom, mapDiv).then(function(count){
      mapDiv.removeChild(status);
      if(!active) return; // modo AAV foi desativado enquanto este pedido estava em curso -- não reanimar a águia
      if(count){
        // Águia animada: encontrou um polígono -- interromper o piscar e atacar
        if(window.__eagleAssistant) window.__eagleAssistant.attack();
      } else {
        showTransientMessage(mapDiv, 'Nao foi detetado nenhum contorno valido nesse ponto. Tenta clicar mais ao centro do edificio.');
        if(window.__eagleAssistant) window.__eagleAssistant.showIdle();
      }
    }).catch(function(err){
      mapDiv.removeChild(status);
      if(typeof __console !== 'undefined') __console.log('SAM erro: ' + err.message, 'error');
      if(!active) return; // idem -- já desativado, não mostrar mensagem/águia sobre um modo que já não está ligado
      showTransientMessage(mapDiv, 'Erro na segmentacao: ' + (err && err.message ? err.message : 'erro desconhecido'));
      if(window.__eagleAssistant) window.__eagleAssistant.showIdle();
    }).finally(function(){
      processingClick = false;
      if(overlayEl) overlayEl.style.cursor = 'crosshair';
    });
  }

  // Mensagem breve sobre o mapa (sucesso-vazio ou erro), some sozinha --
  // ANTES so' o __console interno era avisado, por isso um clique sem
  // resultado (mascara vazia) ou um erro pareciam "nao fazer nada".
  function showTransientMessage(mapDiv, text){
    var el = document.createElement('div');
    el.style.cssText = 'position:absolute;bottom:50px;left:50%;transform:translateX(-50%);z-index:610;background:rgba(180,40,40,.9);color:#fff;padding:8px 16px;border-radius:6px;font-size:12px;font-family:sans-serif;pointer-events:none;max-width:80%;text-align:center;';
    el.textContent = text;
    mapDiv.appendChild(el);
    setTimeout(function(){
      if(el.parentNode) el.parentNode.removeChild(el);
    }, 4000);
  }

  // ========== DEBUG: preview do recorte enviado ao modelo ==========
  /* Thumbnail flutuante com um recorte a volta do clique (so' para
     visualizacao) e uma cruz vermelha no ponto exato (relX, relY) que
     sera' mandado como prompt positivo ao decoder (no worker).
     ANTES: anexava-se dentro de mapDiv com position:absolute e
     z-index:611 -- ficava la, mas ESCONDIDO atras de paineis flutuantes
     que vivem dentro de #map com z-index muito mais alto. AGORA anexa-se
     a document.body (fora de #map) com position:fixed e um z-index
     extremo, para garantir que fica sempre visivel. */
  var debugPreviewEl = null;
  function showDebugPreview(mapDiv, roiCanvas, relX, relY){
    if(debugPreviewEl && debugPreviewEl.parentNode){
      debugPreviewEl.parentNode.removeChild(debugPreviewEl);
    }
    var thumbSize = 220;
    var previewCanvas = document.createElement('canvas');
    previewCanvas.width = thumbSize;
    previewCanvas.height = thumbSize;
    var pctx = previewCanvas.getContext('2d');
    pctx.drawImage(roiCanvas, 0, 0, roiCanvas.width, roiCanvas.height, 0, 0, thumbSize, thumbSize);

    // Cruz vermelha no ponto de clique (convertido para a escala do thumbnail)
    var tx = (relX / roiCanvas.width) * thumbSize;
    var ty = (relY / roiCanvas.height) * thumbSize;
    pctx.strokeStyle = '#ff2d2d';
    pctx.lineWidth = 2;
    pctx.beginPath();
    pctx.moveTo(tx - 8, ty); pctx.lineTo(tx + 8, ty);
    pctx.moveTo(tx, ty - 8); pctx.lineTo(tx, ty + 8);
    pctx.stroke();
    pctx.beginPath();
    pctx.arc(tx, ty, 5, 0, Math.PI * 2);
    pctx.strokeStyle = '#fff';
    pctx.lineWidth = 1;
    pctx.stroke();

    debugPreviewEl = document.createElement('div');
    debugPreviewEl.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#000;border:3px solid #ff2d2d;border-radius:6px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.6);';
    var caption = document.createElement('div');
    caption.style.cssText = 'color:#fff;font:12px sans-serif;padding:4px 8px;background:rgba(0,0,0,.85);display:flex;justify-content:space-between;align-items:center;gap:8px;';
    var captionText = document.createElement('span');
    captionText.textContent = 'SAM debug: recorte + ponto enviado';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;';
    closeBtn.addEventListener('click', function(){
      if(debugPreviewEl && debugPreviewEl.parentNode) debugPreviewEl.parentNode.removeChild(debugPreviewEl);
    });
    caption.appendChild(captionText);
    caption.appendChild(closeBtn);
    debugPreviewEl.appendChild(previewCanvas);
    debugPreviewEl.appendChild(caption);
    document.body.appendChild(debugPreviewEl);

    if(typeof __console !== 'undefined'){
      __console.log('SAM debug: preview do ROI mostrado no canto inferior direito (fixo, por cima de tudo) -- confirma se a cruz cai em cima do edificio clicado.', 'info');
    }
  }

  // ========== Deteção de canvas em branco/uniforme ==========
  /* Um recorte real de ortofoto tem sempre alguma variacao de cor
     (telhados, vegetacao, estradas); um recorte que o html2canvas nao
     conseguiu desenhar (tile cross-origin ignorada, ou tile ainda a
     carregar no momento da captura) fica com uma cor de fundo lisa.
     Verifica-se aqui, na main thread, LOGO A SEGUIR a captura -- antes de
     sequer se criar a ImageBitmap e mandar ao worker -- para falhar rapido
     sem gastar uma viagem ao worker (nem, pior, tempo de encoder) numa
     imagem que ja se sabe estar vazia. */
  function isCanvasBlank(canvas){
    var ctx = canvas.getContext('2d');
    var full = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var stepPx = 8; // amostra 1 em cada 8 pixeis (em cada eixo) do array RGBA
    var rowBytes = canvas.width * 4;
    var sum = 0, sumSq = 0, n = 0;
    var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for(var y = 0; y < canvas.height; y += stepPx){
      for(var x = 0; x < canvas.width; x += stepPx){
        var o = y * rowBytes + x * 4;
        var r = full[o], g = full[o+1], b = full[o+2];
        if(r < rMin) rMin = r; if(r > rMax) rMax = r;
        if(g < gMin) gMin = g; if(g > gMax) gMax = g;
        if(b < bMin) bMin = b; if(b > bMax) bMax = b;
        sum += r + g + b; sumSq += r*r + g*g + b*b; n += 3;
      }
    }
    var mean = sum / n;
    var variance = (sumSq / n) - (mean * mean);
    var blank = variance < 4; // desvio-padrao < 2 em escala 0-255 -- praticamente uma cor sólida
    if(typeof __console !== 'undefined'){
      __console.log('SAM: analise do ROI capturado -- media=' + mean.toFixed(1) + ' variancia=' + variance.toFixed(1) +
        ' R[' + rMin + '-' + rMax + '] G[' + gMin + '-' + gMax + '] B[' + bMin + '-' + bMax + ']' +
        (blank ? ' -> considerado EM BRANCO' : ''), blank ? 'warning' : 'info');
    }
    return blank;
  }

  // ========== Captura + pedido de encode ao worker (CACHEADO por vista) ==========
  /* Corre no maximo uma vez por vista do mapa: captura o mapDiv inteiro,
     manda para o worker codificar, e guarda so' os METADADOS da vista
     (VIEW_META) -- o embedding em si fica residente no worker. Cada
     clique seguinte na mesma vista salta direto para o pedido de decode
     (ver runSegmentation). Invalida-se quando o mapa se mexe (pan/zoom)
     ou o modo SAM e' desativado (ver listeners em activate()/deactivate()). */
  async function ensureEmbedding(mapDiv, bounds, zoom){
    /* Rede de segurança final -- mesmo com o basemap fixado em activate(),
       o utilizador pode trocar de basemap à mão no menu a meio de uma
       sessão de SAM. Confirma-se aqui, mesmo antes de capturar, e
       força-se outra vez se necessário. Uma troca de basemap invalida
       sempre a vista codificada (a imagem por baixo mudou). */
    if(typeof window.__forceBasemap === 'function' && window.__activeBaseLayerKey !== SAM_REQUIRED_BASEMAP){
      if(typeof __console !== 'undefined'){
        __console.log('SAM: basemap tinha mudado para "' + window.__activeBaseLayerKey + '" a meio da sessão -- a forçar de volta para "satelite" antes de capturar.', 'warning');
      }
      window.__forceBasemap(SAM_REQUIRED_BASEMAP);
      VIEW_META = null;
      if(samWorker) samWorker.postMessage({ type: 'invalidateView' });
      await new Promise(function(r){ setTimeout(r, 500); }); // dar tempo às tiles novas carregarem
    }

    // Vista ja codificada e ainda valida (mesmos bounds+zoom)? Nao pedir outra vez ao worker.
    if(VIEW_META && VIEW_META.zoom === zoom && VIEW_META.bounds.equals(bounds)){
      return VIEW_META;
    }

    /* 1. Capturar viewport (DOM -- so' pode correr aqui, nao no worker).
       scale:1 -- captura a pixels CSS, nao ao devicePixelRatio do ecra
       (2x+ em retina/HiDPI seria puro desperdicio, ja que o encoder reduz
       tudo para 1024x1024 de qualquer forma). useCORS:true para o
       html2canvas conseguir desenhar as tiles do basemap (outra origem). */
    var canvas = await html2canvas(mapDiv, { useCORS: true, logging: false, scale: 1 });
    var w = canvas.width, h = canvas.height;

    if(isCanvasBlank(canvas)){
      var basemapKey = (typeof window.__activeBaseLayerKey !== 'undefined') ? window.__activeBaseLayerKey : null;
      var basemapNote = basemapKey === 'dgt'
        ? ' O basemap "DGT Ortos" atual nao envia cabecalhos CORS -- muda para "Satelite" (ArcGIS) e tenta outra vez.'
        : ' Tenta mudar de basemap (ex. "Satelite") e repetir.';
      if(typeof __console !== 'undefined'){
        __console.log('SAM: captura esta em branco/uniforme (basemap="' + basemapKey + '") -- provavel bloqueio CORS das tiles pelo html2canvas. A abortar sem chamar o worker.', 'error');
      }
      throw new Error('Imagem base nao capturada (bloqueio CORS das tiles).' + basemapNote);
    }

    // 2. Miniatura para o debug preview (fica so' aqui na main thread, nunca vai ao worker).
    var PREVIEW_MAX = 900;
    var previewScale = Math.min(1, PREVIEW_MAX / Math.max(w, h));
    var previewCanvas = document.createElement('canvas');
    previewCanvas.width = Math.round(w * previewScale);
    previewCanvas.height = Math.round(h * previewScale);
    previewCanvas.getContext('2d').drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);

    /* 3. Transferir para o worker via ImageBitmap (transferable -- zero
       copias extra no postMessage, so' a copia unica feita pelo proprio
       createImageBitmap). O worker fica DONO do embedding resultante;
       aqui so' guardamos os metadados da vista, nao os pixels nem o
       embedding. */
    var bitmap = await createImageBitmap(canvas);
    await callWorker({ type: 'encodeView', bitmap: bitmap, w: w, h: h, zoom: zoom }, [bitmap]);

    VIEW_META = {
      previewCanvas: previewCanvas, previewScale: previewScale,
      w: w, h: h, bounds: bounds, zoom: zoom,
    };
    if(typeof __console !== 'undefined'){
      __console.log('SAM: vista enviada e codificada no worker (zoom ' + zoom + ') -- proximos cliques na mesma vista so\' pedem o decode.', 'info');
    }
    return VIEW_META;
  }

  // ========== Pipeline por clique (pede so' o decode ao worker) ==========
  async function runSegmentation(clickX, clickY, bounds, zoom, mapDiv){
    /* ANTES: clickX/clickY (pixels CSS) eram usados diretamente contra o
       canvas do html2canvas, que por omissao captura a devicePixelRatio
       do ecra (2x+ em retina/HiDPI) -- desalinhava o ponto enviado ao SAM
       do sitio onde realmente se clicou. AGORA converte-se sempre para
       pixels do CANVAS antes de qualquer calculo. */
    var mapRect = mapDiv.getBoundingClientRect();

    var meta = await ensureEmbedding(mapDiv, bounds, zoom);
    var scaleX = meta.w / mapRect.width;
    var scaleY = meta.h / mapRect.height;
    clickX = clickX * scaleX;
    clickY = clickY * scaleY;
    if(typeof __console !== 'undefined'){
      __console.log('SAM: escala canvas/CSS = ' + scaleX.toFixed(2) + 'x' + scaleY.toFixed(2) + ' (devicePixelRatio=' + (window.devicePixelRatio || 1) + ')', 'info');
    }

    var w = meta.w, h = meta.h, metaBounds = meta.bounds; // usar sempre os da vista que gerou o embedding

    /* DEBUG: pre-visualizacao de um recorte a volta do ponto -- so' para
       diagnostico visual, nao afeta a inferencia (que corre no worker).
       Fonte: a miniatura cacheada (meta.previewCanvas). */
    var SAM_DEBUG_PREVIEW = true;
    if(SAM_DEBUG_PREVIEW){
      var pScale = meta.previewScale;
      var pClickX = clickX * pScale, pClickY = clickY * pScale;
      var dbgSize = Math.max(60, Math.round(400 * pScale)), dbgHalf = dbgSize / 2;
      var dbgRx = Math.max(0, Math.min(pClickX - dbgHalf, meta.previewCanvas.width - dbgSize));
      var dbgRy = Math.max(0, Math.min(pClickY - dbgHalf, meta.previewCanvas.height - dbgSize));
      var dbgCanvas = document.createElement('canvas');
      dbgCanvas.width = dbgSize; dbgCanvas.height = dbgSize;
      dbgCanvas.getContext('2d').drawImage(meta.previewCanvas, dbgRx, dbgRy, dbgSize, dbgSize, 0, 0, dbgSize, dbgSize);
      showDebugPreview(mapDiv, dbgCanvas, pClickX - dbgRx, pClickY - dbgRy);
    }

    // Pedido de decode ao worker -- so' isto bloqueia (aguarda resposta),
    // e mesmo assim NAO trava a UI: e' so' uma await numa Promise, o
    // trabalho pesado corre na outra thread.
    var res = await callWorker({ type: 'decodeClick', x: clickX, y: clickY });

    /* Converter pontos (pixels do canvas capturado, devolvidos pelo
       worker) para lat/lng -- o worker nao sabe nada de Leaflet/bounds,
       so' esta thread e' que tem essa informacao. */
    var polygons = [];
    if(res.points){
      var pts = res.points.map(function(pt){
        var gx = pt[0], gy = pt[1];
        var lng = metaBounds.getWest() + (gx / w) * (metaBounds.getEast() - metaBounds.getWest());
        var lat = metaBounds.getNorth() - (gy / h) * (metaBounds.getNorth() - metaBounds.getSouth());
        return [lat, lng];
      });
      polygons.push(pts);
    }

    // Criar polígono(s) no mapa -- associados à camada ativa (ou a uma nova
    // camada "poligonos_AAV", se ainda não existir nenhuma) em vez de
    // ficarem soltos: ver getOrCreateSamLayerId/registerSamFeature acima.
    var samLayerId = getOrCreateSamLayerId();
    polygons.forEach(function(pts){
      var polygon = L.polygon(pts, {
        color: '#4ecb71', weight: 2, fillColor: '#4ecb71', fillOpacity: 0.25,
      }).addTo(map);
      registerSamFeature(polygon, samLayerId);
    });

    var scoreTxt = (typeof res.score === 'number') ? ' (score: ' + res.score.toFixed(3) + ')' : '';
    var msgTxt = 'SAM: ' + polygons.length + ' poligono(s) criado(s)' + scoreTxt;
    if(typeof __console !== 'undefined') __console.log(msgTxt, 'info');
    return polygons.length;
  }

  // ========== Integração com o painel de camadas ==========
  /* O SAM funciona como um "assistente": os polígonos que gera não devem
     ficar soltos no mapa, devem entrar no mesmo sistema de camadas do
     resto da aplicação (painel, cores, tabela de atributos, etc.) --
     ver js/modules/features.js (renderLayersPanel, featuresData) e
     js/05-app-main.js (onFeatureCreated, que faz o mesmo para as
     geometrias desenhadas à mão).

     Regra pedida:
       1) Se já existe uma camada ativa e essa camada é de polígonos
          -> usar essa mesma camada (é o caso mais comum: o utilizador
          já criou a camada "Edifícios" e está a traçar para lá).
       2) Senão, se já existe uma camada "poligonos_AAV" criada por uma
          sessão anterior do SAM (arquivada no painel) -> reaproveitá-la,
          para não ficar a criar uma camada nova a cada sessão.
       3) Senão, se não existe NENHUMA camada no projeto -> esta passa a
          ser a própria camada ativa (fica igual a ter passado pelo
          wizard "Vetorizar").
       4) Senão (há uma camada ativa mas é de outro tipo de geometria,
          ex. Pontos/Linhas) -> cria-se uma camada "poligonos_AAV" nova,
          arquivada logo à parte, SEM mexer na camada que o utilizador
          tem selecionada de momento (não lhe interrompe o que está a
          fazer). Fica acessível/editável no painel como qualquer outra.
  */
  function getOrCreateSamLayerId(){
    if(typeof config === 'undefined' || typeof layers === 'undefined' || typeof activeLayerId === 'undefined'){
      return null; // sistema de camadas não disponível (ex: página de testes isolada)
    }

    if(config.geometryType === 'Polygon'){
      return activeLayerId;
    }

    var existing = layers.find(function(l){ return l.name === 'poligonos_AAV'; });
    if(existing) return existing.id;

    if(!config.geometryType && layers.length === 0){
      config.shapeName = 'poligonos_AAV';
      config.mode = 'simples';
      config.attributes = [];
      config.geometryType = 'Polygon';
      config.colorAttr = null;
      config.baseColor = null;
      config.opacity = null;
      config.symbology = (typeof defaultSymbology === 'function') ? defaultSymbology() : undefined;
      if(typeof applyGeometryConfig === 'function') applyGeometryConfig();
      if(typeof refreshLayerEditability === 'function') refreshLayerEditability();
      if(typeof __console !== 'undefined') __console.log('SAM: criada camada "poligonos_AAV" (era a primeira camada do projeto).', 'info');
      return activeLayerId;
    }

    var newId = ++layerCounter;
    layers.push({
      id: newId,
      name: 'poligonos_AAV',
      geometryType: 'Polygon',
      mode: 'simples',
      attributes: [],
      colorAttr: null,
      baseColor: null,
      opacity: null,
      symbology: (typeof defaultSymbology === 'function') ? defaultSymbology() : undefined
    });
    layerVisible.set(newId, true);
    if(typeof __console !== 'undefined') __console.log('SAM: criada nova camada "poligonos_AAV" (a camada ativa era de outro tipo de geometria).', 'info');
    return newId;
  }

  /* Regista um polígono do SAM exatamente como uma geometria desenhada à
     mão (ver onFeatureCreated em 05-app-main.js) -- entra em featuresData,
     ganha pane/estilo da camada de destino, aparece na tabela/painel e
     conta para a verificação de topologia. */
  function registerSamFeature(polygon, layerId){
    if(layerId === null){
      // sistema de camadas indisponível -- manter o comportamento antigo (só no mapa)
      if(typeof drawnGroup !== 'undefined' && drawnGroup) drawnGroup.addLayer(polygon);
      return;
    }

    if(typeof drawnGroup !== 'undefined' && drawnGroup) drawnGroup.addLayer(polygon);
    if(typeof assignLayerPane === 'function') assignLayerPane(polygon, layerId);

    if(typeof featureCounter !== 'undefined') featureCounter++;
    var id = L.Util.stamp(polygon);
    var entry = {
      layer: polygon, props: {}, id: id, fid: samGenFid(),
      updatedAt: Date.now(), label: 'Geometria ' + featureCounter,
      geomType: 'Polygon', layerId: layerId,
      hasOverlap: false, overlapsWith: [], showMeasures: false, measureTooltips: []
    };
    if(typeof featuresData !== 'undefined') featuresData.set(id, entry);
    if(typeof markProjectDirty === 'function') markProjectDirty();
    if(typeof styleLayerDefault === 'function') styleLayerDefault(polygon, layerId);
    if(typeof bindFeatureContextMenu === 'function') bindFeatureContextMenu(entry);
    if(typeof bindFeatureEditTracking === 'function') bindFeatureEditTracking(entry);
    if(typeof refreshFeatList === 'function') refreshFeatList();
    if(typeof checkAllTopology === 'function') checkAllTopology();
  }

  // Fallback caso este ficheiro seja alguma vez carregado sem 05-app-main.js
  // (onde genFid() já existe como função global) -- nome próprio para não
  // sombrear/confundir com o global.
  function samGenFid(){
    if(typeof genFid === 'function') return genFid();
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('fid-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  }


  /* O download/cache dos pesos ONNX vive agora no worker (Cache Storage
     API, tambem disponivel la, nao so' em Service Workers). Mantem-se
     aqui so' o utilitario de limpeza manual, delegado ao worker. */
  window.__sam.clearModelCache = function(){
    return callWorker({ type: 'clearModelCache' }).catch(function(err){
      if(typeof __console !== 'undefined') __console.log('SAM: erro ao limpar cache de modelos: ' + err.message, 'error');
      return false;
    });
  };

  // ========== Escape para cancelar ==========
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && active) deactivate();
  });

  // ========== Botão ==========
  /* O botão da Vetorização Assistida já não vive no header -- passou a
     ser um controlo Leaflet próprio, criado logo por baixo da toolbar
     de edição do Geoman (ver "VetAssistControl" em 05-app-main.js, a
     seguir ao map.pm.addControls principal). Esse controlo já chama
     diretamente window.__sam.activate()/deactivate(), pelo que não há
     nada a ligar aqui.
  */
})();
