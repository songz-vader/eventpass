// Throwaway-inbox domains. Not exhaustive; it just stops the laziest fake sign-ups.
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com',
  'trashmail.com', 'sharklasers.com', 'getnada.com', 'throwawaymail.com', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mailnesia.com', 'tempail.com', 'emailondeck.com']);
export const isDisposable = (email) => DISPOSABLE.has(String(email).split('@')[1]?.toLowerCase());
