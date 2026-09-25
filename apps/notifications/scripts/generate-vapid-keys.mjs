#!/usr/bin/env node
/**
 * Generates the VAPID key pair this Worker pushes with, in the one shape it reads: a P-256 private
 * JWK, whose `x`/`y` already carry the public key.
 *
 *   node apps/notifications/scripts/generate-vapid-keys.mjs | npx wrangler secret put VAPID_PRIVATE_KEY
 *   node apps/notifications/scripts/generate-vapid-keys.mjs | npx wrangler secret put VAPID_PRIVATE_KEY --env dev
 *
 * Run it once per environment and keep each output only in its secret store. Rotating the key
 * orphans every existing browser subscription — a subscription is bound to the public key it was
 * created with — so the website re-subscribes on the next visit, and the old rows are dropped once
 * the push services have refused them `PUSH.maxFailures` times (or at once, on a 404/410).
 *
 * The public key is printed to stderr, so it is visible without ending up in the piped secret.
 */
import { webcrypto } from 'node:crypto'

const { subtle } = webcrypto
const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const jwk = await subtle.exportKey('jwk', pair.privateKey)
const raw = Buffer.from(await subtle.exportKey('raw', pair.publicKey))

process.stdout.write(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }))
process.stderr.write(`\nPublic key (applicationServerKey): ${raw.toString('base64url')}\n`)
