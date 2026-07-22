/* FeatherGIS — Águia Animada (indicador visual da Vetorização Assistida)
   ========================================================================
   Componente independente e desacoplado da lógica do algoritmo SAM.
   Responde apenas a chamadas explícitas dos métodos públicos -- quem
   dispara essas chamadas é o 18-sam-segment.js (ver activate/handleClick/
   runSegmentation/deactivate), nunca este ficheiro que decide sozinho
   quando mudar de estado.

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

  var EAGLE_WIDTH_PX = 96; // ~90-100px pedido na spec

  // ---- Estado interno ----
  var container = null;
  var imgBase = null;    // camada de baixo -- fica sempre em x2 (idle)
  var imgOverlay = null; // camada de cima -- crossfade para x2_5 (piscar) ou x3 (ataque)
  var state = 'hidden';  // 'hidden' | 'idle' | 'blinking' | 'attacking'
  var preloaded = false;

  var blinkTimer = null;    // timers do ciclo de piscar (agendamento + fases da animação)
  var attackTimer1 = null;  // timers da sequência de ataque (pulso de escala + regresso)
  var attackTimer2 = null;

  function clearAllTimers(){
    if(blinkTimer){ clearTimeout(blinkTimer); blinkTimer = null; }
    if(attackTimer1){ clearTimeout(attackTimer1); attackTimer1 = null; }
    if(attackTimer2){ clearTimeout(attackTimer2); attackTimer2 = null; }
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

  // ---- Construção do overlay (fixo sobre o mapa, não bloqueia cliques) ----
  function ensureDom(){
    if(container) return true;
    var mapDiv = document.getElementById('map');
    if(!mapDiv) return false;

    container = document.createElement('div');
    container.id = 'eagle-assistant';
    container.style.cssText =
      'position:absolute;top:50%;right:15px;transform:translateY(-50%);width:' + EAGLE_WIDTH_PX + 'px;' +
      'height:auto;z-index:650;pointer-events:none;user-select:none;';

    imgBase = document.createElement('img');
    imgBase.alt = '';
    imgBase.draggable = false;
    imgBase.style.cssText = 'display:block;width:100%;height:auto;';
    imgBase.src = EAGLE_SRC.idle;

    imgOverlay = document.createElement('img');
    imgOverlay.alt = '';
    imgOverlay.draggable = false;
    imgOverlay.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:auto;opacity:0;' +
      'transform:scale(1);transform-origin:50% 60%;' +
      'transition:opacity 220ms ease-in-out, transform 150ms ease-in-out;';

    container.appendChild(imgBase);
    container.appendChild(imgOverlay);
    mapDiv.appendChild(container);
    return true;
  }

  // ---- Estado 1: IA em espera ----
  function showIdle(){
    preload();
    if(!ensureDom()) return;
    clearAllTimers();
    state = 'idle';
    imgOverlay.style.transition = 'opacity 200ms ease-in-out, transform 150ms ease-in-out';
    imgOverlay.style.transform = 'scale(1)';
    imgOverlay.style.opacity = '0';
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
    imgOverlay.style.transform = 'scale(1)';
    scheduleNextBlink();
  }

  // ---- Estado 3 -> 4: encontrou polígono (ataque) e regresso suave a idle ----
  function attack(){
    if(!ensureDom()) return;
    clearAllTimers();
    state = 'attacking';

    imgOverlay.src = EAGLE_SRC.attack;
    imgOverlay.style.transition = 'opacity 150ms ease-in-out, transform 150ms ease-in-out';
    void imgOverlay.offsetWidth;
    imgOverlay.style.opacity = '1';
    imgOverlay.style.transform = 'scale(1.08)'; // pequeno "impacto" visual

    attackTimer1 = setTimeout(function(){
      if(!imgOverlay) return;
      imgOverlay.style.transform = 'scale(1)';
    }, 150);

    // Ao fim de ~1s, regressar suavemente a x2 (idle)
    attackTimer2 = setTimeout(function(){
      if(!imgOverlay) return;
      imgOverlay.style.transition = 'opacity 300ms ease-in-out, transform 150ms ease-in-out';
      imgOverlay.style.opacity = '0';
      blinkTimer = setTimeout(function(){
        if(state === 'attacking') state = 'idle';
      }, 320);
    }, 1000);
  }

  // ---- Remoção completa (sair do modo Vetorização Assistida) ----
  function hide(){
    clearAllTimers();
    state = 'hidden';
    if(container && container.parentNode){
      container.parentNode.removeChild(container);
    }
    container = null;
    imgBase = null;
    imgOverlay = null;
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
