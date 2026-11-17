(() => {
  const root = document.querySelector('#direction-c');
  if (!root) return;
  const all = selector => [...root.querySelectorAll(selector)];
  const one = selector => root.querySelector(selector);
  let pending;
  function status(name) {
    all('.c-status > span').forEach(node => { node.hidden = !node.hasAttribute(`data-c-status-${name}`); });
  }
  function screen(name) {
    all('[data-c-screen]').forEach(node => { node.hidden = node.dataset.cScreen !== name; });
  }
  function connection() {
    clearTimeout(pending);
    all('[data-c-pin], [data-c-pin-compare]').forEach(button => { button.disabled = false; });
    const offline = one('[data-c-offline]').checked;
    all('[data-c-live]').forEach(node => { node.hidden = offline; });
    all('[data-c-cached]').forEach(node => { node.hidden = !offline; });
    all('[data-c-host-only]').forEach(node => {
      node.hidden = offline;
      node.querySelectorAll('input').forEach(input => { input.disabled = offline; if (offline) input.checked = false; });
    });
    status(offline ? 'offline' : 'idle');
  }
  function pin(hasSelection) {
    clearTimeout(pending);
    if (!hasSelection) { status('empty'); return; }
    status('saving');
    all('[data-c-pin], [data-c-pin-compare]').forEach(button => { button.disabled = true; });
    pending = setTimeout(() => {
      status('ready');
      all('[data-c-pin], [data-c-pin-compare]').forEach(button => { button.disabled = false; });
    }, 650);
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button)) return;
    if (button.hasAttribute('data-c-open') || button.hasAttribute('data-c-theme')) screen('theme');
    if (button.hasAttribute('data-c-home')) screen('overview');
    if (button.hasAttribute('data-c-compare')) screen('compare');
    if (button.hasAttribute('data-c-expand')) {
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded));
      one('[data-c-variants]').hidden = !expanded;
    }
    if (button.hasAttribute('data-c-save-open')) {
      one('[data-c-save-panel]').hidden = !one('[data-c-save-panel]').hidden;
      if (!one('[data-c-save-panel]').hidden) one('[data-c-view-name]').focus();
    }
    if (button.hasAttribute('data-c-save-confirm')) {
      const input = one('[data-c-view-name]');
      if (!input.value.trim()) { input.focus(); return; }
      const fragment = one('[data-c-saved-template]').content.cloneNode(true);
      fragment.querySelector('button').textContent = input.value.trim();
      one('[data-c-saved-list]').replaceChildren(fragment);
      one('[data-c-saved]').hidden = false;
      one('[data-c-save-panel]').hidden = true;
      status('saved');
    }
    if (button.hasAttribute('data-c-pin')) pin(all('[data-c-select]').some(input => input.checked && !input.disabled));
    if (button.hasAttribute('data-c-pin-compare')) pin(Boolean(one('input[name="c-choice"]:checked')));
    if (button.hasAttribute('data-c-reset')) {
      clearTimeout(pending);
      one('[data-c-offline]').checked = false;
      one('[data-c-view-name]').value = one('[data-c-view-name]').defaultValue;
      all('[data-c-select]').forEach(input => { input.checked = input.defaultChecked; });
      all('input[name="c-choice"]').forEach(input => { input.checked = input.defaultChecked; });
      all('[data-c-variants], [data-c-save-panel], [data-c-saved]').forEach(node => { node.hidden = true; });
      all('[data-c-pin], [data-c-pin-compare]').forEach(node => { node.disabled = false; });
      one('[data-c-expand]').setAttribute('aria-expanded', 'false');
      one('[data-c-saved-list]').replaceChildren();
      connection();
      screen('overview');
    }
  });
  one('[data-c-offline]').addEventListener('change', connection);
})();
