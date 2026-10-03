// Plan limits: the single place every limit comes from.
// The defaults below seed the database (admin panel > Paketler); once accounts are enabled the provider reads the
// plans table, so an admin can edit, add and remove plans. premium and gold defaults are PROVISIONAL starting values.
const MB = 1024 * 1024;
const DEFAULTS = [
  { id: 'basic', title: 'Basic', description: 'Başlangıç paketi', projects: 10, documentsPerProject: 20, documentBytes: 50 * MB, questionsPerDay: 200, monthlyTokens: 300000 },
  { id: 'premium', title: 'Premium', description: '', projects: 50, documentsPerProject: 100, documentBytes: 100 * MB, questionsPerDay: 1000, monthlyTokens: 3000000 },
  { id: 'gold', title: 'Gold', description: '', projects: 200, documentsPerProject: 500, documentBytes: 200 * MB, questionsPerDay: 5000, monthlyTokens: 15000000 },
];
const ORDER = DEFAULTS.map(plan => plan.id);
const PLANS = Object.fromEntries(DEFAULTS.map(plan => [plan.id, { ...plan }]));
const LABELS = {
  projects: 'proje sayısı',
  documentsPerProject: 'projedeki belge sayısı',
  documentBytes: 'belge boyutu',
  questionsPerDay: 'günlük soru sayısı',
  monthlyTokens: 'aylık token kotası',
};
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
  constructor(plan, limit, current) {
    const own = limitsFor(plan)[limit], upper = nextPlan(plan), upperValue = upper ? limitsFor(upper)[limit] : null;
    const better = upper && (upperValue === 0 && limit === 'monthlyTokens' || upperValue > own);
    super(`${get(plan).title} paketinizin ${LABELS[limit]} sınırına ulaştınız (${format(limit, own)}).`
      + (better ? ` ${get(upper).title} pakete geçerek sınırı ${upperValue === 0 ? 'sınırsız' : format(limit, upperValue)} yapabilirsiniz.` : ''));
    this.status = 429;
    this.code = 'plan_limit';
    this.upgrade = { limit, label: LABELS[limit], plan: known(plan), value: own, current, nextPlan: better ? upper : null, nextValue: better ? upperValue : null };
  }
}
// Throws when `used` has already reached the plan's limit. A monthly token quota of 0 means unlimited.
function enforce(plan, limit, used) {
  const max = limitsFor(plan)[limit];
  if (limit === 'monthlyTokens' && !max) return;
  if (used >= max) throw new PlanLimitError(plan, limit, used);
}

module.exports = { DEFAULTS, PLANS, ORDER, LABELS, setProvider, list, all, get, limitsFor, nextPlan, rank, enforce, PlanLimitError, known };
