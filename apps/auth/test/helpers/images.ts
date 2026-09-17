/**
 * Minimal image fixtures.
 *
 * Only the first bytes matter anywhere in this Worker: uploads are accepted or refused on their
 * signature, never decoded, so a valid header followed by filler exercises exactly the same code a
 * real photograph would while keeping the fixtures readable and the suite fast.
 */

/** Pads a signature out to a plausible file size, so `size` assertions are not all identical. */
const withFiller = (signature: number[], total: number) => {
  const bytes = new Uint8Array(total)
  bytes.set(signature)
  for (let i = signature.length; i < total; i++) {
    bytes[i] = i % 251
  }
  return bytes
}

/** 8-byte PNG signature. */
const PNG_BYTES = withFiller([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 64)

/** JPEG SOI plus the first marker byte. */
const JPEG_BYTES = withFiller([0xff, 0xd8, 0xff, 0xe0], 48)

/** 'RIFF' + a size field + 'WEBP'. */
const WEBP_BYTES = withFiller([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50], 56)

/** 'GIF89a' — a real image format, and deliberately not an accepted one. */
const GIF_BYTES = withFiller([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 32)

/** The uploaded part of a `multipart/form-data` body, as the account screen sends it. */
const avatarForm = (bytes: Uint8Array, filename = 'avatar.png', type = 'image/png') => {
  const form = new FormData()
  // The view goes in as it stands. This suite typechecks against `@cloudflare/workers-types`, where
  // a file's parts are `(ArrayBuffer | ArrayBufferView | string)[]` — the DOM's `BlobPart` does not
  // exist here, and `.buffer` widens to `ArrayBufferLike`, which `SharedArrayBuffer` also satisfies.
  form.set('file', new File([bytes], filename, { type }))
  return form
}

export { avatarForm, GIF_BYTES, JPEG_BYTES, PNG_BYTES, WEBP_BYTES }
