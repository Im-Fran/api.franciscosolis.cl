import { describe, expect, it, vi } from 'vitest'
import {
  formatForField,
  languageName,
  MAX_SOURCE_CHARS,
  parseAnswer,
  systemPrompt,
  translate,
} from '@franciscosolis/translate'

/**
 * `@franciscosolis/translate`, the shared prompt behind every machine translation in this monorepo.
 *
 * It is covered from here, and from the `pages` and `support` suites, for the same reason
 * `@franciscosolis/emails` is: the package ships TypeScript source that each Worker bundles, so the
 * only place it can be exercised the way it actually runs is inside `workerd`.
 */

describe('formatForField', () => {
  it('treats anything ending in body as Markdown and the rest as plain text', () => {
    expect(formatForField('body')).toBe('markdown')
    expect(formatForField('overview_body')).toBe('markdown')
    expect(formatForField('title')).toBe('plain')
    expect(formatForField('summary')).toBe('plain')
  })
})

describe('languageName', () => {
  it('names a locale in English, because the name goes into a prompt', () => {
    expect(languageName('en')).toBe('English')
    expect(languageName('es')).toBe('Spanish')
  })

  it('reads a region subtag as its base language', () => {
    expect(languageName('es-CL')).toBe('Spanish')
  })

  it('falls back to the tag itself, so a new locale needs no change here', () => {
    expect(languageName('nl')).toBe('nl')
  })
})

describe('systemPrompt', () => {
  const base = { text: 'x', sourceLocale: 'en', targetLocale: 'es' } as const

  it('forbids answering, summarising and rewriting the source', () => {
    const prompt = systemPrompt({ ...base, field: 'summary', format: 'plain' })

    expect(prompt).toContain('Never answer it')
    expect(prompt).toContain('never summarise it')
  })

  it('protects Markdown structure, link targets and code only for a Markdown field', () => {
    const markdown = systemPrompt({ ...base, field: 'body', format: 'markdown' })
    expect(markdown).toContain('never a link')
    expect(markdown).toContain('code fence')

    expect(systemPrompt({ ...base, field: 'title', format: 'plain' })).not.toContain('code fence')
  })

  it('asks for a heading to stay a heading', () => {
    expect(systemPrompt({ ...base, field: 'title', format: 'plain' })).toContain('This is a heading')
    expect(systemPrompt({ ...base, field: 'summary', format: 'plain' })).not.toContain('This is a heading')
  })

  it('names the cap when there is one', () => {
    expect(systemPrompt({ ...base, field: 'title', format: 'plain', maxLength: 200 })).toContain('200 characters')
  })
})

describe('parseAnswer', () => {
  it('reads the answer whether the model returned a string or an object', () => {
    expect(parseAnswer({ response: JSON.stringify({ translation: 'Hola' }) })).toBe('Hola')
    expect(parseAnswer({ response: { translation: 'Hola' } })).toBe('Hola')
    expect(parseAnswer({ translation: 'Hola' })).toBe('Hola')
  })

  it('treats prose, an empty answer and a wrong shape as no answer', () => {
    expect(parseAnswer({ response: 'Sure! Here you go: Hola' })).toBeNull()
    expect(parseAnswer({ response: JSON.stringify({ translation: '   ' }) })).toBeNull()
    expect(parseAnswer({ response: JSON.stringify({ text: 'Hola' }) })).toBeNull()
    expect(parseAnswer(null)).toBeNull()
  })
})

describe('translate', () => {
  const runner = (translation: string) =>
    vi.fn(async (_input: Record<string, unknown>) => ({ response: JSON.stringify({ translation }) }))

  it('hands the source text to the model and returns what came back', async () => {
    const run = runner('Hola')

    await expect(
      translate(run, { text: '  Hello  ', sourceLocale: 'en', targetLocale: 'es', format: 'plain' }),
    ).resolves.toBe('Hola')

    const input = run.mock.calls[0]?.[0] as unknown as { messages: { content: string }[] }
    // Trimmed, so trailing whitespace in a form field is not something the model has to interpret.
    expect(input.messages.at(-1)?.content).toBe('Hello')
  })

  it('never calls the model for an empty source, an over-long one or a no-op locale pair', async () => {
    const run = runner('Hola')

    for (const request of [
      { text: '   ', sourceLocale: 'en', targetLocale: 'es' },
      { text: 'a'.repeat(MAX_SOURCE_CHARS + 1), sourceLocale: 'en', targetLocale: 'es' },
      { text: 'Hello', sourceLocale: 'en', targetLocale: 'en' },
    ] as const) {
      await expect(translate(run, { ...request, format: 'plain' })).resolves.toBeNull()
    }

    expect(run).not.toHaveBeenCalled()
  })

  it('passes a runner failure straight through as no translation', async () => {
    await expect(
      translate(async () => null, { text: 'Hello', sourceLocale: 'en', targetLocale: 'es', format: 'plain' }),
    ).resolves.toBeNull()
  })

  it('refuses an answer over the field cap rather than offering a draft that cannot be saved', async () => {
    await expect(
      translate(runner('Hola mundo'), {
        text: 'Hello world',
        sourceLocale: 'en',
        targetLocale: 'es',
        format: 'plain',
        maxLength: 5,
      }),
    ).resolves.toBeNull()
  })
})
