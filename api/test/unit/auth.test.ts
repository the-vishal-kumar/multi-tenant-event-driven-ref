import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AUDIENCE, AuthError, hmacVerifier, ISSUER, signToken } from '../../src/auth';

const SECRET = 'unit-test-secret-unit-test-secret-0123';
const TENANT = '7d3b1f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const verify = hmacVerifier(SECRET);
const key = new TextEncoder().encode(SECRET);

describe('hmacVerifier', () => {
  it('accepts a valid token and returns its tenant', async () => {
    const token = await signToken(SECRET, TENANT, 'alice');
    await expect(verify(`Bearer ${token}`)).resolves.toEqual({ subject: 'alice', tenantId: TENANT });
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['garbage', 'Bearer not.a.jwt'],
  ])('rejects %s', async (_, header) => {
    await expect(verify(header)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token signed with another key', async () => {
    const token = await signToken('another-secret-another-secret-012345', TENANT, 'mallory');
    await expect(verify(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an expired token', async () => {
    const token = await signToken(SECRET, TENANT, 'alice', -60);
    await expect(verify(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects alg=none', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = `${enc({ alg: 'none' })}.${enc({ tid: TENANT, sub: 'x', iss: ISSUER, aud: AUDIENCE, exp })}.`;
    await expect(verify(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a wrong audience', async () => {
    const token = await new SignJWT({ tid: TENANT })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER).setAudience('someone-else').setSubject('a').setExpirationTime('1h')
      .sign(key);
    await expect(verify(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a missing or malformed tenant claim', async () => {
    for (const claims of [{}, { tid: 'not-a-uuid' }, { tid: 42 }]) {
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject('a').setExpirationTime('1h')
        .sign(key);
      await expect(verify(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
    }
  });
});
