(() => {
  // File inputs cover their drop zones, so dropping a file uses the native input; this only shows the drag state.
  for (const zone of document.querySelectorAll('.upload-zone')) {
    const input = zone.querySelector('input[type="file"]');
    if (!input) continue;
    const set = on => zone.classList.toggle('is-dragging', on && !input.disabled);
    input.addEventListener('dragenter', () => set(true));
    input.addEventListener('dragover', () => set(true));
    input.addEventListener('dragleave', () => set(false));
    input.addEventListener('drop', () => set(false));
    input.addEventListener('change', () => set(false));
  }
  // The document list starts open for a new visit and folds away once a document is open.
  for (const panel of document.querySelectorAll('.word-workbench > div[id$="-panel"]')) {
    const library = panel.parentElement.querySelector('.document-library');
    if (!library) continue;
    let wasHidden = panel.classList.contains('hidden');
    new MutationObserver(() => {
      const hidden = panel.classList.contains('hidden');
      if (wasHidden && !hidden) library.open = false;
      if (!wasHidden && hidden) library.open = true;
      wasHidden = hidden;
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    if (!wasHidden) library.open = false;
  }
})();

// "Yukarı çık" button on every page: appears once the page is scrolled down and returns to the top.
(() => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'to-top';
  button.hidden = true;
  button.setAttribute('aria-label', 'Sayfanın başına git');
  button.title = 'Sayfanın başına git';
  button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.body.appendChild(button);
  const update = () => { button.hidden = window.scrollY < 400; };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('hashchange', update);
  button.addEventListener('click', () => {
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  });
  update();
})();
