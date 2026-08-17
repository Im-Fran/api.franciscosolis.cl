/**
 * Stands in for `prettier/standalone` and `prettier/plugins/html` inside a Worker bundle.
 *
 * `@react-email/render` imports Prettier statically, at the top of its module, purely to implement
 * its `pretty: true` option. Static means unconditional: esbuild pulls the whole formatter — around
 * 1.5 MB of source, and the parsing cost of that on every cold start — into a Worker that renders
 * with `pretty: false` and never calls it.
 *
 * Both mail-sending Workers therefore alias those two specifiers here (`alias` in their
 * `wrangler.jsonc`). `renderEmail` is the only caller in this monorepo and it never asks for
 * pretty output, so the functions below exist to fail loudly rather than to work: if this ever
 * throws, someone passed `pretty: true` and needs to drop the alias instead of keeping a formatter
 * that silently does nothing.
 */

const unavailable = (): never => {
  throw new Error(
    'Prettier is aliased out of this Worker bundle. Render emails with `pretty: false`, or remove the `alias` entry in wrangler.jsonc.',
  )
}

/** `prettier/standalone`'s `format`. */
const format = unavailable

/** `prettier/plugins/html` is consumed as a namespace and spread into Prettier's options. */
const printers = undefined
const parsers = undefined

export { format, parsers, printers }
export default { format, parsers, printers }
