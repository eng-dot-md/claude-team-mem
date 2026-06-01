// Unit tests for the highest-risk pure logic in the foundation library:
// remote URL parsing edge cases, frontmatter block termination + nested metadata,
// slug validation, native-dir slug rule, and pathInside.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRemote, sameRepo, autoStorageUrl } from '../src/lib/remote'
import { parseFrontmatter, isValidSlug } from '../src/lib/frontmatter'
import { slugForPath, pathInside } from '../src/lib/paths'
import { specToStorageUrl } from '../src/resolve'

test('parseRemote: scp-like with .git', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/app.git'), {
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
  })
})

test('parseRemote: https with trailing slash and .git', () => {
  assert.deepEqual(parseRemote('https://github.com/acme/app.git/'), {
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
  })
})

test('parseRemote: ssh:// with user and port', () => {
  assert.deepEqual(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/repo.git'), {
    host: 'gitlab.example.com',
    owner: 'group/sub',
    repo: 'repo',
  })
})

test('parseRemote: nested gitlab path preserved (no middle segment dropped)', () => {
  assert.deepEqual(parseRemote('https://gitlab.com/group/sub/team/repo'), {
    host: 'gitlab.com',
    owner: 'group/sub/team',
    repo: 'repo',
  })
})

test('parseRemote: garbage returns null', () => {
  assert.equal(parseRemote('not a url'), null)
  assert.equal(parseRemote(''), null)
  assert.equal(parseRemote(undefined), null)
})

test('sameRepo: normalizes trailing slash/.git across forms', () => {
  assert.equal(sameRepo('git@github.com:acme/app.git', 'https://github.com/acme/app'), true)
  assert.equal(sameRepo('https://github.com/acme/app/', 'https://github.com/acme/app.git'), true)
  assert.equal(sameRepo('git@github.com:acme/app.git', 'git@github.com:acme/other.git'), false)
})

test('autoStorageUrl: scp-like origin -> claude-team-memory, owner swapped', () => {
  assert.equal(
    autoStorageUrl('git@github.com:someuser/myproj.git', 'acme'),
    'git@github.com:acme/claude-team-memory.git',
  )
})

test('autoStorageUrl: https origin preserves scheme/host/port', () => {
  assert.equal(
    autoStorageUrl('https://ghe.corp.com:8443/u/p.git', 'acme'),
    'https://ghe.corp.com:8443/acme/claude-team-memory.git',
  )
})

test('frontmatter: --- inside body does not close the block', () => {
  const content = ['---', 'name: Foo', 'description: a fact', '---', 'body line', '---', 'still body'].join('\n')
  const { data, body } = parseFrontmatter(content)
  assert.equal(data.name, 'Foo')
  assert.equal(data.description, 'a fact')
  assert.equal(body, 'body line\n---\nstill body')
})

test('frontmatter: nested metadata block -> object, quotes stripped', () => {
  const content = [
    '---',
    'name: "Quoted Name"',
    "description: 'single quoted'",
    'metadata:',
    '  type: project',
    '  scope: team',
    '  origin: team',
    '---',
    'body',
  ].join('\n')
  const { data } = parseFrontmatter(content)
  assert.equal(data.name, 'Quoted Name')
  assert.equal(data.description, 'single quoted')
  assert.deepEqual(data.metadata, { type: 'project', scope: 'team', origin: 'team' })
})

test('frontmatter: no leading --- => whole thing is body', () => {
  const { data, body } = parseFrontmatter('# Heading\ntext')
  assert.deepEqual(data, {})
  assert.equal(body, '# Heading\ntext')
})

test('frontmatter: unterminated frontmatter is fail-soft', () => {
  const content = '---\nname: Foo\nno closing fence'
  const { data, body } = parseFrontmatter(content)
  assert.deepEqual(data, {})
  assert.equal(body, content)
})

test('isValidSlug: allows internal/leading dots, rejects separators and traversal', () => {
  assert.equal(isValidSlug('foo.md'), true)
  assert.equal(isValidSlug('api.v2.notes.md'), true)
  assert.equal(isValidSlug('.env-notes.md'), true)
  assert.equal(isValidSlug('a/b.md'), false)
  assert.equal(isValidSlug('../escape.md'), false)
  assert.equal(isValidSlug('/abs.md'), false)
  assert.equal(isValidSlug('..'), false)
  assert.equal(isValidSlug(''), false)
  assert.equal(isValidSlug('a\\b.md'), false)
})

test('slugForPath: every / and . becomes -', () => {
  assert.equal(slugForPath('/Users/u/ws/app'), '-Users-u-ws-app')
  assert.equal(slugForPath('/Users/u/my.proj.dir'), '-Users-u-my-proj-dir')
})

test('pathInside: nesting and identity', () => {
  assert.equal(pathInside('/a/b/c', '/a/b'), true)
  assert.equal(pathInside('/a/b', '/a/b'), true)
  assert.equal(pathInside('/a/sibling', '/a/b'), false)
  assert.equal(pathInside('/a/b/../x', '/a/b'), false)
})

test('specToStorageUrl: auto, full URL, bare owner/repo', () => {
  const origin = 'git@github.com:someuser/proj.git'
  assert.equal(specToStorageUrl('auto', origin, 'acme'), 'git@github.com:acme/claude-team-memory.git')
  assert.equal(
    specToStorageUrl('git@github.com:x/y.git', origin, 'acme'),
    'git@github.com:x/y.git',
  )
  assert.equal(
    specToStorageUrl('globex/shared', origin, 'acme'),
    'git@github.com:globex/shared.git',
  )
})
