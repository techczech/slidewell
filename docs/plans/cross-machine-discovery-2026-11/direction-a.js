(() => {
  const root = document.querySelector('#direction-a');
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const cards = [...root.querySelectorAll('[data-item]')];
  const copy = key => root.querySelector(`[data-copy-key="${key}"]`).textContent;
  let mode = 'words', selected = cards[0], similar = false, timer;
  const pinned = new Set();
  const offline = () => $('[data-offline]').checked;
  const local = card => card.dataset.cachedItem === 'true' || pinned.has(card.dataset.item);
  function inspect() {
    cards.forEach(card => card.setAttribute('aria-pressed', String(card === selected)));
    $('[data-preview]').replaceChildren(selected.querySelector('.a-slide').cloneNode(true));
    $('[data-detail]').replaceChildren(selected.querySelector('template').content.cloneNode(true));
    $('[data-local-state]').textContent = copy(local(selected) ? 'local' : offline() ? 'unavailable' : 'remote');
    $('[data-pin]').disabled = local(selected) || offline();
    $('[data-reuse]').disabled = !local(selected);
  }
  function render() {
    const denied = $('[data-scope]').value !== 'personal';
    const blocked = offline() && mode !== 'words';
    $('[data-host-label]').textContent = copy(offline() ? 'offline' : 'connected');
    $('[data-banner]').hidden = !offline() && !denied;
    $('[data-banner]').textContent = copy(denied ? 'denied' : 'offlineBanner');
    $('[data-heading]').textContent = copy(similar ? 'similarHeading' : `${mode}Heading`);
    $('[data-explanation]').textContent = copy(similar ? 'similarExplanation' : `${mode}Explanation`);
    $('[data-seed]').hidden = mode !== 'picture';
    root.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    const query = $('[data-query]').value.toLocaleLowerCase().trim();
    cards.forEach(card => {
      const matches = mode !== 'words' || similar || !query || query.split(/\s+/).every(word => card.dataset.words.includes(word));
      card.hidden = denied || blocked || !matches || ($('[data-cached]').checked && !local(card));
      if (pinned.has(card.dataset.item)) card.querySelector('[data-item-status]').textContent = copy('pinnedBadge');
    });
    const visible = cards.filter(card => !card.hidden);
    $('[data-empty]').hidden = visible.length > 0;
    $('.a-inspector').hidden = !visible.length;
    if (visible.length) {
      if (selected.hidden) selected = visible[0];
      inspect();
    }
  }
  cards.forEach(card => card.addEventListener('click', () => { clearTimeout(timer); selected = card; inspect(); }));
  root.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; similar = false; render(); }));
  $('.a-toolbar').addEventListener('submit', event => { event.preventDefault(); similar = false; render(); });
  $('[data-offline]').addEventListener('change', () => { clearTimeout(timer); render(); });
  $('[data-cached]').addEventListener('change', render);
  $('[data-scope]').addEventListener('change', () => { clearTimeout(timer); render(); });
  $('[data-similar]').addEventListener('click', () => { mode = 'meaning'; similar = true; render(); });
  $('[data-seed-search]').addEventListener('click', render);
  $('[data-pin]').addEventListener('click', () => {
    const target = selected;
    $('[data-pin]').disabled = true;
    $('[data-local-state]').textContent = copy('pinning');
    timer = setTimeout(() => {
      pinned.add(target.dataset.item);
      render();
      if (selected === target) $('[data-local-state]').textContent = copy('pinned');
    }, 700);
  });
  $('[data-reuse]').addEventListener('click', () => { if (local(selected)) $('[data-local-state]').textContent = copy('ready'); });
  $('[data-reset]').addEventListener('click', () => {
    clearTimeout(timer); pinned.clear(); mode = 'words'; similar = false; selected = cards[0];
    $('[data-query]').value = $('[data-query]').defaultValue;
    $('[data-scope]').selectedIndex = 0;
    $('[data-offline]').checked = false; $('[data-cached]').checked = false;
    cards.forEach(card => { card.querySelector('[data-item-status]').textContent = card.dataset.originalStatus; });
    render();
  });
  cards.forEach(card => { card.dataset.originalStatus = card.querySelector('[data-item-status]').textContent; });
  render();
})();
