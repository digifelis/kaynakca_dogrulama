// Admin panel, "Raporlar" tab: system performance and what users experience (numbers come from /api/admin/reports/*).
// Only metadata: counts, times, tokens, status codes and user names, never documents or answers.
(() => {
  const SECTIONS = [['summary', 'Özet'], ['performance', 'Performans'], ['errors', 'Hatalar'], ['usage', 'Kaynak ve token'], ['experience', 'Kullanıcı deneyimi'], ['capacity', 'Kapasite']];
  const PERIODS = [['1', 'Son 24 saat'], ['7', 'Son 7 gün'], ['30', 'Son 30 gün'], ['90', 'Son 90 gün']];
  const KIND = { 'source-upload': 'Kaynak yükleme', 'scholar-import': 'Semantic Scholar içe aktarma', 'word-upload': 'Word/PDF yükleme', 'word-verify': 'Kaynakça doğrulama', ask: 'Soru-cevap', 'source-process': 'Kaynak işleme', 'source-embed': 'Kaynak vektörleme', 'content-check': 'İçerik kontrolü', 'scholar-import-op': 'Makale içe aktarma' };
  const LEVEL = { critical: 'Kritik', warning: 'Dikkat', info: 'Bilgi', good: 'İyi' };
  let section = 'summary', days = '7';

  function mount(panel, { h, fmt, api, table, cards, when, dur }) {
    const n = v => v == null ? '—' : fmt(v);
    const ms = v => v == null ? '—' : dur(v);
    const pct = v => v == null ? '—' : '%' + String(v).replace('.', ',');
    const kbps = v => v == null ? '—' : v >= 1024 ? (v / 1024).toFixed(1).replace('.', ',') + ' MB/sn' : fmt(v) + ' KB/sn';
    const td = (...cells) => h('tr', {}, cells.map(c => h('td', {}, c == null ? '—' : c)));
    const label = (at, bucketMs) => { const d = new Date(at); return bucketMs < 86400000 ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }); };
    const kindName = k => KIND[k] || k;
    const csv = (name, key) => h('a', { class: 'text-button', href: `/api/admin/reports/${name}?days=${days}&format=csv&table=${key}`, download: '' }, 'CSV indir');
    const heading = (text, csvLink) => h('div', { class: 'adm-heading' }, h('h3', {}, text), csvLink || null);

    // A bar chart over time; `unit` formats the tooltip. Empty buckets stay visible so gaps in the data are visible too.
    const chart = (rows, key, title, range, unit = n) => {
      const max = Math.max(1, ...rows.map(r => r[key] || 0));
      return h('div', { class: 'adm-chart' }, h('h4', {}, title),
        rows.some(r => r[key]) ? h('div', { class: 'adm-bars', role: 'img', 'aria-label': title }, rows.map(r => h('div', { class: 'adm-bar', title: `${when(r.at)}: ${unit(r[key])}` },
          h('span', { style: `height:${r[key] ? Math.max(2, r[key] / max * 100) : 0}%` }), h('small', {}, label(r.at, range.bucket)))))
          : h('p', { class: 'acct-muted' }, 'Bu dönemde veri yok.'));
    };
    const stacked = (rows, keys, title, range) => {
      const max = Math.max(1, ...rows.map(r => keys.reduce((t, [k]) => t + (r[k] || 0), 0)));
      return h('div', { class: 'adm-chart' }, h('h4', {}, title, ' ', ...keys.map(([, name, cls]) => h('span', { class: 'adm-legend ' + cls }, name))),
        rows.some(r => keys.some(([k]) => r[k])) ? h('div', { class: 'adm-bars', role: 'img', 'aria-label': title }, rows.map(r => h('div', { class: 'adm-bar', title: `${when(r.at)}: ` + keys.map(([k, name]) => `${name} ${n(r[k] || 0)}`).join(', ') },
          ...keys.map(([k, , cls]) => h('span', { class: cls, style: `height:${(r[k] || 0) / max * 100}%` })), h('small', {}, label(r.at, range.bucket)))))
          : h('p', { class: 'acct-muted' }, 'Bu dönemde hata yok.'));
    };

    // ---- sections
    const views = {
      summary(d) {
        const out = [h('div', { class: 'adm-insights' }, d.insights.map(i => h('div', { class: 'adm-insight is-' + i.level }, h('b', {}, LEVEL[i.level] + ': ' + i.title), i.detail ? h('p', {}, i.detail) : null, i.action ? h('p', { class: 'adm-action' }, 'Ne yapılabilir: ' + i.action) : null)))];
        out.push(heading('Sunucu'), cards([
          ['İstek', n(d.requests), `${n(d.errors4xx)} istemci hatası (4xx) · ${n(d.cancelled)} yarıda kesilen`], ['Sunucu hatası (5xx)', n(d.errors5xx), pct(d.errorRate) + ' oranında'],
          ['API yanıt süresi', ms(d.api.p50), `ortalama ${ms(d.api.avg)} · %95'i ${ms(d.api.p95)}`], ['Apdex', d.apdex == null ? '—' : String(d.apdex).replace('.', ','), `eşik ${ms(d.apdexT)} (1 en iyi)`]]));
        out.push(heading('Model ve dosya'), cards([
          ['Model cevap süresi', ms(d.llm.avg), `ortanca ${ms(d.llm.p50)} · %95'i ${ms(d.llm.p95)} · ${n(d.llm.n)} çağrı`], ['Model kota beklemesi', ms(d.llmWait.avg), `en çok ${ms(d.llmWait.max)}`],
          ['Dosya yükleme hızı', kbps(d.uploadSpeed.avg), `ortanca ${kbps(d.uploadSpeed.p50)} · ${n(d.uploadSpeed.n)} dosya`], ['Dosya işleme bekleme', ms(d.fileQueue.avg), `en çok ${ms(d.fileQueue.max)}`],
          ['Doğrulama çalışması', ms(d.verification.avgRunMs), `kaynak başına ${ms(d.verification.msPerReference)} · önbellek ${pct(d.verification.cachedShare)}`]]));
        out.push(heading('Kullanıcılar'), cards([
          ['Etkin kullanıcı', n(d.activeUsers), `${n(d.scoredUsers)} kullanıcının deneyimi ölçüldü`], ['Memnun kullanıcı', pct(d.satisfiedShare), `ortalama skor ${n(d.averageScore)} · ${n(d.poorUsers)} kötü`],
          ['Kullanıcı başı kaynak', n(d.perActiveUser.references), `toplam ${n(d.references)} sorgulanan kaynak`], ['Kullanıcı başı token', n(d.perActiveUser.tokens), `toplam ${n(d.tokens)}`]]));
        out.push(chart(d.series, 'requests', 'İstek sayısı', d.range), chart(d.series, 'p95Ms', "API yanıt süresi (%95, ms)", d.range, ms), chart(d.series, 'llmAvgMs', 'Model cevap süresi (ortalama, ms)', d.range, ms),
          stacked(d.series, [['errors5xx', '5xx', 'is-bad']], 'Sunucu hataları', d.range));
        return out;
      },
      performance(d) {
        return [
          cards([['API (ortanca / %95)', `${ms(d.api.p50)} / ${ms(d.api.p95)}`, `${n(d.api.n)} istek, en yavaş ${ms(d.api.max)}`], ['Model (ortanca / %95)', `${ms(d.llm.p50)} / ${ms(d.llm.p95)}`, `${n(d.llm.n)} başarılı çağrı`],
            ['Model kota beklemesi', ms(d.llmWait.avg), `en çok ${ms(d.llmWait.max)}`], ['Yükleme hızı (ortanca)', kbps(d.uploadSpeed.p50), `ortalama ${kbps(d.uploadSpeed.avg)}`],
            ['Dosya işleme beklemesi', ms(d.fileQueue.avg), `%95'i ${ms(d.fileQueue.p95)}`], ['Dosyanın baştan sona süresi', ms(d.fileTotal.avg), `%95'i ${ms(d.fileTotal.p95)}`]]),
          chart(d.series, 'p95Ms', "API yanıt süresi (%95)", d.range, ms), chart(d.series, 'llmAvgMs', 'Model cevap süresi (ortalama)', d.range, ms), chart(d.series, 'llmAvgWaitMs', 'Model kota beklemesi (ortalama)', d.range, ms),
          chart(d.series, 'uploadSpeedKbps', 'Dosya yükleme hızı (KB/sn)', d.range, kbps), chart(d.series, 'fileQueueMs', 'Dosya işleme beklemesi (ortalama)', d.range, ms), chart(d.series, 'verifyAvgMs', 'Doğrulama çalışma süresi (ortalama)', d.range, ms),
          heading('Sorgu (API) yolları — en yavaştan', csv('performance', 'routes')),
          table(['Yol', 'İstek', 'Ortalama', 'Ortanca', '%95', '%99', 'En çok', '4xx', '5xx', 'Kesilen', 'Apdex'], d.routes.slice(0, 40).map(r => td(r.route, n(r.requests), ms(r.avgMs), ms(r.p50Ms), ms(r.p95Ms), ms(r.p99Ms), ms(r.maxMs), n(r.errors4xx), n(r.errors5xx), n(r.cancelled), r.apdex))),
          heading('Model cevap süresi — modele göre', csv('performance', 'models')),
          table(['Sağlayıcı / model', 'Çağrı', 'Hata %', 'Ortalama', 'Ortanca', '%95', 'Ort. kota bekleme', 'Bekleme payı', 'Girdi token', 'Çıktı token', 'Çağrı başı token'], d.models.map(m => td(m.model, n(m.calls), pct(m.errorRate), ms(m.avgMs), ms(m.p50Ms), ms(m.p95Ms), ms(m.avgWaitMs), pct(m.waitShare), n(m.promptTokens), n(m.completionTokens), n(m.avgTokens)))),
          heading('Model çağrıları — işleme göre', csv('performance', 'llmByName')),
          table(['Çağrı', 'Sayı', 'Hata %', 'Ortalama', '%95', 'Ort. bekleme', 'Çağrı başı token'], d.llmByName.map(m => td(m.name, n(m.calls), pct(m.errorRate), ms(m.avgMs), ms(m.p95Ms), ms(m.avgWaitMs), n(m.avgTokens)))),
          heading('Dosya yükleme ve işleme', csv('performance', 'files')),
          table(['Tür', 'Dosya', 'Hata', 'Ort. boyut', 'Hız (ort.)', 'Hız (ortanca)', 'Alma', 'Sırada bekleme', 'Okuma', 'Vektörleme', 'Toplam', 'Toplam (%95)'], d.files.map(f => td(kindName(f.kind), n(f.files), n(f.errors), f.avgMb + ' MB', kbps(f.avgSpeedKbps), kbps(f.medianSpeedKbps), ms(f.avgReceiveMs), ms(f.avgQueueMs), ms(f.avgExtractMs), ms(f.avgEmbedMs), ms(f.avgTotalMs), ms(f.p95TotalMs)))),
          heading('Kaynakça doğrulama'),
          cards([['Çalışma', n(d.verification.runs), `${n(d.verification.failed)} başarısız`], ['Çalışma süresi', ms(d.verification.avgRunMs), `%95'i ${ms(d.verification.p95RunMs)}`], ['Kaynak başına', ms(d.verification.msPerReference), `çalışma başı ${d.verification.avgRefs ?? '—'} kaynak`], ['Önbellekten', pct(d.verification.cachedShare), `${n(d.verification.cached)}/${n(d.verification.references)} kaynak`]]),
          heading('İşlem süreleri (işlem türüne göre)', csv('performance', 'operationsByKind')),
          table(['Tür', 'İşlem', 'Ortalama', 'Ortanca', '%95', 'En çok', 'Hata'], d.operationsByKind.map(o => td(kindName(o.kind), n(o.operations), ms(o.avgMs), ms(o.p50Ms), ms(o.p95Ms), ms(o.maxMs), n(o.failed)))),
        ];
      },
      errors(d) {
        return [
          cards([['İstek', n(d.totalRequests), ''], ['Sunucu hatası (5xx)', n(d.errors5xx), pct(d.totalRequests ? Math.round(d.errors5xx / d.totalRequests * 10000) / 100 : 0)], ['İstemci hatası (4xx)', n(d.errors4xx), '401/403/404/429 gibi'], ['Yarıda kesilen (499)', n(d.cancelled), 'yanıt gelmeden kullanıcı vazgeçti']]),
          stacked(d.series, [['errors5xx', '5xx', 'is-bad'], ['errors4xx', '4xx', 'is-warn'], ['cancelled', 'kesilen', 'is-gray']], 'Zamana göre hatalar', d.range),
          heading('Durum koduna göre', csv('errors', 'byStatus')),
          table(['Kod', 'Kaç kez', 'İsteklerin payı', 'Kaç kullanıcıda', 'Son'], d.byStatus.map(s => td(s.status, n(s.count), pct(s.share), n(s.users), when(s.last))), 'Hata yok.'),
          heading('Hangi sayfada', csv('errors', 'byRoute')),
          table(['Kod', 'Yol', 'Kaç kez', 'Kullanıcı', 'İlk', 'Son', 'İleti'], d.byRoute.map(r => td(r.status, r.route, n(r.count), n(r.users), when(r.first), when(r.last), r.message || r.code)), 'Hata yok.'),
          heading('Hangi kullanıcıda', csv('errors', 'byUser')),
          table(['Kullanıcı', '5xx', '4xx', 'Kesilen', 'İstek', 'Hata oranı', 'En sık', 'Son'], d.byUser.map(u => td(u.username || '(silinmiş)', n(u.errors5xx), n(u.errors4xx), n(u.cancelled), n(u.requests), pct(u.errorRate), u.topRoute, when(u.last))), 'Kullanıcıya bağlı hata yok.'),
          heading('Son 100 hata', csv('errors', 'recent')),
          table(['Zaman', 'Kod', 'Yol', 'Kullanıcı', 'Süre', 'İleti'], d.recent.map(r => td(when(r.at), r.status, r.route, r.username || '—', ms(r.durationMs), r.message || r.code)), 'Hata yok.'),
          heading('Başarısız model çağrıları', csv('errors', 'failedModelCalls')),
          table(['Zaman', 'Çağrı', 'Model', 'Süre', 'Hata'], d.failedModelCalls.map(c => td(when(c.at), c.name, c.model, ms(c.durationMs), c.message)), 'Başarısız çağrı yok.'),
        ];
      },
      usage(d) {
        const p = d.perActiveUser;
        return [
          cards([['Etkin kullanıcı', n(d.activeUsers), `${n(d.operations)} işlem`], ['Sorgulanan kaynak', n(d.references), `kullanıcı başı ${n(p.references)} (ortanca ${n(p.medianReferences)})`], ['Token', n(d.tokens), `kullanıcı başı ${n(p.tokens)} (ortanca ${n(p.medianTokens)})`],
            ['İşlem başına', n(p.operations), 'kullanıcı başına işlem'], ['En çok kullanan %10', pct(d.topDecileShare), 'token payı']]),
          chart(d.series, 'references', 'Sorgulanan kaynak', d.range), chart(d.series, 'tokens', 'Token', d.range), chart(d.series, 'activeUsers', 'Etkin kullanıcı', d.range),
          chart(d.series, 'referencesPerUser', 'Kullanıcı başına ortalama kaynak', d.range), chart(d.series, 'tokensPerUser', 'Kullanıcı başına ortalama token', d.range),
          heading('Zamana göre', csv('usage', 'series')),
          table(['Zaman', 'İşlem', 'Etkin kullanıcı', 'Kaynak', 'Token', 'Kullanıcı başı kaynak', 'Kullanıcı başı token'], d.series.filter(s => s.operations).reverse().map(s => td(when(s.at), n(s.operations), n(s.activeUsers), n(s.references), n(s.tokens), n(s.referencesPerUser), n(s.tokensPerUser)))),
          heading('İşlem türüne göre', csv('usage', 'byKind')),
          table(['Tür', 'İşlem', 'Kaynak', 'Token', 'İşlem başı token', 'Hata'], d.byKind.map(k => td(kindName(k.kind), n(k.operations), n(k.references), n(k.tokens), n(k.avgTokens), n(k.failed)))),
          heading('Kullanıcı bazında (ilk 300)', csv('usage', 'perUser')),
          table(['Kullanıcı', 'İşlem', 'Kaynak', 'Token', 'İşlem başı token', 'Etkin gün', 'Günlük kaynak', 'Günlük token', 'Hata', 'Son'], d.perUser.map(u => td(u.username || '(silinmiş)', n(u.operations), n(u.references), n(u.tokens), n(u.tokensPerOperation), n(u.activeDays), n(u.referencesPerActiveDay), n(u.tokensPerActiveDay), n(u.failed), when(u.last)))),
        ];
      },
      experience(d) {
        const badge = u => h('span', { class: 'adm-score is-' + u.level }, u.score == null ? '—' : String(u.score));
        return [
          h('p', { class: 'acct-muted' }, `Skor (0–100): API yanıt hızı (Apdex, eşik ${ms(d.apdexT)}) %35, sunucu hatası/yarıda kesilme %20, model cevap süresi %20, dosya sırada bekleme %10, başarısız işlem %15. 85 ve üzeri iyi, 70–85 orta, altı kötü. Verisi olmayan bileşen hesaba katılmaz.`),
          cards([['Genel Apdex', d.apdex == null ? '—' : String(d.apdex).replace('.', ','), '1 = herkes hızlı yanıt aldı'], ['Ortalama skor', n(d.averageScore), `${n(d.users)} kullanıcı`], ['İyi / orta / kötü', `${n(d.good)} / ${n(d.fair)} / ${n(d.poor)}`, 'kullanıcı sayısı'], ['Memnun kullanıcı', pct(d.satisfiedShare), 'skoru 85 ve üzeri']]),
          heading('Kullanıcı bazında (en düşük skordan)', csv('experience', 'perUser')),
          table(['Kullanıcı', 'Skor', 'İstek', 'Apdex', 'Sunucu hatası', 'Model çağrısı', 'Model süresi', 'Dosya', 'Dosya bekleme', 'Yükleme hızı', 'İşlem', 'Başarısız'], d.perUser.map(u => h('tr', {}, h('td', {}, u.username || '(silinmiş)'), h('td', {}, badge(u)),
            ...[n(u.requests), u.apdex ?? '—', pct(u.serverErrorRate), n(u.llmCalls), ms(u.llmAvgMs), n(u.fileCount), ms(u.fileQueueMs), kbps(u.uploadSpeedKbps), n(u.operations), n(u.failedOperations)].map(c => h('td', {}, c)))), 'Ölçülen kullanıcı yok.'),
        ];
      },
      capacity(d) {
        const max = Math.max(1, ...d.hours.map(x => x.requests));
        return [
          cards([['En yüksek eşzamanlı istek', n(d.peakInflight), `${d.cpus} CPU çekirdeği`], ['Olay döngüsü gecikmesi', d.maxLagP99Ms == null ? '—' : d.maxLagP99Ms + ' ms', 'en kötü %99 (200 ms üstü sorunlu)'], ['En yüksek bellek', n(d.maxRssMb) + ' MB', ''], ['Ortalama CPU', pct(d.avgCpu), `${n(d.samples)} örnek`], ['Kota bekleyen model çağrısı', n(d.waitingModelCalls), '1 sn\'den fazla bekleyen']]),
          chart(d.series, 'cpu', 'CPU (%)', d.range, v => pct(v)), chart(d.series, 'maxRssMb', 'Bellek (MB, en yüksek)', d.range), chart(d.series, 'lagP99Ms', 'Olay döngüsü gecikmesi (ms, en kötü)', d.range), chart(d.series, 'maxInflight', 'Eşzamanlı istek (en yüksek)', d.range),
          heading('Günün saatlerine göre yoğunluk (sunucu saati)', csv('capacity', 'hours')),
          h('div', { class: 'adm-bars', role: 'img', 'aria-label': 'Saatlere göre istek' }, d.hours.map(x => h('div', { class: 'adm-bar', title: `${String(x.hour).padStart(2, '0')}:00 — ${n(x.requests)} istek, ${n(x.operations)} işlem, ${n(x.llmCalls)} model çağrısı` }, h('span', { style: `height:${x.requests ? Math.max(2, x.requests / max * 100) : 0}%` }), h('small', {}, String(x.hour))))),
          heading('Model sağlayıcıları ve kota beklemesi', csv('capacity', 'providers')),
          table(['Sağlayıcı', 'Çağrı', 'Beklemeli çağrı', 'Ort. bekleme', 'En çok bekleme', 'Hata'], d.providers.map(x => td(x.provider, n(x.calls), n(x.throttled), ms(x.avgWaitMs), ms(x.maxWaitMs), n(x.errors)))),
        ];
      },
    };

    const content = h('div', { class: 'adm-report' });
    const draw = async () => {
      content.replaceChildren(h('p', { class: 'acct-muted' }, 'Yükleniyor…'));
      try { const data = await api('GET', `/api/admin/reports/${section}?days=${days}`); content.replaceChildren(h('p', { class: 'acct-muted' }, `${when(data.range.from)} – ${when(data.range.to)} · ${data.range.bucket < 86400000 ? 'saatlik' : 'günlük'} dilimler`), ...views[section](data)); }
      catch (error) { content.replaceChildren(h('p', { class: 'acct-message is-error' }, error.message)); }
    };
    panel.append(
      h('div', { class: 'adm-toolbar' },
        h('div', { class: 'adm-subtabs', role: 'tablist' }, SECTIONS.map(([key, text]) => h('button', { type: 'button', role: 'tab', class: 'adm-tab', 'aria-selected': String(key === section), onclick: event => { section = key; panel.querySelectorAll('.adm-subtabs .adm-tab').forEach(b => b.setAttribute('aria-selected', String(b === event.currentTarget))); draw(); } }, text))),
        h('select', { name: 'period', 'aria-label': 'Dönem', onchange: event => { days = event.target.value; draw(); } }, PERIODS.map(([v, text]) => h('option', { value: v, selected: v === days }, text))),
        h('button', { type: 'button', class: 'copy-button btn-secondary', onclick: draw }, 'Yenile')),
      content);
    return draw();
  }
  window.AdminReports = { mount };
})();
