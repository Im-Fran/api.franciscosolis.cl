import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { contentDisposition, filenameInput, objectKeyFor } from '@/lib/files'

describe('filenameInput', () => {
  it('accepts the filenames a build actually has', () => {
    for (const name of ['app-2.6.4.jar', 'Installer (x64).exe', 'my_app.tar.gz', 'App+beta.zip']) {
      expect(v.safeParse(filenameInput, name).success).toBe(true)
    }
  })

  it('refuses anything carrying a path', () => {
    // The object key is built from ids, so this is not what stops a traversal — but a name with a
    // separator in it still means something else once a browser has written it to disk.
    for (const name of ['../etc/passwd', 'dir/app.zip', 'dir\\app.zip', '.hidden']) {
      expect(v.safeParse(filenameInput, name).success).toBe(false)
    }
  })

  it('refuses an empty name', () => {
    expect(v.safeParse(filenameInput, '   ').success).toBe(false)
  })
})

describe('objectKeyFor', () => {
  it('prefixes by product and release, and never uses the filename', () => {
    expect(objectKeyFor('app-1', 'release-1', 'file-1')).toBe('releases/app-1/release-1/file-1')
  })
})

describe('contentDisposition', () => {
  it('emits both forms so an accented name survives', () => {
    const header = contentDisposition('instalación.zip')
    expect(header).toContain('filename="instalaci_n.zip"')
    expect(header).toContain("filename*=UTF-8''instalaci%C3%B3n.zip")
  })

  it('neutralises a quote that would end the header early', () => {
    expect(contentDisposition('we"ird.zip')).toContain('filename="we_ird.zip"')
  })
})
