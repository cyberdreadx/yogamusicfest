(function () {
  window.createDiscountField = function (options) {
    var box = document.getElementById('discountBox');
    var input = box.querySelector('input'), button = box.querySelector('button'), message = box.querySelector('[role="status"]');
    var applied = '', percent = 0, revision = 0, busy = false, status = '';
    function es() { return options.language() === 'es'; }
    function render() {
      box.querySelector('label').textContent = es() ? 'Código de descuento' : 'Discount code';
      button.textContent = busy ? (es() ? 'Verificando…' : 'Checking…') : (es() ? 'Aplicar' : 'Apply');
      message.textContent = status === 'applied' ? (es() ? percent + '% de descuento aplicado' : percent + '% discount applied') :
        status === 'error' ? (es() ? 'No se pudo validar el código. Revisa el código e inténtalo de nuevo.' : 'Could not validate this code. Check it and try again.') :
        status === 'pending' ? (es() ? 'Aplica el código antes de continuar.' : 'Apply the code before continuing.') : '';
    }
    input.addEventListener('input', function () {
      revision++; applied = ''; percent = 0; status = ''; options.changed(); render();
    });
    async function apply() {
      if (busy) return;
      var code = input.value.trim().toUpperCase(), current = ++revision;
      applied = ''; percent = 0; status = ''; options.changed();
      if (!code) { render(); return; }
      busy = true; button.disabled = true; render();
      try {
        var response = await fetch('/.netlify/functions/create-checkout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'quote', quantity: options.quantity(), promoCode: code })
        });
        var data = await response.json();
        if (!response.ok || [50, 100].indexOf(data.percentOff) === -1) throw Error('Invalid code');
        if (current !== revision) return;
        applied = code; percent = data.percentOff; status = 'applied';
      } catch (_) { if (current === revision) status = 'error'; }
      finally { busy = false; button.disabled = false; options.changed(); render(); }
    }
    button.addEventListener('click', apply);
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); apply(); } });
    return {
      total: function (amount) { render(); return amount * (1 - percent / 100); },
      code: function () {
        if (busy || (input.value.trim() && !applied)) { status = 'pending'; render(); input.focus(); return null; }
        return applied;
      }
    };
  };
})();
