/* clang-format off */
(function () {
  if (typeof window === 'undefined') return;
  var hadNativeArrays =
    Array.isArray(window.__minibookBootErrors) && Array.isArray(window.__minibookCSPViolations);
  var bootErrors = (window.__minibookBootErrors = window.__minibookBootErrors || []);
  var cspViolations = (window.__minibookCSPViolations = window.__minibookCSPViolations || []);

  function renderFallbackIfUnmounted() {
    if (window.__minibookMounted) return;
    var root = typeof document !== 'undefined' && document.getElementById('root');
    if (!root || root.children.length > 0) return;
    var details = bootErrors.concat(cspViolations).join('\n') || 'Application bundle did not finish mounting.';

    var wrap = document.createElement('main');
    wrap.className = 'mb-boot-error';
    wrap.setAttribute('role', 'alert');
    wrap.setAttribute('data-testid', 'boot-error-card');

    var card = document.createElement('div');
    card.className = 'mb-boot-error-card';

    var h1 = document.createElement('h1');
    h1.className = 'mb-boot-error-title';
    h1.textContent = 'Books';

    var p = document.createElement('p');
    p.className = 'mb-boot-error-desc';
    p.textContent = 'Something interrupted startup. Your books and reading progress are safe.';

    var pre = document.createElement('pre');
    pre.className = 'mb-boot-error-detail';
    pre.textContent = details;

    var actions = document.createElement('div');
    actions.className = 'mb-boot-error-actions';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mb-primary-btn';
    btn.textContent = 'Reload';
    btn.addEventListener('click', function () {
      window.location.reload();
    });

    if (!document.styleSheets || document.styleSheets.length === 0) {
      wrap.style.cssText = 'padding:32px 24px;font-family:-apple-system,system-ui,sans-serif;color:#1C1C1E;background:#FFFFFF;min-height:100vh;';
      card.style.cssText = 'max-width:420px;margin:48px auto;border:1px solid #E5E5EA;border-radius:16px;padding:24px;';
      pre.style.cssText = 'font-size:12px;background:#F2F2F7;padding:10px 12px;border-radius:6px;white-space:pre-wrap;word-break:break-word;margin:12px 0;';
      btn.style.cssText = 'min-height:44px;padding:0 18px;border-radius:10px;border:none;background:#1C1C1E;color:#FFFFFF;font-size:16px;font-weight:600;cursor:pointer;';
    }

    actions.appendChild(btn);
    card.appendChild(h1);
    card.appendChild(p);
    card.appendChild(pre);
    card.appendChild(actions);
    wrap.appendChild(card);
    root.appendChild(wrap);
  }

  var scheduled = false;
  function scheduleCheck(delayMs) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      renderFallbackIfUnmounted();
    }, delayMs);
  }

  if (!hadNativeArrays && window.addEventListener) {
    window.addEventListener('securitypolicyviolation', function (e) {
      cspViolations.push(e.violatedDirective + ':' + e.blockedURI);
      scheduleCheck(250);
    });
    window.addEventListener(
      'error',
      function (e) {
        var t = e && e.target;
        if (t && t.tagName) {
          bootErrors.push('tag:' + t.tagName + ':' + (t.src || t.href || ''));
        } else {
          bootErrors.push('err:' + (e && e.message ? e.message : String(e)));
        }
        scheduleCheck(250);
      },
      true,
    );
    window.addEventListener('unhandledrejection', function (e) {
      bootErrors.push('rej:' + String(e && e.reason));
      scheduleCheck(250);
    });
  } else if (window.addEventListener) {
    window.addEventListener(
      'error',
      function () {
        scheduleCheck(250);
      },
      true,
    );
    window.addEventListener('unhandledrejection', function () {
      scheduleCheck(250);
    });
  }

  setTimeout(function () {
    if (!window.__minibookMounted && (bootErrors.length > 0 || cspViolations.length > 0)) {
      renderFallbackIfUnmounted();
    }
  }, 8000);
})();
