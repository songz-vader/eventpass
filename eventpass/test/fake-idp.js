import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// A stand-in OpenID Connect provider: discovery, JWKS, token endpoint with real PKCE + client-auth checks, and signed ID tokens.
// authStyle 'basic' = client_secret_basic (Authorization header); 'post' = client_id/client_secret in the form body (what Apple requires).
// For 'post', pass verifySecret(clientSecretString) → true/false so the test can check the secret is a properly signed JWT.
export async function makeIdp({ issuer = 'https://idp.test', clientId = 'client-123', clientSecret = 'shh-secret', authStyle = 'basic', verifySecret = null } = {}) {
  const newKey = async (kid) => { const { publicKey, privateKey } = await generateKeyPair('RS256'); return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } }; };
  const idp = { issuer, clientId, clientSecret, tokenRequests: [], key: await newKey('key-1'), rogue: await newKey('key-1'), codes: new Map(), tweak: null, tokenStatus: 200, useRogue: false, n: 0, jwksFetches: 0, discoveryFetches: 0 };
  idp.rotate = async () => { idp.key = await newKey('key-' + (++idp.n + 1)); };
  idp.owns = (u) => u.startsWith(issuer + '/');
  idp.authorize = (location, user) => {          // the browser is sent here; we pretend the person approved
    const u = new URL(location);
    assert.equal(u.origin + u.pathname, issuer + '/authorize');
    const code = 'code_' + ++idp.n;
    idp.codes.set(code, { challenge: u.searchParams.get('code_challenge'), method: u.searchParams.get('code_challenge_method'), nonce: u.searchParams.get('nonce'), redirect: u.searchParams.get('redirect_uri'), client: u.searchParams.get('client_id'), user });
    return { code, state: u.searchParams.get('state'), params: u.searchParams };
  };
  idp.handle = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/.well-known/openid-configuration') { idp.discoveryFetches++; return json(200, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', id_token_signing_alg_values_supported: ['RS256'] }); }
    if (path === '/jwks') { idp.jwksFetches++; return json(200, { keys: [idp.key.jwk] }); }
    if (path === '/token') {
      if (idp.tokenStatus !== 200) return json(idp.tokenStatus, { error: 'invalid_grant' });
      const body = Object.fromEntries(new URLSearchParams(String(init.body)));
      const rec = idp.codes.get(body.code);
      idp.codes.delete(body.code);                                                      // codes are single-use
      const basic = String(init.headers?.Authorization || init.headers?.authorization || '');
      idp.tokenRequests.push({ headers: init.headers || {}, body });
      const okAuth = authStyle === 'post'
        ? !basic && body.client_id === clientId && !!(await verifySecret?.(body.client_secret))
        : basic === 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');
      const pkce = rec && b64u(crypto.createHash('sha256').update(body.code_verifier || '').digest()) === rec.challenge;
      if (!rec || !okAuth || !pkce || body.grant_type !== 'authorization_code' || body.redirect_uri !== rec.redirect) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: issuer, aud: clientId, sub: rec.user.sub, iat: now, exp: now + 300, nonce: rec.nonce, email: rec.user.email, email_verified: rec.user.email_verified ?? true, name: rec.user.name === undefined ? 'Test Person' : rec.user.name, ...(rec.user.extra || {}) };
      if (!payload.name) delete payload.name;
      idp.tweak?.(payload);
      const k = idp.useRogue ? idp.rogue : idp.key;
      const id_token = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: k.kid }).sign(k.privateKey);
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token });
    }
    return json(404, {});
  };
  idp.wrap = (base) => { const f = (url, init) => (idp.owns(String(url)) ? idp.handle(String(url), init) : base(url, init)); f.calls = base.calls; f.state = base.state; return f; };
  return idp;
}

