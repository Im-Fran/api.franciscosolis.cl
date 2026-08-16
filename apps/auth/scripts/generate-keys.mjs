#!/usr/bin/env node
/**
 * Generates the Ed25519 keypair the auth Worker signs access tokens with.
 *
 * Usage: `pnpm run keys:generate`
 *
 * Prints the private JWK (goes into the `JWT_PRIVATE_KEY` secret) and the matching public JWK,
 * which is what `/.well-known/jwks.json` publishes and what belongs in `JWT_RETIRED_PUBLIC_KEYS`
 * once this key is rotated out. The `kid` is the RFC 7638 thumbprint of the public key, so it is
 * derived from the key itself and cannot collide with another key by accident.
 */
import { webcrypto } from 'node:crypto'

const base64Url = (buffer) => Buffer.from(buffer).toString('base64url')

const thumbprint = async (jwk) => {
  // RFC 7638 §3.2: only the required members, lexicographically ordered, no whitespace.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return base64Url(digest)
}

const { privateKey, publicKey } = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])

const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey)
const publicJwk = await webcrypto.subtle.exportKey('jwk', publicKey)
const kid = await thumbprint(publicJwk)

const privateOutput = { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid, x: publicJwk.x, d: privateJwk.d }
const publicOutput = { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid, use: 'sig', key_ops: ['verify'], x: publicJwk.x }

console.log('\nPRIVATE KEY — set as the JWT_PRIVATE_KEY secret, never commit it:')
console.log(JSON.stringify(privateOutput))
console.log('\nPUBLIC KEY — published at /.well-known/jwks.json; keep it to add to JWT_RETIRED_PUBLIC_KEYS after a rotation:')
console.log(JSON.stringify(publicOutput))
console.log('\nLocal development: paste the private key into apps/auth/.dev.vars as JWT_PRIVATE_KEY=<json>')
console.log('Production:        cd apps/auth && pnpm exec wrangler secret put JWT_PRIVATE_KEY\n')
