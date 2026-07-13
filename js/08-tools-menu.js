(function(){
  /* ============================================================
     MENU "AUTOMATIZAÇÃO" — combina os botões CAD e Sync num só.
     Este módulo só trata de abrir/fechar o dropdown, posicionando-o
     com position:fixed + getBoundingClientRect (o mesmo padrão já
     usado nos outros menus da app: ver openBasemapMenu/
     openOfflineAreasMenu em 05-app-main.js). Os cliques nos itens
     ("Importação CAD" / "Sincronização Inteligente") continuam a
     ser tratados pelos listeners já existentes em 07-cad-import.js
     e 06-smart-sync.js (mesmos IDs de sempre: #btn-cad-import e
     #btn-smart-sync) — este ficheiro só fecha o menu depois do clique.
     ============================================================ */
  var btn = document.getElementById('btn-automation-menu');
  var menu = document.getElementById('automation-menu-dropdown');
  if(!btn || !menu) return;

  function openMenu(){
    var rect = btn.getBoundingClientRect();
    menu.classList.remove('hidden');
    var menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
    btn.classList.add('is-active');
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu(){
    menu.classList.add('hidden');
    btn.classList.remove('is-active');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', function(e){
    e.stopPropagation();
    if(menu.classList.contains('hidden')) openMenu(); else closeMenu();
  });

  /* fecha ao escolher uma das duas ferramentas */
  Array.prototype.slice.call(menu.querySelectorAll('.automation-menu-item')).forEach(function(item){
    item.addEventListener('click', function(){ closeMenu(); });
  });

  /* fecha ao clicar fora (mesmo padrão usado no resto da app) */
  document.addEventListener('click', function(e){
    if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      closeMenu();
    }
  });

  /* reposiciona se a janela for redimensionada com o menu aberto */
  window.addEventListener('resize', function(){
    if(!menu.classList.contains('hidden')) openMenu();
  });

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && !menu.classList.contains('hidden')) closeMenu();
  });
})();
