/**
 * The verifier/challenge pair from RFC 7636 Appendix B. Using the published vector rather than a
 * locally derived one means the tests agree with the specification, not merely with themselves.
 */
const RFC7636 = {
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
} as const

/** A second, unrelated pair, for the tests that need a verifier that must NOT match. */
const OTHER_PKCE = {
  verifier: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  challenge: 'ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA',
} as const

export { OTHER_PKCE, RFC7636 }
