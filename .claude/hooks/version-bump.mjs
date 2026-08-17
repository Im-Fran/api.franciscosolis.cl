#!/usr/bin/env node
/**
 * Keeps the deployable version of every touched Worker moving.
 *
 * Each app under `apps/` carries its own `version` in `package.json`, and that string is what
 * identifies the bundle Wrangler deploys. This hook makes sure an app that changed on a branch
 * never ships under the same version as the branch it forked from.
 *
 * Modes:
 *   bump    - bump every app that changed since the base branch. Idempotent: once a branch carries
 *             a bump for an app, further edits do not bump it again (they only ever *raise* the
 *             level, e.g. patch -> minor when a `feat:` commit lands later).
 *   commit  - same as `bump`, plus `git add` of every package.json it rewrote, so the bump travels
 *             in the commit that is about to be created rather than dangling behind it.
 *   verify  - non-mutating check used before a pull request is opened. Exits 2 (blocking) listing
 *             any app that changed without a version bump.
 *
 * The level follows MAJOR.MINOR.PATCH, inferred from the branch's Conventional Commit subjects for
 * that app: `feat!:`/`BREAKING CHANGE` -> major, `feat:` -> minor, anything else -> patch. Set
 * CLAUDE_VERSION_BUMP=major|minor|patch to override.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Branch every feature branch forks from. This repo uses `dev`, never `main`/`master`. */
const DEFAULT_BRANCH = 'dev'
const LEVELS = ['patch', 'minor', 'major']

const mode = process.argv[2] ?? 'bump'
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()

/** Runs git and returns trimmed stdout, or null when the command fails (missing ref, no repo, …). */
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * The hook payload arrives as JSON on stdin. It is absent when the script is run by hand, so a
 * failed read is not an error — it just means there is no tool call to inspect.
 */
const readHookInput = () => {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

const input = readHookInput()

/**
 * The base to diff against. `origin/dev` is the truth in CI and in a fresh clone; the local `dev`
 * is the fallback for an offline checkout. Falling back to HEAD is not a failure: it simply narrows
 * the hook to uncommitted work, which is the right answer when there is no branch point to compare.
 */
const resolveBase = () => {
  for (const ref of [`origin/${DEFAULT_BRANCH}`, DEFAULT_BRANCH]) {
    if (git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) {
      return git('merge-base', 'HEAD', ref) ?? ref
    }
  }
  return 'HEAD'
}

/** Every app under `apps/` with a file touched on this branch, committed or not. */
const changedApps = (base) => {
  const diffs = [
    git('diff', '--name-only', `${base}...HEAD`),
    git('diff', '--name-only', 'HEAD'),
    git('diff', '--name-only', '--cached'),
    git('ls-files', '--others', '--exclude-standard'),
  ]

  const apps = new Set()
  for (const out of diffs) {
    for (const file of (out ?? '').split('\n')) {
      const match = file.match(/^apps\/([^/]+)\//)
      if (match) apps.add(match[1])
    }
  }
  return [...apps].sort()
}

const parseVersion = (raw) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw ?? '')
  return match ? match.slice(1, 4).map(Number) : null
}

/** The app's version as of `ref`, or null when the app did not exist there yet. */
const versionAt = (ref, app) => {
  const contents = git('show', `${ref}:apps/${app}/package.json`)
  if (!contents) return null
  try {
    return parseVersion(JSON.parse(contents).version)
  } catch {
    return null
  }
}

/** Which of MAJOR/MINOR/PATCH already moved between two versions, or null when nothing did. */
const appliedLevel = (base, current) => {
  if (current[0] !== base[0]) return 'major'
  if (current[1] !== base[1]) return 'minor'
  if (current[2] !== base[2]) return 'patch'
  return null
}

/** The level this app's commits call for. Unreleased work with no commits yet is a patch. */
const requestedLevel = (base, app) => {
  const override = process.env.CLAUDE_VERSION_BUMP
  if (override && LEVELS.includes(override)) return override

  // \x1e separates commits, \x00 separates a commit's subject from its body.
  const log = git('log', '--format=%s%x00%b%x1e', `${base}..HEAD`, '--', `apps/${app}`) ?? ''
  let level = 'patch'

  for (const record of log.split('\x1e')) {
    const [subject = '', body = ''] = record.replace(/^\n+/, '').split('\x00')
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE/m.test(body)) return 'major'
    if (/^feat(\([^)]*\))?:/.test(subject)) level = 'minor'
  }
  return level
}

const applyLevel = ([major, minor, patch], level) => {
  if (level === 'major') return [major + 1, 0, 0]
  if (level === 'minor') return [major, minor + 1, 0]
  return [major, minor, patch + 1]
}

/**
 * Decides what an app's version should be, without writing anything.
 *
 * Returns null when there is nothing to do — either the app is new (no base to compare against, so
 * whatever version it declares is deliberate) or the branch already carries a bump at or above the
 * level its commits call for. That second case is what makes the hook safe to run on every edit.
 */
const plan = (base, app) => {
  const manifest = join(root, 'apps', app, 'package.json')
  if (!existsSync(manifest)) return null

  const baseVersion = versionAt(base, app)
  if (!baseVersion) return null

  let current
  try {
    current = parseVersion(JSON.parse(readFileSync(manifest, 'utf8')).version)
  } catch {
    return null
  }
  if (!current) return null

  const wanted = requestedLevel(base, app)
  const already = appliedLevel(baseVersion, current)
  if (already && LEVELS.indexOf(already) >= LEVELS.indexOf(wanted)) return null

  const next = applyLevel(baseVersion, wanted).join('.')
  if (next === current.join('.')) return null

  return { app, manifest, from: current.join('.'), to: next, level: wanted }
}

/** Rewrites only the `version` line, so key order and formatting survive untouched. */
const write = ({ manifest, from, to }) => {
  const contents = readFileSync(manifest, 'utf8')
  writeFileSync(manifest, contents.replace(`"version": "${from}"`, `"version": "${to}"`))
}

/** Hook contract: exit 0 with JSON on stdout to inform, exit 2 with stderr to block the tool call. */
const inform = (message) => {
  process.stdout.write(JSON.stringify({ systemMessage: message, suppressOutput: true }))
  process.exit(0)
}

const block = (message) => {
  process.stderr.write(message)
  process.exit(2)
}

// `bump` is wired to file edits, which fire constantly. Skip the git work unless the edited file is
// inside an app — everything else (docs, workspace config, this hook) has no version to move.
if (mode === 'bump') {
  const edited = input.tool_input?.file_path ?? input.tool_response?.filePath ?? ''
  if (!/(^|\/)apps\/[^/]+\//.test(edited)) process.exit(0)
}

// `commit` is wired to every Bash call, but only a commit is the right moment to fold the bump in.
if (mode === 'commit' && !/\bgit\s+commit\b/.test(input.tool_input?.command ?? '')) process.exit(0)

// `verify` guards pull request creation: the MCP tool, or the CLI equivalent when it is available.
if (mode === 'verify' && input.tool_name === 'Bash' && !/\bgh\s+pr\s+create\b/.test(input.tool_input?.command ?? '')) {
  process.exit(0)
}

if (!git('rev-parse', '--is-inside-work-tree')) process.exit(0)

const base = resolveBase()
const pending = changedApps(base).map((app) => plan(base, app)).filter(Boolean)

if (pending.length === 0) process.exit(0)

if (mode === 'verify') {
  const list = pending.map(({ app, from, to }) => `  - ${app}: ${from} -> ${to}`).join('\n')
  block(
    `These apps changed on this branch but still carry their base version:\n${list}\n\n` +
      'Run `node .claude/hooks/version-bump.mjs bump`, commit the result, then open the pull request.',
  )
}

for (const entry of pending) write(entry)

if (mode === 'commit') {
  git('add', '--', ...pending.map(({ app }) => `apps/${app}/package.json`))
}

inform(`Version bump: ${pending.map(({ app, to, level }) => `${app} -> ${to} (${level})`).join(', ')}`)
