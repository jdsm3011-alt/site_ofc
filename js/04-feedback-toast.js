(function () {
  var toast = document.getElementById('feedback-toast');
  if (!toast) return;

  var STORAGE_KEY = 'datagis-feedback-dismissed';
  var alreadyDismissed = false;
  try {
    alreadyDismissed = sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch (e) { /* sessionStorage indisponível, ignora */ }

  var showTimer;

  function dismiss() {
    clearTimeout(showTimer);
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
    window.setTimeout(function () {
      toast.classList.remove('is-leaving');
    }, 320);
    try { sessionStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* ignora */ }
  }

  var closeBtn = document.getElementById('feedback-toast-close');
  if (closeBtn) closeBtn.addEventListener('click', dismiss);

  var form = document.getElementById('feedback-toast-form');
  var thanks = document.getElementById('feedback-toast-thanks');
  var errorMsg = document.getElementById('feedback-toast-error');
  var submitBtn = document.getElementById('feedback-toast-submit');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (errorMsg) errorMsg.hidden = true;
      if (submitBtn) submitBtn.disabled = true;

      fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { 'Accept': 'application/json' }
      })
        .then(function (response) {
          if (response.ok) {
            form.classList.add('is-hiding');
            setTimeout(function () {
              form.style.display = 'none';
              if (thanks) thanks.hidden = false;
            }, 250);
            setTimeout(dismiss, 3000);
          } else {
            throw new Error('Resposta não-ok do servidor');
          }
        })
        .catch(function () {
          if (errorMsg) errorMsg.hidden = false;
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  var navFeedbackBtn = document.getElementById('feedback-nav-btn');
  if (navFeedbackBtn) {
    navFeedbackBtn.addEventListener('click', function () {
      clearTimeout(showTimer);
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignora */ }
      toast.classList.remove('is-leaving');
      toast.classList.add('is-visible');
    });
  }

  if (alreadyDismissed) return;

  showTimer = setTimeout(function () {
    toast.classList.add('is-visible');
  }, 30000);
})();
