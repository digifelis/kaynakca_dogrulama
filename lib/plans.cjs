// Plan limits: the single place every limit comes from.
// basic is the agreed starting set. premium and gold are PROVISIONAL placeholders (the upgrade hint needs
// a next plan to show); the owner decides their real values here.
const MB = 1024 * 1024;
const ORDER = ['basic', 'premium', 'gold'];
const PLANS = {
  basic: { title: 'Basic', projects: 10, documentsPerProject: 20, documentBytes: 50 * MB, questionsPerDay: 200 },
  premium: { title: 'Premium', projects: 50, documentsPerProject: 100, documentBytes: 100 * MB, questionsPerDay: 1000 },
  gold: { title: 'Gold', projects: 200, documentsPerProject: 500, documentBytes: 200 * MB, questionsPerDay: 5000 },
};
const LABELS = {
  projects: 'proje sayısı',
  documentsPerProject: 'projedeki belge sayısı',
  documentBytes: 'belge boyutu',
  questionsPerDay: 'günlük soru sayısı',
};
const known = plan => ORDER.includes(plan) ? plan : 'basic';
const limitsFor = plan => ({ ...PLANS[known(plan)] });
const nextPlan = plan => ORDER[ORDER.indexOf(known(plan)) + 1] || null;
const rank = plan => ORDER.indexOf(known(plan));
const format = (limit, value) => limit === 'documentBytes' ? `${Math.round(value / MB)} MB` : String(value);

// Error with the numbers the UI shows as an upgrade suggestion: which limit, current plan's value, next plan's value.
class PlanLimitError extends Error {
  constructor(plan, limit, current) {
    const own = limitsFor(plan)[limit], upper = nextPlan(plan), upperValue = upper ? limitsFor(upper)[limit] : null;
    super(`${PLANS[known(plan)].title} paketinizin ${LABELS[limit]} sınırına ulaştınız (${format(limit, own)}).`
      + (upper ? ` ${PLANS[upper].title} pakete geçerek sınırı ${format(limit, upperValue)} yapabilirsiniz.` : ''));
    this.status = 429;
    this.code = 'plan_limit';
    this.upgrade = { limit, label: LABELS[limit], plan: known(plan), value: own, current, nextPlan: upper, nextValue: upperValue };
  }
}
// Throws when `used` has already reached the plan's limit.
function enforce(plan, limit, used) {
  if (used >= limitsFor(plan)[limit]) throw new PlanLimitError(plan, limit, used);
}

module.exports = { PLANS, ORDER, limitsFor, nextPlan, rank, enforce, PlanLimitError, known };
