/* FeatherGIS — Águia Animada (AAV: Algoritmo de Assistência à Vetorização)
   ========================================================================
   Componente independente e desacoplado da lógica do algoritmo SAM.
   Responde apenas a chamadas explícitas dos métodos públicos -- quem
   dispara essas chamadas é o 18-sam-segment.js (ver activate/handleClick/
   runSegmentation/deactivate), nunca este ficheiro que decide sozinho
   quando mudar de estado.

   Todo o visual (painel/plate translúcido, respiração idle, pulso de
   ataque, estado (por baixo do título), dark mode, responsivo) vive em
   css/eagle-assistant.css -- este ficheiro só troca classes de estado
   (.is-idle/.is-blinking/.is-attack, .is-visible/.is-hidden) e texto do
   balão; a única animação feita diretamente aqui é o crossfade de
   opacidade entre as duas <img> de .aav-eagle-wrap (Fase 4: piscar real
   x2 -> x2_5 -> x2), porque isso precisa de timings orgânicos e
   aleatórios que não fazem sentido como @keyframes fixo.

   Estados visuais (3 imagens, mesma "caixa" 1024x1024, mesmo enquadramento
   da águia dentro da caixa -- ver nota sobre a normalização de x2_5.png
   mais abaixo):
     idle    -> images/eagle/x2.png   (olhos abertos, postura relaxada)
     blink   -> images/eagle/x2_5.png (olhos fechados, a piscar)
     attack  -> images/eagle/x3.png   (bico aberto, pronta a atacar)

   NOTA sobre x2_5.png: o ficheiro original fornecido tinha uma tela
   (1254x1254) e um enquadramento da águia diferentes dos de x2.png/
   x3.png (1024x1024) -- um crossfade direto entre os originais faria a
   águia "saltar" de tamanho/posição a cada piscar. O ficheiro em
   images/eagle/x2_5.png já vem re-escalado e realinhado (mesma tela
   1024x1024, mesma posição/escala do desenho) para que o crossfade por
   opacidade seja um verdadeiro piscar e não uma troca brusca.
*/
(function(){
  'use strict';

  var EAGLE_SRC = {
    idle:   'images/eagle/x2.png',
    blink:  'images/eagle/x2_5.png',
    attack: 'images/eagle/x3.png'
  };

  // Mensagens do estado (por baixo do título) por estado -- mais que uma opção só
  // para não repetir sempre a mesma frase em sessões longas.
  var MESSAGES = {
    idle:   ['Pronta para ajudar', 'Clica num edifício'],
    blink:  ['A analisar a imagem…', 'A ver o que há aqui…'],
    attack: ['Encontrei o contorno!', 'Apanhei-o!', 'Polígono criado.']
  };

  // ---- Estado interno ----
  var panel = null;
  var imgBase = null;    // .aav-eagle-img base -- fica sempre em x2 (idle)
  var imgOverlay = null; // .aav-eagle-img.is-overlay -- crossfade p/ x2_5 ou x3
  var statusEl = null;
  var state = 'hidden';  // 'hidden' | 'idle' | 'blinking' | 'attacking'
  var preloaded = false;

  var blinkTimer = null;    // timers do ciclo de piscar (agendamento + fases da animação)
  var attackTimer1 = null;  // timers da sequência de ataque (pulso + regresso)
  var attackTimer2 = null;
  var statusTimer = null;  // timer de auto-esconder o estado

  function clearAllTimers(){
    if(blinkTimer){ clearTimeout(blinkTimer); blinkTimer = null; }
    if(attackTimer1){ clearTimeout(attackTimer1); attackTimer1 = null; }
    if(attackTimer2){ clearTimeout(attackTimer2); attackTimer2 = null; }
    if(statusTimer){ clearTimeout(statusTimer); statusTimer = null; }
  }

  // ---- Pré-carregamento (evita atraso na primeira animação) ----
  function preload(){
    if(preloaded) return;
    preloaded = true;
    Object.keys(EAGLE_SRC).forEach(function(key){
      var im = new Image();
      im.src = EAGLE_SRC[key];
    });
  }

  // ---- Balão de diálogo ----
  function pickMessage(key){
    var pool = MESSAGES[key];
    if(!pool || !pool.length) return '';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // autoHideMs: null/0 -> não esconde sozinho (quem chamou decide, ex. attack())
  function showStatus(text, autoHideMs){
    if(!statusEl) return;
    if(statusTimer){ clearTimeout(statusTimer); statusTimer = null; }
    statusEl.textContent = text;
    statusEl.classList.add('is-visible');
    if(autoHideMs){
      statusTimer = setTimeout(hideStatus, autoHideMs);
    }
  }

  function hideStatus(){
    if(statusTimer){ clearTimeout(statusTimer); statusTimer = null; }
    if(statusEl) statusEl.classList.remove('is-visible');
  }

  // ---- Construção do painel (fixed, ver .aav-panel no CSS) ----
  // Ordem visual: quadrado com a águia (fundo) -> título "AAV" ->
  // estado atual -- por baixo, não é balão flutuante por cima.
  function ensureDom(){
    if(panel) return true;

    panel = document.createElement('div');
    panel.className = 'aav-panel';

    var wrap = document.createElement('div');
    wrap.className = 'aav-eagle-wrap';

    imgBase = document.createElement('img');
    imgBase.className = 'aav-eagle-img';
    imgBase.alt = '';
    imgBase.draggable = false;
    imgBase.src = EAGLE_SRC.idle;

    imgOverlay = document.createElement('img');
    imgOverlay.className = 'aav-eagle-img is-overlay';
    imgOverlay.alt = '';
    imgOverlay.draggable = false;

    wrap.appendChild(imgBase);
    wrap.appendChild(imgOverlay);

    var title = document.createElement('div');
    title.className = 'aav-panel-title';
    title.textContent = 'AAV';

    statusEl = document.createElement('div');
    statusEl.className = 'aav-status';

    panel.appendChild(wrap);
    panel.appendChild(title);
    panel.appendChild(statusEl);
    document.body.appendChild(panel);
    return true;
  }

  function setStateClass(cls){
    if(!panel) return;
    panel.classList.remove('is-idle', 'is-blinking', 'is-attack');
    if(cls) panel.classList.add(cls);
  }

  // ---- Estado 1: IA em espera ----
  function showIdle(){
    preload();
    if(!ensureDom()) return;
    clearAllTimers();
    state = 'idle';
    panel.classList.add('is-visible');
    panel.classList.remove('is-hidden');
    setStateClass('is-idle');
    imgOverlay.style.opacity = '0';
    showStatus(pickMessage('idle'), 2600);
  }

  // ---- Estado 2: IA a analisar (piscar contínuo e orgânico) ----
  function scheduleNextBlink(){
    if(state !== 'blinking') return;
    var delay = 2000 + Math.random() * 1000; // 2-3s entre piscares
    blinkTimer = setTimeout(doOneBlink, delay);
  }

  function doOneBlink(){
    if(state !== 'blinking' || !imgOverlay) return;
    var half = Math.round(100 + Math.random() * 50); // metade do piscar: 100-150ms (total 200-300ms)

    imgOverlay.src = EAGLE_SRC.blink;
    imgOverlay.style.transition = 'opacity ' + half + 'ms ease-in-out';
    // Forçar reflow antes de mudar a opacidade garante que a transição de
    // fade-in corre mesmo tendo acabado de trocar o `src`.
    void imgOverlay.offsetWidth;
    imgOverlay.style.opacity = '1';

    blinkTimer = setTimeout(function(){
      if(state !== 'blinking' || !imgOverlay) return;
      imgOverlay.style.opacity = '0';
      blinkTimer = setTimeout(function(){
        scheduleNextBlink();
      }, half + 20);
    }, half);
  }

  function startBlinking(){
    preload();
    if(!ensureDom()) return;
    clearAllTimers();
    state = 'blinking';
    panel.classList.add('is-visible');
    panel.classList.remove('is-hidden');
    setStateClass('is-blinking');
    imgOverlay.style.transition = 'opacity 150ms ease-in-out';
    imgOverlay.style.opacity = '0';
    scheduleNextBlink();
    showStatus(pickMessage('blink'), 2600);
  }

  // ---- Estado 3 -> 4: encontrou polígono (ataque) e regresso suave a idle ----
  function attack(){
    if(!ensureDom()) return;
    clearAllTimers();
    state = 'attacking';
    setStateClass('is-attack');

    imgOverlay.src = EAGLE_SRC.attack;
    imgOverlay.style.transition = 'opacity 150ms ease-in-out';
    void imgOverlay.offsetWidth;
    imgOverlay.style.opacity = '1';

    showStatus(pickMessage('attack'), null); // esconde-se em conjunto com o regresso a idle, mais abaixo

    // aavAttackPop (CSS) já faz o pulso de escala sozinho ao entrar em
    // is-attack -- aqui só é preciso tratar do crossfade da imagem e do
    // regresso a idle.
    attackTimer2 = setTimeout(function(){
      if(!imgOverlay) return;
      imgOverlay.style.transition = 'opacity 300ms ease-in-out';
      imgOverlay.style.opacity = '0';
      hideStatus();
      blinkTimer = setTimeout(function(){
        if(state === 'attacking'){
          state = 'idle';
          setStateClass('is-idle');
        }
      }, 320);
    }, 1000);
  }

  // ---- Remoção completa (sair do modo Vetorização Assistida) ----
  function hide(){
    clearAllTimers();
    state = 'hidden';
    if(panel){
      panel.classList.remove('is-visible');
      panel.classList.add('is-hidden');
      // Esperar a transição de saída (.22s no CSS) antes de desmontar,
      // para não cortar a animação a meio.
      var toRemove = panel;
      setTimeout(function(){
        if(toRemove && toRemove.parentNode) toRemove.parentNode.removeChild(toRemove);
      }, 240);
    }
    panel = null;
    imgBase = null;
    imgOverlay = null;
    statusEl = null;
  }

  // ---- API pública ----
  window.__eagleAssistant = {
    showIdle: showIdle,
    startBlinking: startBlinking,
    attack: attack,
    hide: hide,
    get state(){ return state; }
  };
})();
