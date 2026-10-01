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
