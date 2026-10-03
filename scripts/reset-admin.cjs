// Recovers administrator access: node scripts/reset-admin.cjs [kullanıcı-adı] [geçici-parola]
// Creates the account if missing (or makes it an active administrator), sets a temporary password that must be
// changed at the next sign-in, clears sign-in locks and closes its sessions. Run it where the data directory is
// (in Docker: docker compose exec web node scripts/reset-admin.cjs).
const { createApp } = require('../lib/app.cjs');
const { DEFAULT_ADMIN } = require('../lib/auth.cjs');

(async () => {
  const username = process.argv[2] || DEFAULT_ADMIN.username, password = process.argv[3] || DEFAULT_ADMIN.password;
  const app = createApp();
  try {
    const { accounts, auth } = app, passwordHash = await auth.hashPassword(password);
    const existing = accounts.users.byUsername(username);
    if (existing) accounts.users.update(existing.id, { passwordHash, role: 'admin', status: 'active', mustChangePassword: true });
    else accounts.users.create({ username, displayName: 'Yönetici', passwordHash, role: 'admin', planId: require('../lib/plans.cjs').all().at(-1)?.id, mustChangePassword: true });
    const user = accounts.users.byUsername(username);
    accounts.attempts.clear(`u:${username.toLowerCase()}`);
    accounts.sessions.revokeUser(user.id);
    console.log(`${username}: ${existing ? 'hesap sıfırlandı' : 'hesap oluşturuldu'}; geçici parola "${password}" ile girin, yeni parola istenecek.`);
    if (user.source !== 'local') console.log('Uyarı: bu hesap LDAP kaynaklı; parola yerine dizin parolası kullanılır. Başka bir kullanıcı adı verin.');
  } finally { app.close(); }
})().catch(error => { console.error(error.message); process.exit(1); });
