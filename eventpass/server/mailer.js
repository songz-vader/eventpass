import nodemailer from 'nodemailer';

// Sends verification / reset emails. Without SMTP (development/tests) messages are printed and kept in `outbox`.
export function createMailer(cfg) {
  const outbox = [];
  const transport = cfg.mail.url ? nodemailer.createTransport(cfg.mail.url) : null;
  return {
    outbox,
    enabled: !!transport,
    async send({ to, subject, text }) {
      const msg = { from: cfg.mail.from, to, subject, text };
      if (transport) { await transport.sendMail(msg); return; }
      outbox.push({ ...msg, at: Date.now() });
      if (outbox.length > 200) outbox.shift();
      if (cfg.env !== 'test') console.log(`\n[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    },
  };
}
