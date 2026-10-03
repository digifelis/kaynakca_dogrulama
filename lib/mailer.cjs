// Outgoing e-mail (address verification, password reset) through the SMTP server configured in the admin panel.
const nodemailer = require('nodemailer');

// settings: { host, port, secure, user, pass, from } with pass already opened; null/empty host means "not configured".
function createMailer(getSettings, { transportFactory = options => nodemailer.createTransport(options) } = {}) {
  const config = () => { const s = getSettings(); return s?.host && s?.from ? s : null; };
  return {
    enabled: () => !!config(),
    async send({ to, subject, text }) {
      const s = config();
      if (!s) throw Error('E-posta gönderimi yapılandırılmamış.');
      const transport = transportFactory({ host: s.host, port: Number(s.port) || (s.secure ? 465 : 587), secure: !!s.secure, requireTLS: !s.secure && s.requireTls !== false,
        auth: s.user ? { user: s.user, pass: s.pass || '' } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
      await transport.sendMail({ from: s.from, to, subject, text });
    },
  };
}
module.exports = { createMailer };
