// Plan limits: the single place every limit comes from.
// The defaults below seed the database (admin panel > Paketler); once accounts are enabled the provider reads the
// plans table, so an admin can edit, add and remove plans. premium and gold defaults are PROVISIONAL starting values.
const MB = 1024 * 1024;
// The areas of the application a plan can open. Administrators set them per plan; the lists below are the starting values.
const FEATURES = [
  { id: 'reference', label: 'Kaynakça doğrulama' },
  { id: 'orphan', label: 'Yetim kaynak kontrolü' },
  { id: 'content', label: 'İçerik kontrolü' },
  { id: 'export', label: 'Rapor ve dışa aktarma' },
  { id: 'web', label: 'Web kaynağı doğrulama' },
  { id: 'writer', label: 'Yazım yardımcısı' },
  { id: 'scholar', label: 'Semantic Scholar arama/ekleme' },
  { id: 'styles', label: 'Vancouver / IEEE / MDPI stilleri' },
];
const FEATURE_IDS = FEATURES.map(feature => feature.id);
const BASIC_FEATURES = ['reference', 'orphan'];
const PREMIUM_FEATURES = [...BASIC_FEATURES, 'content', 'export', 'web'];
const GOLD_FEATURES = [...PREMIUM_FEATURES, 'writer', 'scholar', 'styles'];
const DEFAULT_FEATURES = { basic: BASIC_FEATURES, premium: PREMIUM_FEATURES, gold: GOLD_FEATURES };
// A plan stored before features existed (or created without any) gets its default list; unknown plans start with the basic areas.
const defaultFeatures = id => [...(DEFAULT_FEATURES[id] || BASIC_FEATURES)];
const DEFAULTS = [
  { id: 'basic', title: 'Basic', description: 'Başlangıç paketi', projects: 10, documentsPerProject: 20, documentBytes: 50 * MB, questionsPerDay: 200, monthlyTokens: 300000, referencesPerDocument: 150, monthlyReferences: 1000, wordDocuments: 20, features: BASIC_FEATURES },
  { id: 'premium', title: 'Premium', description: '', projects: 50, documentsPerProject: 100, documentBytes: 100 * MB, questionsPerDay: 1000, monthlyTokens: 3000000, referencesPerDocument: 300, monthlyReferences: 5000, wordDocuments: 100, features: PREMIUM_FEATURES },
  { id: 'gold', title: 'Gold', description: '', projects: 200, documentsPerProject: 500, documentBytes: 200 * MB, questionsPerDay: 5000, monthlyTokens: 15000000, referencesPerDocument: 1000, monthlyReferences: 25000, wordDocuments: 500, features: GOLD_FEATURES },
];
const ORDER = DEFAULTS.map(plan => plan.id);
const PLANS = Object.fromEntries(DEFAULTS.map(plan => [plan.id, { ...plan }]));
const LABELS = {
  projects: 'proje sayısı',
  documentsPerProject: 'koleksiyondaki belge sayısı',
  documentBytes: 'belge boyutu',
  questionsPerDay: 'günlük soru sayısı',
  monthlyTokens: 'aylık token kotası',
  referencesPerDocument: 'belge başına sorgulanacak kaynak sayısı',
  monthlyReferences: 'aylık sorgulanan kaynak sayısı',
  wordDocuments: 'kayıtlı Word/PDF belge sayısı',
};
// For these limits 0 means unlimited.
const UNLIMITED_ZERO = new Set(['monthlyTokens', 'referencesPerDocument', 'monthlyReferences', 'wordDocuments']);
let provider = () => ORDER.map(id => PLANS[id]);

// fn() returns every plan (including inactive ones) ordered from the lowest to the highest.
function setProvider(fn) { provider = fn || (() => ORDER.map(id => PLANS[id])); }
const all = () => provider();
const list = () => all().filter(plan => plan.active !== false);
const known = id => all().some(plan => plan.id === id) ? id : (all()[0]?.id || 'basic');
const get = id => all().find(plan => plan.id === known(id)) || DEFAULTS[0];
const limitsFor = id => ({ ...get(id) });
const rank = id => Math.max(0, all().findIndex(plan => plan.id === known(id)));
// The next plan up that can still be chosen: shown as the upgrade suggestion.
const nextPlan = id => all().slice(rank(id) + 1).find(plan => plan.active !== false)?.id || null;
const format = (limit, value) => limit === 'documentBytes' ? `${Math.round(value / MB)} MB` : Number(value).toLocaleString('tr-TR');

// Error with the numbers the UI shows as an upgrade suggestion: which limit, current plan's value, next plan's value.
class PlanLimitError extends Error {
  constructor(plan, limit, current, adding = 1) {
    const own = limitsFor(plan)[limit], upper = nextPlan(plan), upperValue = upper ? limitsFor(upper)[limit] : null;
    const better = upper && (upperValue === 0 && UNLIMITED_ZERO.has(limit) || upperValue > own);
    super((adding > 1 ? `${get(plan).title} paketinizin ${LABELS[limit]} sınırı ${format(limit, own)}; bu işlem ${format(limit, adding)} kaynak gerektiriyor${current ? ` (kullanılan: ${format(limit, current)})` : ''}.` : `${get(plan).title} paketinizin ${LABELS[limit]} sınırına ulaştınız (${format(limit, own)}).`)
      + (better ? ` ${get(upper).title} pakete geçerek sınırı ${upperValue === 0 ? 'sınırsız' : format(limit, upperValue)} yapabilirsiniz.` : ''));
    this.status = 429;
    this.code = 'plan_limit';
    this.upgrade = { limit, label: LABELS[limit], plan: known(plan), value: own, current, nextPlan: better ? upper : null, nextValue: better ? upperValue : null };
  }
}
const featureLabel = id => FEATURES.find(feature => feature.id === id)?.label || id;
// Administrators open every area; for everyone else the plan's list decides.
const hasFeature = (plan, feature, role) => role === 'admin' || (get(plan).features || []).includes(feature);
const featuresFor = (plan, role) => role === 'admin' ? [...FEATURE_IDS] : FEATURE_IDS.filter(id => (get(plan).features || []).includes(id));
// The nearest plan above this one that includes the area: shown as the upgrade suggestion.
const planWithFeature = (id, feature) => all().slice(rank(id) + 1).find(plan => plan.active !== false && (plan.features || []).includes(feature))?.id || null;
class PlanFeatureError extends Error {
  constructor(plan, feature) {
    const upper = planWithFeature(plan, feature);
    super(`${featureLabel(feature)} ${get(plan).title} paketinizde bulunmuyor.` + (upper ? ` ${get(upper).title} pakete geçerek kullanabilirsiniz.` : ' Yöneticinizle iletişime geçin.'));
    this.status = 403;
    this.code = 'plan_feature';
    this.upgrade = { feature, label: featureLabel(feature), plan: known(plan), nextPlan: upper };
  }
}
function requireFeature(plan, feature, role) { if (!hasFeature(plan, feature, role)) throw new PlanFeatureError(plan, feature); }
// Throws when `used` plus what is being added (one by default) would pass the plan's limit; 0 means unlimited where allowed.
function enforce(plan, limit, used, adding = 1) {
  const max = limitsFor(plan)[limit];
  if (UNLIMITED_ZERO.has(limit) && !max) return;
  if (adding > 0 && used + adding > max) throw new PlanLimitError(plan, limit, used, adding);
}

module.exports = { FEATURES, FEATURE_IDS, defaultFeatures, hasFeature, featuresFor, requireFeature, planWithFeature, PlanFeatureError, featureLabel, DEFAULTS, PLANS, ORDER, LABELS, setProvider, list, all, get, limitsFor, nextPlan, rank, enforce, PlanLimitError, known };
