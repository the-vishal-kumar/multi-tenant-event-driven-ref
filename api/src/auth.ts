import { jwtVerify, SignJWT, errors } from 'jose';

// Tokens are HS256 JWTs signed with a shared dev secret. That keeps the
// reference self-contained; production would verify RS256/EdDSA tokens from
// an identity provider against its JWKS. Either way the tenant comes from a
// verified claim, never from the URL, a header or the body.

export const ISSUER = 'orders-dev-issuer';
export const AUDIENCE = 'orders-api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Principal {
  subject: string;
  tenantId: string;
}

export class AuthError extends Error {}

export type Verifier = (authorization: string | undefined) => Promise<Principal>;

export function hmacVerifier(secret: string): Verifier {
  const key = new TextEncoder().encode(secret);
  return async (authorization) => {
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization ?? '');
    if (!m?.[1]) throw new AuthError('missing bearer token');
    try {
      const { payload } = await jwtVerify(m[1], key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ['exp', 'sub', 'tid'],
        clockTolerance: 5,
      });
      if (typeof payload.tid !== 'string' || !UUID.test(payload.tid)) {
        throw new AuthError('invalid tenant claim');
      }
      return { subject: String(payload.sub), tenantId: payload.tid.toLowerCase() };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof errors.JOSEError) throw new AuthError(err.code);
      throw err;
    }
  };
}

export async function signToken(
  secret: string,
  tenantId: string,
  subject: string,
  ttlSeconds = 3600,
): Promise<string> {
  return new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}
