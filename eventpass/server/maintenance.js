// Deletes expired sign-in state so the database does not slowly fill with dead rows. Safe to run at any time.
export async function purgeExpired(ctx) {
  const now = ctx.now();
  const day = 86_400_000;
  const run = async (sql, ...a) => (await ctx.db.prepare(sql).run(...a)).changes;
  return await run('DELETE FROM oauth_states WHERE expires_at < ?', now)
    + await run('DELETE FROM mfa_pending WHERE expires_at < ?', now)
    + await run('DELETE FROM otp_codes WHERE expires_at < ?', now)
    + await run('DELETE FROM email_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', now, now - day)
    + await run('DELETE FROM sessions WHERE expires_at < ?', now)
    + await run('DELETE FROM scanner_links WHERE COALESCE(revoked_at, expires_at) < ?', now - 30 * day)   // spent staff links, kept a month for the host's records
    + await run('DELETE FROM audit_log WHERE ts < ?', now - 180 * day);      // keep six months of security history
}
