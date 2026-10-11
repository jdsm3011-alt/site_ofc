/* Qualidade adaptada ao dispositivo, sem soluços.
   Carregar DEPOIS de script.js (usa `map`, `estado` e `elCarga` de lá).

   Ideia: em vez de reagir a quebras de fps durante o uso (reagir = já houve soluço, e cada ajuste é, ele próprio, um soluço),
   o nível de qualidade é escolhido UMA vez, no arranque, por trás do ecrã de espera, e depois fica fixo.

   1) Calibração (em script.js, antes de abrir o mapa): para cada nível, do melhor para o pior, mede-se a fluidez numa
      rotação da câmara à inclinação MÁXIMA desse nível (o pior caso de utilização). Escolhe-se o primeiro nível que fica
      estável a 60 fps. O resultado fica guardado, por dispositivo, e é só verificado nas visitas seguintes.
   2) Durante o uso o nível não muda. Só há uma rede de segurança para degradação séria e contínua (ex.: portátil a
      aquecer ou a passar para bateria): desce um nível, no máximo duas vezes, e nunca volta a subir sozinho.

   Alavancas de cada nível (ver NIVEIS): resolução interna (pixelRatio), inclinação máxima da câmara (limita o alcance
   do horizonte) e raio de desenho dos edifícios à volta do centro do ecrã (em larguras de ecrã, por isso acompanha o zoom). */
(() => {
  if (typeof map === 'undefined' || typeof estado === 'undefined') return;
  const $ = id => document.getElementById(id);
  const DPR = window.devicePixelRatio || 1;
  const MOVEL = matchMedia('(pointer: coarse)').matches;

  // k = raio dos edifícios em larguras de ecrã (null = sem limite). O nível 0 é o máximo (só com a qualidade automática desligada).
  const NIVEIS = MOVEL ? [
    { ratio: 2,    pitch: 85, k: null },
    { ratio: 1.5,  pitch: 80, k: 2.5 },
    { ratio: 1.25, pitch: 76, k: 1.8 },
    { ratio: 1,    pitch: 72, k: 1.2 },
    { ratio: 0.85, pitch: 66, k: 0.8 }
  ] : [
    { ratio: 2,    pitch: 85, k: null },
    { ratio: 1.5,  pitch: 85, k: 3 },
    { ratio: 1.25, pitch: 82, k: 2 },
    { ratio: 1,    pitch: 78, k: 1.4 },
    { ratio: 0.75, pitch: 72, k: 0.9 }
  ];
  // No telemóvel a calibração não perde tempo nos níveis que nunca aguentariam; equipamentos mais modestos saltam mais um
  const FRACO = MOVEL && ((navigator.deviceMemory && navigator.deviceMemory <= 3) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.connection && navigator.connection.saveData));
  const NIVEL_INICIAL = MOVEL ? (FRACO ? 2 : 1) : 0;

  // Critérios de "sem soluços" na calibração (tempos entre quadros, em ms)
  const P95_MAX = 19;          // 95% dos quadros têm de caber em ~19 ms (60 fps com folga para o ruído do relógio)
  const LONGO_MS = 25;         // quadro "longo": falhou pelo menos um refresh a 60 Hz
  const LONGOS_MAX = 0.02;     // no máximo 2% de quadros longos
  const MUITO_LONGO_MS = 50;   // soluço visível; tolera-se 1 em toda a medição
  const CALIBRAR_LIMITE_MS = 25000;
  const CACHE_VALIDADE_MS = 3 * 24 * 3600 * 1000; // passado isto, volta a calibrar do zero (o dispositivo pode ter mudado)

  const elAuto = $('qual-auto'), elMostrar = $('qual-fps'), elRecal = $('qual-recal');
  const hud = $('fps'), hudNum = $('fps-num'), hudMsg = $('fps-msg');
  const elNivel = $('qual-nivel'), elNome = $('qual-nome'), elInfo = $('qual-info');
  const NOMES = ['Máxima', 'Alta', 'Média', 'Baixa', 'Mínima'];
  const CH_MANUAL = 'datagis-3d-qual-manual';
  const CH_AUTO = 'datagis-3d-qual-auto', CH_FPS = 'datagis-3d-mostrar-fps', CH_NIVEL = 'datagis-3d-qualidade';
  const ler = (k, omissao) => { try { const v = localStorage.getItem(k); return v === null ? omissao : v; } catch (_) { return omissao; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  if (elAuto) elAuto.checked = ler(CH_AUTO, '1') === '1';
  if (elMostrar) elMostrar.checked = ler(CH_FPS, '0') === '1';
  const automatico = () => !elAuto || elAuto.checked;

  /* ---------- Tempos entre quadros (só quadros seguidos: com o mapa parado não há quadros) ---------- */
  const quadros = []; // { t, dt }, últimos ~8 s de movimento
  let ultimoRender = 0;
  map.on('render', () => {
    const t = performance.now(), dt = t - ultimoRender;
    ultimoRender = t;
    if (dt > 400) return; // pausa (mapa parado, separador oculto…): o primeiro quadro depois dela não conta
    quadros.push({ t, dt });
    while (quadros.length && t - quadros[0].t > 8000) quadros.shift();
  });
  function estatisticas(dts) {
    const n = dts.length;
    if (n < 20) return null;
    const o = [...dts].sort((a, b) => a - b), p = q => o[Math.min(n - 1, Math.floor(q * n))];
    return { n, p50: p(0.5), p95: p(0.95),
      longos: dts.filter(d => d > LONGO_MS).length / n, muitoLongos: dts.filter(d => d > MUITO_LONGO_MS).length };
  }
  const semSolucos = s => !!s && s.p95 <= P95_MAX && s.longos <= LONGOS_MAX && s.muitoLongos <= 1;

  /* ---------- Aplicar um nível ---------- */
  let nivel = 0, ratioAtual = Math.min(DPR, MOVEL ? 1.5 : 2), // igual ao pixelRatio com que o mapa foi criado (script.js)
    pitchMax = NIVEIS[0].pitch, refFiltro = null, aguardaPitch = null;

  const larguraTerreno = () => { // metros de terreno que cabem na largura do ecrã, no centro (tiles de 512 px)
    const lat = map.getCenter().lat * Math.PI / 180;
    return map.getContainer().clientWidth * 78271.517 * Math.cos(lat) / Math.pow(2, map.getZoom());
  };
  const metrosEntre = (a, b) => {
    const kx = 111320 * Math.cos(b.lat * Math.PI / 180);
    return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 111320);
  };
  const textoDistancia = m => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m / 10) * 10 + ' m';

  function aplicarRaio(forcar) {
    const camadas = ['edificios-3d', 'edificios-linha'].filter(id => map.getLayer(id));
    if (!camadas.length) return;
    const k = NIVEIS[nivel].k;
    if (k === null || !estado.temCentros) {
      if (refFiltro) { camadas.forEach(id => map.setFilter(id, null)); refFiltro = null; }
      return;
    }
    const c = map.getCenter(), z = map.getZoom(), raio = k * larguraTerreno();
    // Só refaz o filtro (recarrega os tiles) se o centro andou bastante ou o zoom mudou; a margem esconde a troca
    if (!forcar && refFiltro && Math.abs(z - refFiltro.zoom) < 0.4 && metrosEntre(c, refFiltro.c) < 0.2 * raio) return;
    const dLat = raio / 111320, dLng = raio / (111320 * Math.cos(c.lat * Math.PI / 180));
    const filtro = ['all',
      ['>=', ['get', '_cx'], c.lng - dLng], ['<=', ['get', '_cx'], c.lng + dLng],
      ['>=', ['get', '_cy'], c.lat - dLat], ['<=', ['get', '_cy'], c.lat + dLat]];
    camadas.forEach(id => map.setFilter(id, filtro));
    refFiltro = { c, zoom: z, raio };
  }
  map.on('moveend', () => { if (NIVEIS[nivel].k !== null) aplicarRaio(false); });

  function aplicarInclinacao(v, imediato) {
    pitchMax = v;
    if (aguardaPitch) { map.off('moveend', aguardaPitch); aguardaPitch = null; }
    if (imediato || map.getPitch() <= v) { map.setMaxPitch(v); return; }
    // setMaxPitch corta a inclinação de repente: primeiro desce-se com suavidade e só depois se fixa o limite
    map.easeTo({ pitch: v, duration: 700 });
    aguardaPitch = () => {
      if (map.getPitch() > pitchMax + 0.01) return;
      map.setMaxPitch(pitchMax);
      map.off('moveend', aguardaPitch); aguardaPitch = null;
    };
    map.on('moveend', aguardaPitch);
  }

  function aplicar(i, imediato) {
    nivel = i;
    const n = NIVEIS[i], ratio = Math.min(DPR, n.ratio);
    if (ratio !== ratioAtual) { ratioAtual = ratio; map.setPixelRatio(ratio); }
    aplicarInclinacao(n.pitch, imediato);
    aplicarRaio(true);
    quadros.length = 0;
    atualizarNivelUI();
  }
  const ratioTxt = () => ratioAtual.toLocaleString('pt-PT', { maximumFractionDigits: 2 }) + '×';
  function mostrarNomeNivel(i) {
    if (elNome) elNome.textContent = NOMES[i] || '';
    if (elNivel) elNivel.setAttribute('aria-valuetext', NOMES[i] || '');
  }
  function atualizarNivelUI() { // chips do nível atual + resumo do que ele implica
    mostrarNomeNivel(nivel);
    if (elNivel) elNivel.value = NIVEIS.length - 1 - nivel; // barra: esquerda = mínima, direita = máxima
    if (elInfo) elInfo.textContent = 'Resolução ' + ratioTxt() + ' · ' + alcanceTxt() + (automatico() ? ' · automático' : ' · manual');
  }
  const qualidadeTxt = () => (NIVEIS.length - nivel) + '/' + NIVEIS.length;
  const alcanceTxt = () => refFiltro ? 'edifícios até ' + textoDistancia(refFiltro.raio) : 'sem limite de distância';

  /* ---------- Guardar o resultado por dispositivo ---------- */
  function assinatura() {
    let gpu = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      const perde = gl && gl.getExtension('WEBGL_lose_context');
      if (perde) perde.loseContext();
    } catch (_) {}
    const pixeis = window.innerWidth * window.innerHeight * DPR * DPR;
    return [gpu, DPR, Math.round(Math.log2(Math.max(1, pixeis)) * 2), navigator.hardwareConcurrency || 0].join('|'); // tamanho em meias oitavas
  }
  function lerGuardado() {
    try {
      const g = JSON.parse(ler(CH_NIVEL, 'null'));
      return g && g.sig === assinatura() && Date.now() - g.quando < CACHE_VALIDADE_MS && g.nivel >= 0 && g.nivel < NIVEIS.length ? g : null;
    } catch (_) { return null; }
  }
  const gravarNivel = (calibrado = false) => {
    let quando = Date.now();
    if (!calibrado) { const g = lerGuardado(); if (g) quando = g.quando; } // um ajuste de emergência não renova a validade
    guardar(CH_NIVEL, JSON.stringify({ sig: assinatura(), nivel, quando }));
  };

  /* ---------- Calibração (corre por trás do ecrã de espera) ---------- */
  const quadro = () => new Promise(res => { const t = setTimeout(res, 120); requestAnimationFrame(() => { clearTimeout(t); res(); }); });
  const esperar = ms => new Promise(res => setTimeout(res, ms));
  const aguardarParado = limiteMs => new Promise(res => {
    const fim = () => { clearTimeout(t); map.off('idle', fim); res(); };
    const t = setTimeout(fim, limiteMs);
    map.on('idle', fim);
    map.triggerRepaint();
  });
  async function girar(graus, ms) { // rotação suave da câmara, quadro a quadro
    const b0 = map.getBearing(), t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      map.jumpTo({ bearing: b0 + graus * (0.5 - Math.cos(Math.PI * t) / 2) });
      if (t >= 1) return;
      await quadro();
    }
  }

  async function calibrar({ progresso } = {}) {
    if (!automatico()) { aplicar(Math.min(NIVEIS.length - 1, Math.max(0, parseInt(ler(CH_MANUAL, '0'), 10) || 0)), true); return; } // escolha manual guardada
    if (document.hidden) { aplicar(NIVEL_INICIAL, true); return; }
    const inicio = performance.now();
    const cam = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    const guardado = lerGuardado();
    const primeiro = guardado ? guardado.nivel : NIVEL_INICIAL; // com resultado recente só se verifica (e eventualmente desce)
    let escolhido = primeiro, aquecido = false, semMelhoria = 0, anterior = null, limiteDoSistema = false;

    // Durante a medição o ecrã de espera fica opaco e sem desfoque: o desfoque custaria fps ao mapa e falsearia a medição
    if (typeof elCarga !== 'undefined') elCarga.classList.add('calibrar');
    try {
      for (let i = primeiro; i < NIVEIS.length; i++) {
        progresso && progresso(`A otimizar para este dispositivo… ${i - primeiro + 1}/${NIVEIS.length - primeiro}`);
        aplicar(i, true);
        map.jumpTo({ center: cam.center, zoom: cam.zoom, bearing: cam.bearing, pitch: NIVEIS[i].pitch }); // pior caso: inclinação máxima
        await aguardarParado(4000);
        if (!aquecido) { await girar(360, 1400); await aguardarParado(3000); aquecido = true; } // carrega os tiles de todas as direções
        await esperar(150);

        const ti = performance.now();
        await girar(70, 1600);
        const s = estatisticas(quadros.filter(q => q.t > ti + 250).map(q => q.dt));
        escolhido = i;
        if (semSolucos(s)) break;
        if (i === NIVEIS.length - 1) break;
        // Descer não ajuda? Então o limite é do sistema (ex.: poupança de energia a 30 Hz), não da nossa carga
        if (s && anterior && s.p50 > anterior.p50 * 0.9) semMelhoria++; else semMelhoria = 0;
        if (semMelhoria >= 2) { escolhido = primeiro; limiteDoSistema = true; break; }
        if (s) anterior = s;
        if (performance.now() - inicio > CALIBRAR_LIMITE_MS) { escolhido = Math.min(NIVEIS.length - 1, i + 1); break; }
      }
    } catch (e) {
      console.warn('Calibração interrompida:', e);
    } finally {
      map.jumpTo(cam);
      aplicar(escolhido, true);
      gravarNivel(true);
      await aguardarParado(3000);
    }
    if (limiteDoSistema) mostrarMensagem('fps limitados pelo dispositivo (poupança de energia?) · qualidade mantida em ' + qualidadeTxt());
    else if (nivel > 0 || MOVEL) mostrarMensagem('qualidade ' + qualidadeTxt() + ' adaptada a este dispositivo · ' + alcanceTxt());
  }

  /* ---------- Rede de segurança durante o uso ---------- */
  // Só atua perante degradação séria e contínua; nunca sobe de nível; no máximo duas descidas por sessão.
  // Não grava o nível: na visita seguinte a calibração volta a verificar e decide sozinha.
  // Mede o tempo de quadro "vivido" (média ponderada pelo tempo): um quadro lento pesa mais do que um rápido.
  let redeAtiva = true, emergencias = 0, aposEmergencia = null;
  const TEMPO_VIVIDO_MAX = 28; // ms (~36 fps)
  function vigiar(agora) {
    if (estado.aCarregar || !redeAtiva || !automatico() || document.hidden) return; // só depois de o mapa abrir
    const dts = quadros.filter(q => agora - q.t < 4000).map(q => q.dt);
    const total = dts.reduce((a, b) => a + b, 0);
    if (total < 2500) return; // menos de 2,5 s de movimento recente: não conclui nada
    const vivido = dts.reduce((a, b) => a + b * b, 0) / total;
    if (vivido <= TEMPO_VIVIDO_MAX) { aposEmergencia = null; return; }
    if (aposEmergencia && vivido > aposEmergencia.vivido * 0.9) { // a descida anterior não ajudou: o limite não é nosso
      aplicar(aposEmergencia.nivel, false); redeAtiva = false;
      mostrarMensagem('fps limitados pelo dispositivo · qualidade mantida em ' + qualidadeTxt());
      return;
    }
    if (emergencias >= 2 || nivel >= NIVEIS.length - 1) { redeAtiva = false; return; }
    aposEmergencia = { vivido, nivel };
    emergencias++;
    aplicar(nivel + 1, false);
    mostrarMensagem('↓ qualidade ' + qualidadeTxt() + ' · ' + alcanceTxt() + ' · desempenho instável');
  }

  /* ---------- Leitor de FPS ---------- */
  let msgAte = 0, baixoVisivelAte = 0;
  function mostrarMensagem(txt) {
    if (!hud) return;
    hudMsg.textContent = txt;
    msgAte = performance.now() + 6000;
  }
  function fpsAtual(agora) {
    if (agora - ultimoRender > 400) return null; // parado
    const dts = quadros.filter(q => agora - q.t < 1500).map(q => q.dt);
    if (dts.length < 20) return null;
    return 1000 * dts.length / dts.reduce((a, b) => a + b, 0);
  }
  function atualizarHud(agora) {
    if (!hud) return;
    const fps = fpsAtual(agora), sempre = !!(elMostrar && elMostrar.checked);
    if (fps !== null) hudNum.textContent = Math.round(fps);
    else if (sempre) hudNum.textContent = '–';
    hud.dataset.n = fps === null ? '' : fps >= 55 ? 'ok' : fps >= 40 ? 'medio' : 'mau';
    if (fps !== null && fps < 45) baixoVisivelAte = agora + 4000;
    if (agora >= msgAte) hudMsg.textContent = sempre && nivel > 0 ? 'qualidade ' + qualidadeTxt() : '';
    hud.classList.toggle('visivel', sempre || agora < msgAte || agora < baixoVisivelAte);
  }

  /* ---------- Painel ---------- */
  if (elAuto) elAuto.addEventListener('change', () => {
    guardar(CH_AUTO, elAuto.checked ? '1' : '0');
    if (!elAuto.checked) guardar(CH_MANUAL, String(nivel)); // desligado: fica no nível atual, que passa a ser a escolha manual
    else { redeAtiva = true; emergencias = 0; aposEmergencia = null; }
    atualizarNivelUI();
  });
  // Escolha manual: ajusta já o nível e desliga o automático
  const nivelDaBarra = () => NIVEIS.length - 1 - (+elNivel.value);
  if (elNivel) {
    elNivel.addEventListener('input', () => mostrarNomeNivel(nivelDaBarra())); // durante o arrasto só muda o nome
    elNivel.addEventListener('change', () => { // ao largar aplica (evita recarregar tiles a cada passo)
      const i = nivelDaBarra();
      if (elAuto) { elAuto.checked = false; guardar(CH_AUTO, '0'); }
      guardar(CH_MANUAL, String(i));
      aplicar(i, false);
    });
  }
  if (elMostrar) elMostrar.addEventListener('change', () => guardar(CH_FPS, elMostrar.checked ? '1' : '0'));
  if (elRecal) elRecal.addEventListener('click', () => { try { localStorage.removeItem(CH_NIVEL); } catch (_) {} guardar(CH_AUTO, '1'); location.reload(); });
  document.addEventListener('visibilitychange', () => { quadros.length = 0; });

  setInterval(() => { const agora = performance.now(); atualizarHud(agora); vigiar(agora); }, 500);

  window.QualidadeAuto = { calibrar };
})();
