(() => {
  const pages = {
    kaynakca: { title: 'Kaynakça doğrulama', heading: 'Kaynakçanızı doğrulayın.', description: 'Kaynak listenizi yapıştırın, akademik kayıtlarla karşılaştırın ve düzeltilmiş APA 7 çıktısını alın.' },
    word: { title: 'Yetim Kaynak kontrolü', heading: 'Makalenizdeki atıfları denetleyin.', description: 'Word dosyanızı yükleyin. Kaynakça eşleşmelerini, yetim atıfları ve yazar–yıl uyuşmazlıklarını inceleyin.' },
    icerik: { title: 'İçerik kontrolü', heading: 'Atıflarınızın kanıtını inceleyin.', description: 'Atıf cümlelerini ilgili yayınlarla karşılaştırın. İddiaları, bağlamı ve kaynak pasajlarını birlikte değerlendirin.' },
  };
  let current;
  function readRoute() {
    const route = location.hash.match(/^#\/(kaynakca|word|icerik)(?:$|[/?])/);
    // Keep old document paragraph bookmarks useful.
    return route?.[1] || (location.hash.startsWith('#word-p-') ? 'word' : current || 'kaynakca');
  }
  function render() {
    const next = readRoute(), changed = current !== next;
    current = next;
    document.body.dataset.page = current;
    for (const key of Object.keys(pages)) document.getElementById('page-' + key).hidden = key !== current;
    document.querySelectorAll('[data-page-link]').forEach(link => {
      if (link.dataset.pageLink === current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.querySelector('.hero h1').textContent = pages[current].heading;
    document.querySelector('.hero-lede').textContent = pages[current].description;
    document.title = pages[current].title + ' — Kaynakça Masası';
    if (changed) window.dispatchEvent(new CustomEvent('app-page-change', { detail: { page: current } }));
    if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.AppPages = { current: () => current, navigate(page) { if (!pages[page]) return; location.hash = '#/' + page; render(); } };
  window.addEventListener('hashchange', render);
  render();
})();
