(function(){
  var gate = document.getElementById('admin-gate');
  if(!gate) return;

  var body = document.getElementById('admin-gate-body');
  var pendingAuthCallback = null;

  function hideGate() {
    gate.style.display = 'none';
  }

  function grantAccess(cb) {
    try { sessionStorage.setItem('engenh-admin-auth', '1'); } catch(e) {}
    hideGate();
    if (typeof cb === 'function') cb();
  }

  /* Animação de loading (linhas de texto estilo terminal) — mantida tal
     como no bloqueio original, apenas sem exigir credenciais no final. */
  function playLoadingAnimation(cb) {
    if (!body) { cb && cb(); return; }

    body.innerHTML =
      '<div class="gate-loading-text">' +
        '<span class="l1">&gt; auth_check.......... <b>OK</b></span>' +
        '<span class="l2">&gt; a carregar módulos... <b>OK</b></span>' +
        '<span class="l3">&gt; init_workspace....... <b>OK</b></span>' +
      '</div>';

    if (!document.getElementById('gate-loading-style')) {
      var st = document.createElement('style');
      st.id = 'gate-loading-style';
      st.textContent = [
        '.gate-loading-text{font-family:"IBM Plex Mono",monospace;font-size:12px;line-height:1.9;',
        'color:#8f8f8f;text-align:left;display:flex;flex-direction:column;gap:2px;padding:8px 0;}',
        '.gate-loading-text b{color:#fff;font-weight:600;}',
        '.gate-loading-text .l1,.gate-loading-text .l2,.gate-loading-text .l3{opacity:0;transform:translateX(-3px);}',
        '.gate-loading-text .l1{animation:gateLoadLine .15s steps(1,end) .05s forwards;}',
        '.gate-loading-text .l2{animation:gateLoadLine .15s steps(1,end) .35s forwards;}',
        '.gate-loading-text .l3{animation:gateLoadLine .15s steps(1,end) .65s forwards;}',
        '@keyframes gateLoadLine{to{opacity:1;transform:translateX(0);}}'
      ].join('');
      document.head.appendChild(st);
    }

    setTimeout(function(){ if (typeof cb === 'function') cb(); }, 900);
  }

  playLoadingAnimation(function(){
    grantAccess(function(){
      if (typeof pendingAuthCallback === 'function') {
        var cb = pendingAuthCallback;
        pendingAuthCallback = null;
        cb();
      }
    });
  });

  /* Hook público mantido por compatibilidade com o resto da app —
     o acesso já está livre, por isso corre logo o callback. */
  window.adminGateRequireAuth = function(onSuccess){
    if (typeof onSuccess === 'function') onSuccess();
  };
})();
