/**
 * 22-satellite-menu.js
 * ---------------------------------------------------------------------------
 * Menu "Deteção remota" no cabeçalho — ponto de entrada único para as opções
 * de satélite/Sentinel-2 da app:
 *
 *   - "Analisar NDVI/NBR/NDWI/NDBI" — as ferramentas de js/21-ndvi.js
 *     (o clique é tratado lá, em wireButton(); aqui o menu só fecha).
 *   - "Processar por município" — pesquisa de concelho (mesma lógica do
 *     portal DataGis: MUNICIPIOS_INDEX + normalizeAccents) que pede a
 *     js/21-ndvi.js para buscar o limite CAOP e correr o índice escolhido.
 *
 * Este ficheiro trata de abrir/fechar/posicionar o dropdown e da vista de
 * pesquisa de município — o mesmo padrão do menu de automatização
 * (js/08-tools-menu.js): position:fixed + getBoundingClientRect, fecho por
 * clique fora / Escape / resize.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var btn = document.getElementById('btn-satellite');
  var menu = document.getElementById('satellite-menu-dropdown');
  if (!btn || !menu) return;

  var INDEX_KEYS = ['ndvi', 'nbr', 'ndwi', 'ndbi'];
  var selectedIndex = 'ndvi';
  var selectedYear = 'auto';

  function showView(name) {
    ['main', 'municipio'].forEach(function (v) {
      var el = menu.querySelector('[data-sm-view="' + v + '"]');
      if (el) el.classList.toggle('hidden', v !== name);
    });
  }

  function setSelectedIndex(key, silent) {
    selectedIndex = INDEX_KEYS.indexOf(key) !== -1 ? key : 'ndvi';
    Array.prototype.forEach.call(menu.querySelectorAll('.sm-idx-chip'), function (chip) {
      chip.classList.toggle('is-active', chip.dataset.smIdx === selectedIndex);
    });
    if (!silent && searchInput) searchInput.focus();
  }

  function setSelectedYear(key, silent) {
    selectedYear = String(key || 'auto');
    Array.prototype.forEach.call(menu.querySelectorAll('.sm-year-chip'), function (chip) {
      chip.classList.toggle('is-active', chip.dataset.smYear === selectedYear);
    });
    if (!silent && searchInput) searchInput.focus();
  }

  function openMenu() {
    var rect = btn.getBoundingClientRect();
    menu.classList.remove('hidden');
    var menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    // sincroniza o chip de índice com o último usado pela ferramenta
    try {
      var activeIdx = window.ndviTool && window.ndviTool.activeIndex
        ? window.ndviTool.activeIndex
        : 'ndvi';
      setSelectedIndex(activeIdx, true);
    } catch (e) {}
  }

  function closeMenu() {
    menu.classList.add('hidden');
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    showView('main');
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu(); else closeMenu();
  });

  /* fecha ao escolher uma opção do menu (exceto "Processar por município" e "Processar") */
  Array.prototype.slice.call(menu.querySelectorAll('.satellite-menu-item')).forEach(function (item) {
    if (item.id === 'sm-municipio-trigger' || item.id === 'sm-processar') return;
    item.addEventListener('click', function () { closeMenu(); });
  });

  /* ---------- vista "Processar por município" ---------- */

  var searchInput = document.getElementById('sm-municipio-search');
  var resultsEl = document.getElementById('sm-municipio-results');
  var statusEl = document.getElementById('sm-municipio-status');

  // Constrói os chips de ano (o mais recente primeiro) até 2016.
  var YEAR_FROM = 2016;
  function buildYearChips() {
    var wrap = document.getElementById('sm-municipio-years');
    if (!wrap || wrap.dataset.smBuilt) return;
    wrap.dataset.smBuilt = '1';
    wrap.innerHTML = '';
    var years = [];
    var nowYear = new Date().getFullYear();
    for (var y = nowYear; y >= YEAR_FROM; y--) years.push(String(y));

    function makeChip(value, label, i18nKey) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sm-year-chip';
      b.dataset.smYear = value;
      b.textContent = label;
      if (i18nKey) b.setAttribute('data-i18n', i18nKey);
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        setSelectedYear(b.dataset.smYear);
      });
      wrap.appendChild(b);
      return b;
    }

    makeChip('auto', 'Mais recente', 'txt.mais_recente');
    years.forEach(function (y) { makeChip(y, y); });
    setSelectedYear('auto', true);
  }
  buildYearChips();

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('is-error', !!isError);
    statusEl.classList.toggle('is-loading', !!text && !isError);
  }

  function renderResults(list) {
    resultsEl.innerHTML = '';
    if (!list.length) {
      var li = document.createElement('li');
      li.style.cursor = 'default';
      li.textContent = (window.i18n && typeof window.i18n.t === 'function')
        ? window.i18n.t('txt.nenhum_concelho_encontrado')
        : 'Nenhum concelho encontrado.';
      resultsEl.appendChild(li);
      return;
    }
    list.forEach(function (it) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = it.m;
      var dist = document.createElement('span');
      dist.className = 'distrito';
      dist.textContent = it.d;
      li.appendChild(name);
      li.appendChild(dist);
      li.addEventListener('click', function () {
        if (window.ndviTool && typeof window.ndviTool.processMunicipio === 'function') {
          window.ndviTool.processMunicipio(it, selectedIndex, selectedYear);
        }
      });
      resultsEl.appendChild(li);
    });
  }

  function doSearch(q) {
    var norm = (typeof normalizeAccents === 'function' ? normalizeAccents(q.trim()) : q.trim());
    resultsEl.innerHTML = '';
    setStatus('');
    if (!norm) return;
    var index = (typeof MUNICIPIOS_INDEX !== 'undefined') ? MUNICIPIOS_INDEX : [];
    var matches = index
      .filter(function (it) {
        return (typeof normalizeAccents === 'function' ? normalizeAccents(it.m) : it.m).indexOf(norm) !== -1;
      })
      .slice(0, 8);
    renderResults(matches);
  }

  var trigger = document.getElementById('sm-municipio-trigger');
  if (trigger) {
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      showView('municipio');
      searchInput.value = '';
      resultsEl.innerHTML = '';
      setStatus('');
      searchInput.focus();
    });
  }

  var backBtn = document.getElementById('sm-municipio-back');
  if (backBtn) {
    backBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      showView('main');
      // Esconder botão Processar ao voltar
      var procBtn = document.getElementById('sm-processar');
      if (procBtn) procBtn.classList.add('hidden');
    });
  }

  Array.prototype.forEach.call(menu.querySelectorAll('.sm-idx-chip'), function (chip) {
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      setSelectedIndex(chip.dataset.smIdx);
    });
  });

  if (searchInput) {
    var searchTimer = null;
    searchInput.addEventListener('input', function(){
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function(){ doSearch(searchInput.value); }, 180);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        e.preventDefault();
        clearTimeout(searchTimer);
        doSearch(searchInput.value);
      }
    });
  }

  /* fecha ao clicar fora (mesmo padrão do resto da app) */
  document.addEventListener('click', function (e) {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeMenu();
    }
  });

  /* reposiciona se a janela for redimensionada com o menu aberto */
  window.addEventListener('resize', function () {
    if (!menu.classList.contains('hidden')) openMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !menu.classList.contains('hidden')) closeMenu();
  });
})();
