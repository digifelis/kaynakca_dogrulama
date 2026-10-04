// The plan checks of the Word/PDF checker: one function per app, shared by the server and the tests.
//   guard(userId)                                  monthly token quota (content checks)
//   guard(userId, { references: { total, queried } })  references in one document / queried this month
//   guard(userId, { wordDocuments })               how many documents the user already stores
//   guard(userId, { feature })                     the plan must include this area (administrators always do)
const Plans = require('./plans.cjs');

module.exports = function wordGuard(app) {
  return (userId, request = {}) => {
    const user = app.accounts.users.byId(userId);
    if (!user) return;
    const plan = app.auth.effectivePlan(user);
    if (request.feature) Plans.requireFeature(plan, request.feature, user.role);
    else if (request.references) {
      Plans.enforce(plan, 'referencesPerDocument', 0, request.references.total);
      Plans.enforce(plan, 'monthlyReferences', app.usage.monthReferences(userId), request.references.queried);
    } else if (request.wordDocuments !== undefined) Plans.enforce(plan, 'wordDocuments', request.wordDocuments);
    else Plans.enforce(plan, 'monthlyTokens', app.usage.monthTokens(userId));
  };
};
