import assert from 'node:assert/strict'
import test from 'node:test'

import { nextReleaseVersion } from '../lib/release-version.mjs'

test('calendar releases migrate to v0.1.200', () => {
  assert.equal(nextReleaseVersion('2026.7.26'), '0.1.200')
  assert.equal(nextReleaseVersion(''), '0.1.200')
  assert.equal(nextReleaseVersion('0.1.199'), '0.1.200')
})

test('themed semantic releases increment from v0.1.200', () => {
  assert.equal(nextReleaseVersion('0.1.200'), '0.1.201')
  assert.equal(nextReleaseVersion('v0.1.207'), '0.1.208')
})

test('unrelated version schemes restart at v0.1.200', () => {
  assert.equal(nextReleaseVersion('1.2.3'), '0.1.200')
  assert.equal(nextReleaseVersion('invalid'), '0.1.200')
})
