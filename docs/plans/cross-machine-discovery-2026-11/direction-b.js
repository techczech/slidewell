(() => {
  const root = document.querySelector('#direction-b');
  if (!root) return;
  const all = (s) => [...root.querySelectorAll(s)];
  const one = (s) => root.querySelector(s);
  const cards = all('[data-item]');
  const offline = one('[data-offline]');
  const paused = one('[data-paused]');
  let context = all('[data-context]')[0].dataset.context;
  const local = new Set(), inserted = new Set(), loading = new Set(), history = [];
  let generation = 0;
  function render() {
    all('[data-context]').forEach(b => b.setAttribute('aria-pressed', b.dataset.context === context));
    all('[data-draft]').forEach(e => e.hidden = e.dataset.draft !== context);
    all('[data-candidates]').forEach(e => e.hidden = paused.checked || e.dataset.candidates !== context);
    all('[data-panel-state]').forEach(e => e.hidden = e.dataset.panelState !== (paused.checked ? 'paused' : offline.checked ? 'offline' : 'online'));
    one('[data-live]').hidden = paused.checked;
    cards.forEach(card => {
      const id = card.dataset.item;
      const state = inserted.has(id) ? 'inserted' : loading.has(id) ? 'loading' : local.has(id) ? 'local' : 'remote';
      [...card.querySelectorAll('[data-asset-state]')].forEach(e => e.hidden = e.dataset.assetState !== state);
      card.querySelector('[data-materialise]').hidden = local.has(id) || inserted.has(id);
      card.querySelector('[data-materialise]').disabled = offline.checked || paused.checked || loading.has(id);
      card.querySelector('[data-insert]').hidden = !local.has(id) || inserted.has(id);
      card.querySelector('[data-insert]').disabled = paused.checked;
      card.querySelector('[data-inserted]').hidden = !inserted.has(id);
    });
    one('[data-undo]').disabled = history.length === 0;
    all('[data-edit-state]').forEach(e => e.hidden = e.dataset.editState !== (history.length ? 'edited' : 'clean'));
  }
  all('[data-context]').forEach(b => b.addEventListener('click', () => { context = b.dataset.context; render(); }));
  cards.forEach(card => {
    const id = card.dataset.item;
    card.querySelector('[data-materialise]').addEventListener('click', () => {
      if (offline.checked || paused.checked || loading.has(id) || local.has(id)) return;
      const requestedGeneration = generation;
      loading.add(id); render();
      setTimeout(() => {
        if (generation !== requestedGeneration || !loading.has(id)) return;
        loading.delete(id); local.add(id); render();
      }, 750);
    });
    card.querySelector('[data-insert]').addEventListener('click', () => {
      if (!local.has(id) || inserted.has(id) || paused.checked) return;
      const fragment = card.querySelector('[data-copy]').content.cloneNode(true);
      const node = fragment.firstElementChild;
      const target = all('[data-insertions]').find(e => e.dataset.insertions === context);
      target.append(fragment); inserted.add(id); history.push({id, node}); render();
    });
  });
  one('[data-undo]').addEventListener('click', () => {
    const last = history.pop(); if (!last) return;
    last.node.remove(); inserted.delete(last.id); render();
  });
  offline.addEventListener('change', () => { generation++; loading.clear(); render(); });
  paused.addEventListener('change', render);
  one('[data-reset]').addEventListener('click', () => {
    generation++; loading.clear(); local.clear(); inserted.clear(); history.length = 0;
    all('[data-insertions]').forEach(e => e.replaceChildren());
    all('details').forEach(e => e.open = false);
    offline.checked = false; paused.checked = false;
    context = all('[data-context]')[0].dataset.context; render();
  });
  render();
})();
