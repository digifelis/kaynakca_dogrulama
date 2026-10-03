// Composition of the account system: database, plans, secrets, mailer, auth rules, operation log and the session resolver.
const crypto = require('node:crypto');
const path = require('node:path');
const Plans = require('./plans.cjs');
const Identity = require('./identity.cjs');
const { openDatabase } = require('./app-db.cjs');
const { createAccounts } = require('./accounts.cjs');
const { createSealer } = require('./secrets.cjs');
const { createMailer } = require('./mailer.cjs');
const { createAuth } = require('./auth.cjs');
const { createUsage } = require('./usage.cjs');

function createApp({ dir = process.env.WRITER_DATA_DIR || path.join(__dirname, '..', 'data', 'writer'), ldapClientFactory, transportFactory, now = Date.now, publicUrl } = {}) {
  const appDb = openDatabase(dir);
  const accounts = createAccounts(appDb, { now });
  accounts.plans.seedDefaults();
  // From here on every plan limit in the code base comes from the plans table.
  Plans.setProvider(() => accounts.plans.list());
  const sealer = createSealer(dir);
  let auth;
  const mailer = createMailer(() => auth.settings.smtp({ secret: true }), { transportFactory });
  auth = createAuth({ accounts, mailer, sealer, ldapClientFactory, now, ...(publicUrl !== undefined ? { publicUrl } : {}) });
  const usage = createUsage(appDb, { now });
  usage.recoverInterrupted();
  Identity.setResolver(req => auth.resolveRequest(req), { enforce: true });
  return { appDb, accounts, auth, usage, sealer, mailer,
    close() { Plans.setProvider(null); Identity.setResolver(null); appDb.close(); } };
}
// Random temporary password for accounts an admin creates or resets: 14 characters, no look-alikes.
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(14), byte => alphabet[byte % alphabet.length]).join('');
}

module.exports = { createApp, temporaryPassword };
