import * as v from 'valibot'

/**
 * The downloadable builds a release note can carry, and the rules a filename has to satisfy.
 *
 * A file is attached to a release rather than to the product: that is what makes "the archive of
 * past versions" a consequence of the changelog instead of a second list to keep in step with it,
 * and it is why the Releases tab is where an editor uploads.
 */

/**
 * Which build a file is, as a closed vocabulary — the same reasoning as the link kinds: the website
 * draws an icon and a label from it, and free text is a list of icons nobody can finish. `any` is
 * the escape hatch and the default, for the single cross-platform artifact most releases are.
 */
const RELEASE_FILE_PLATFORMS = [
  'any',
  'windows',
  'macos',
  'linux',
  'android',
  'ios',
  'web',
  'server',
] as const

type ReleaseFilePlatform = (typeof RELEASE_FILE_PLATFORMS)[number]

/** At most this many files on one release. A changelog entry with thirty buttons is not a design. */
const MAX_FILES_PER_RELEASE = 20

/**
 * Ceiling on one upload, in bytes.
 *
 * It is a Workers limit before it is a policy: the request body a Worker may read is capped by the
 * plan (100 MB on the current one), and a stricter number here turns "the upload died at 100 MB" into
 * a 413 that says so. Anything larger belongs on a release page somewhere else, linked with a
 * `download` link kind.
 */
const MAX_FILE_BYTES = 96 * 1024 * 1024

/**
 * A filename as it will be saved.
 *
 * No slashes, no backslashes and no leading dot: the value ends up in a `Content-Disposition`, and
 * the object key is built from the row's id rather than from this — but a path separator here would
 * still be a filename that means something else once a browser has written it to disk.
 */
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,119}$/

const filenameInput = v.pipe(v.string(), v.trim(), v.regex(FILENAME_PATTERN))

/**
 * Key of a file's object in the `RELEASES` bucket.
 *
 * Built from ids and never from the filename. Two reasons: a rename is then a column change rather
 * than a copy plus a delete, and nothing an editor types can reach outside its own prefix. The
 * product prefix means everything one product ever published can be listed — and deleted —
 * without consulting the database, which is what makes the bucket something the row cascade can be
 * brought back in step with afterwards.
 */
const objectKeyFor = (productId: string, releaseId: string, fileId: string) =>
  `releases/${productId}/${releaseId}/${fileId}`

/**
 * A `Content-Disposition` that survives a non-ASCII filename.
 *
 * Both forms are emitted: the bare `filename=` for clients that read only that, and RFC 5987's
 * `filename*=UTF-8''…` for the rest. A name with an accent in it is normal here — the releases are
 * written in Spanish as often as in English — and the bare form alone turns one into mojibake.
 */
const contentDisposition = (filename: string): string => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Lowercase hex SHA-256 of a byte range, so a download can be verified against the row. */
const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export {
  contentDisposition,
  FILENAME_PATTERN,
  filenameInput,
  MAX_FILE_BYTES,
  MAX_FILES_PER_RELEASE,
  objectKeyFor,
  RELEASE_FILE_PLATFORMS,
  sha256Hex,
}
export type { ReleaseFilePlatform }
