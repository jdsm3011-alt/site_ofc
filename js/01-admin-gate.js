(function(){
  var ADMINS = {
    "Daniel Machado": "tunics123",
    "José Fonseca": "tunics123",
    "Ruben Alves": "admin51",
    "Nuno Barbosa": "admin51",
    "Philips": "admin51"
  };
  var FORM_ENDPOINT = "https://formspree.io/f/xvzjojbj";
  var gate = document.getElementById('admin-gate');
  if(!gate) return;

  var SESSION_KEY = 'engenh-admin-auth';
  var pendingAuthCallback = null;

  var form = document.getElementById('admin-gate-form');
  var userInput = document.getElementById('admin-gate-user');
  var passInput = document.getElementById('admin-gate-pass');
  var errorMsg = document.getElementById('admin-gate-error');

  function notify(subject, message) {
    try {
      var fd = new FormData();
      fd.append('_subject', subject);
      fd.append('message', message);
      fetch(FORM_ENDPOINT, {
        method: 'POST',
        body: fd,
        headers: { 'Accept': 'application/json' }
      }).catch(function(){ /* falha de rede não deve bloquear o fluxo */ });
    } catch(e) {}
  }

  function showGate() {
    errorMsg.style.display = 'none';
    passInput.value = '';
    gate.style.display = 'flex';
    setTimeout(function(){ userInput.focus(); }, 0);
  }

  function hideGate() {
    gate.style.display = 'none';
  }

  try {
    if (sessionStorage.getItem(SESSION_KEY) === '1') {
      hideGate();
      window.currentAdminUser = sessionStorage.getItem('engenh-admin-user') || null;
    }
  } catch(e) {}

  if (form) {
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var user = (userInput.value || '').trim();
      var pass = passInput.value || '';

      if (ADMINS.hasOwnProperty(user) && ADMINS[user] === pass) {
        errorMsg.style.display = 'none';
        try { sessionStorage.setItem(SESSION_KEY, '1'); } catch(e) {}
        try { sessionStorage.setItem('engenh-admin-user', user); } catch(e) {}
        window.currentAdminUser = user;
        hideGate();

        notify('Acesso - Engenh', user + ' acedeu à componente Engenh em ' + new Date().toLocaleString('pt-PT') + '.');

        if (user === 'José Fonseca') {
          showWelcomeToast();
        }

        if (typeof pendingAuthCallback === 'function') {
          var cb = pendingAuthCallback;
          pendingAuthCallback = null;
          cb();
        }
      } else {
        errorMsg.style.display = 'block';
        passInput.value = '';
        notify('Tentativa de acesso falhada - Engenh', 'Tentativa de acesso falhada. Utilizador introduzido: "' + (user || '(vazio)') + '" em ' + new Date().toLocaleString('pt-PT') + '.');
      }
    });
  }

  /* Atalho Ctrl+Alt+L: bypass direto (atalho pessoal, não faz notificação) */
  function playBypassAnimation(cb) {
    var ov = document.createElement('div');
    ov.id = 'bypass-anim-overlay';
    ov.innerHTML =
      '<div class="bypass-noise"></div>' +
      '<div class="bypass-anim-text">' +
        '<span class="l1">&gt; auth_check.......... <b>FAIL</b></span>' +
        '<span class="l2">&gt; override_flag........ <b>SET</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
         '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
        '<span class="l3">&gt; bypass_______________ <b>OK</b></span>' +
      '</div>';
    document.body.appendChild(ov);

    if (!document.getElementById('bypass-anim-style')) {
      var st = document.createElement('style');
      st.id = 'bypass-anim-style';
      st.textContent = [
        '#bypass-anim-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;',
        'background:#000;opacity:0;animation:bypassFlicker .6s steps(2,end) forwards;overflow:hidden;}',
        '#bypass-anim-overlay .bypass-noise{position:absolute;inset:0;',
        'background:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0px,rgba(255,255,255,.05) 1px,transparent 1px,transparent 3px);',
        'mix-blend-mode:overlay;animation:bypassScan .12s steps(3,end) infinite;}',
        '#bypass-anim-overlay .bypass-anim-text{font-family:"IBM Plex Mono",monospace;font-size:12px;line-height:1.9;',
        'color:#8f8f8f;text-align:left;display:flex;flex-direction:column;gap:2px;}',
        '#bypass-anim-overlay .bypass-anim-text b{color:#fff;font-weight:600;}',
        '#bypass-anim-overlay .l1,#bypass-anim-overlay .l2,#bypass-anim-overlay .l3{opacity:0;transform:translateX(-3px);}',
        '#bypass-anim-overlay .l1{animation:bypassLine .15s steps(1,end) .05s forwards;}',
        '#bypass-anim-overlay .l2{animation:bypassLine .15s steps(1,end) .18s forwards;}',
        '#bypass-anim-overlay .l3{animation:bypassLine .15s steps(1,end) .32s forwards;}',
        '@keyframes bypassFlicker{0%{opacity:0;}8%{opacity:1;}12%{opacity:.4;}16%{opacity:1;}70%{opacity:1;}100%{opacity:0;}}',
        '@keyframes bypassScan{0%{transform:translateY(0);}100%{transform:translateY(3px);}}',
        '@keyframes bypassLine{to{opacity:1;transform:translateX(0);}}'
      ].join('');
      document.head.appendChild(st);
    }

    setTimeout(function(){
      ov.remove();
      if (typeof cb === 'function') cb();
    }, 600);
  }

  document.addEventListener('keydown', function(e){
    if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L')) {
      var gateVisible = gate && window.getComputedStyle(gate).display !== 'none';
      if (!gateVisible) return;
      e.preventDefault();
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch(err) {}
      playBypassAnimation(function(){
        hideGate();
        if (typeof pendingAuthCallback === 'function') {
          var cb = pendingAuthCallback;
          pendingAuthCallback = null;
          cb();
        }
      });
    }
  });

  /* Hook público: pede reautenticação com o mesmo modal antes de correr onSuccess */
  window.adminGateRequireAuth = function(onSuccess){
    pendingAuthCallback = onSuccess;
    showGate();
  };
})();
