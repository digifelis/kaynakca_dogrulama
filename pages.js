(() => {
  const pages = {
    kaynakca: { title: 'Kaynakça doğrulama', heading: 'Kaynakçanızı doğrulayın.', description: 'Kaynak listenizi yapıştırın, akademik kayıtlarla karşılaştırın ve düzeltilmiş APA 7, Vancouver veya IEEE çıktısını alın.' },
    word: { title: 'Yetim Kaynak kontrolü', heading: 'Makalenizdeki atıfları denetleyin.', description: 'Word veya PDF dosyanızı yükleyin. Kaynakça eşleşmelerini, yetim atıfları ve yazar–yıl uyuşmazlıklarını inceleyin.' },
    yazim: { title: 'Yazım yardımcısı', heading: 'Kaynaklarınızla makale yazın.', description: 'Kaynaklarınızı adlandırdığınız koleksiyonlarda toplayın; bir projede istediğiniz koleksiyonları seçip sorularınızı kaynaklara dayanarak yanıtlatın ve cevapları kademe kademe makalenize ekleyin.' },
    giris: { title: 'Giriş', heading: 'Hesabınıza giriş yapın.', description: 'Yazım yardımcısı, Word ve içerik kontrolü kişisel hesabınızla çalışır.' },
    profil: { title: 'Profil', heading: 'Hesabınız.', description: 'Profil bilgileriniz, paketiniz ve token kullanımınız.' },
    admin: { title: 'Yönetim paneli', heading: 'Yönetim paneli.', description: 'Kullanıcılar, paketler, işlemler ve ayarlar.' },
    icerik: { title: 'İçerik kontrolü', heading: 'Atıflarınızın kanıtını inceleyin.', description: 'Atıf cümlelerini ilgili yayınlarla karşılaştırın. İddiaları, bağlamı ve kaynak pasajlarını birlikte değerlendirin.' },
  };
  // Sign-in, registration and password screens share one page; the route decides which form it shows.
  const ACCOUNT_ROUTES = ['giris', 'kayit', 'sifremi-unuttum', 'sifre-sifirla', 'parola-degistir'];
  const BARE_PAGES = ['giris', 'profil', 'admin'];
  let current;
  function readRoute() {
    const route = location.hash.match(/^#\/(kaynakca|word|icerik|yazim|giris|kayit|sifremi-unuttum|sifre-sifirla|parola-degistir|profil|admin)(?:$|[/?])/);
    // Keep old document paragraph bookmarks useful.
    if (route) return ACCOUNT_ROUTES.includes(route[1]) ? 'giris' : route[1];
    return location.hash.startsWith('#word-p-') ? 'word' : current || 'kaynakca';
  }
  function render() {
    const next = readRoute();
    // Accounts (auth-app.js) decide whether this person may see the page; without that script every page is open.
    const gate = window.Auth?.gate ? window.Auth.gate(next) : null;
    if (gate === 'wait') { for (const key of Object.keys(pages)) document.getElementById('page-' + key).hidden = true; document.getElementById('page-locked').hidden = true; return; }
    if (gate) { location.hash = gate; return; }
    const changed = current !== next;
    current = next;
    document.body.dataset.page = current;
    // A page the plan does not include shows the notice instead of its content.
    const locked = window.Auth?.lock ? window.Auth.lock(next) : null;
    for (const key of Object.keys(pages)) document.getElementById('page-' + key).hidden = locked || key !== current;
    document.getElementById('page-locked').hidden = !locked;
    if (locked) { document.getElementById('locked-title').textContent = locked.title; document.getElementById('locked-text').textContent = locked.text; }
    document.querySelectorAll('[data-page-link]').forEach(link => {
      if (link.dataset.pageLink === current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.querySelector('.hero h1').textContent = pages[current].heading;
    document.querySelector('.hero-lede').textContent = pages[current].description;
    document.title = pages[current].title + ' — Kaynakça Masası';
    document.querySelector('.hero').hidden = BARE_PAGES.includes(current);
    if (changed || current === 'giris') window.dispatchEvent(new CustomEvent('app-page-change', { detail: { page: current } }));
    if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  window.AppPages = { current: () => current, navigate(page) { if (!pages[page]) return; location.hash = '#/' + page; render(); } };
  window.addEventListener('hashchange', render);
  window.addEventListener('auth-change', render);
  render();
})();
