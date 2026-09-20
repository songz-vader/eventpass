import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, registerUser, uniqueEmail, GOOD_PASSWORD } from "./helpers.js";

// On PostgreSQL requests really do run at the same time, so anything that must happen once has to be decided by the database itself.
// These tests fire many requests in the same instant and check that exactly one of them wins.
const many = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

test("things that may only happen once, happen once, even when requests collide", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  await t.test("an email verification link works for exactly one of six simultaneous clicks", async () => {
    const { email } = await registerUser(s);
    const token = s.mailToken(email, "verify");
    const rs = await many(6, () => s.client().post("/api/auth/email/verify", { token }));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(rs.filter((r) => r.status === 400).length, 5);
  });

  await t.test("a password reset link sets exactly one new password", async () => {
    const { email } = await registerUser(s);
    await s.client().post("/api/auth/password/forgot", { email });
    const token = s.mailToken(email, "reset");
    const rs = await many(6, (i) => s.client().post("/api/auth/password/reset", { token, password: `brand-new-passphrase-${i}-xyz` }));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
  });

  await t.test("twelve wrong passwords at once are all counted, and the account locks", async () => {
    const { email } = await registerUser(s);
    await many(12, () => s.client().post("/api/auth/login", { email, password: "definitely-wrong-password" }));
    const row = await s.db.prepare("SELECT failed_attempts, locked_until FROM users WHERE email = ?").get(email);
    assert.equal(row.failed_attempts, 12, "no guess went uncounted");
    assert.ok(row.locked_until > Date.now());
    assert.equal((await s.client().post("/api/auth/login", { email, password: GOOD_PASSWORD })).status, 429);
  });

  await t.test("the same email registered six times at once creates one account and clear \"already exists\" answers", async () => {
    const email = uniqueEmail("race");
    const rs = await many(6, () => s.client().post("/api/auth/register", { name: "Racer", email, password: GOOD_PASSWORD }));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409), "the rest are told the email is taken, not \"server error\"");
    assert.equal((await s.db.prepare("SELECT COUNT(*) c FROM users WHERE email = ?").get(email)).c, 1);
  });

  await t.test("two people adding guests at the same moment never share an invitation code", async () => {
    const { c } = await registerUser(s);
    const ev = (await c.post("/api/events", { name: "Race", type: "party" })).body.event;
    const rs = await many(20, (i) => c.post("/api/guests", { event_id: ev.id, name: `G${i}`, phone: "" }));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(new Set(rs.map((r) => r.body.guest.code)).size, 20);
  });
});
