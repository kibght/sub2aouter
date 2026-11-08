import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { normalizeBotBindingIntegrationTest } from '../lib/bot-binding-test-cleanup.mjs'

const unrelatedCleanup = '\tt.Cleanup(func() {\n\t\treleaseTestResources()\n\t})\n'

const legacyTest = `//go:build integration

package repository

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/stretchr/testify/require"
)

func TestBotBindingRepositoryFixture(t *testing.T) {
	ctx := context.Background()
	client := testEntClient(t)
	owner := mustCreateUser(t, client, &service.User{Email: "owner@example.invalid"})
	other := mustCreateUser(t, client, &service.User{
		Email: "other@example.invalid",
		Status: "suspended",
	})
	t.Cleanup(func() {
		_, _ = integrationDB.ExecContext(ctx, \`DELETE FROM bot_bindings WHERE user_id = $1 OR user_id = $2\`, owner.ID, other.ID)
		_, _ = integrationDB.ExecContext(ctx, \`DELETE FROM bot_binding_codes WHERE user_id = $1 OR user_id = $2\`, owner.ID, other.ID)
	})
${unrelatedCleanup}
	require.NotEqual(t, owner.ID, other.ID)
}
`

test('normalizes both legacy fixture users and cleans their rewards before deleting them', () => {
  const result = normalizeBotBindingIntegrationTest(legacyTest)

  assert.match(result, /owner := mustCreateBotBindingUser\(t, client, &service\.User\{Email: "owner@example\.invalid"\}\)/)
  assert.match(result, /other := mustCreateBotBindingUser\(t, client, &service\.User\{\n\t\tEmail: "other@example\.invalid",\n\t\tStatus: "suspended",\n\t\}\)/)
  assert.equal((result.match(/mustCreateBotBindingUser\(t, client,/g) || []).length, 2)
  assert.equal((result.match(/mustCreateUser\(t, client,/g) || []).length, 1)
  assert.match(result, /dbent "github\.com\/Wei-Shaw\/sub2api\/ent"/)
  assert.match(result, /ExecContext\(ctx, "DELETE FROM redeem_codes WHERE used_by = \$1", user\.ID\)/)
  assert.match(result, /ExecContext\(ctx, "DELETE FROM users WHERE id = \$1", user\.ID\)/)
  assert.ok(result.indexOf('DELETE FROM redeem_codes') < result.indexOf('DELETE FROM users'))
  assert.doesNotMatch(result, /DELETE FROM bot_bindings|DELETE FROM bot_binding_codes/)
  assert.ok(result.includes('\trequire.NotEqual(t, owner.ID, other.ID)\n'))
})

test('preserves cleanup unrelated to the legacy binding rows', () => {
  const result = normalizeBotBindingIntegrationTest(legacyTest)

  assert.ok(result.includes(unrelatedCleanup))
  assert.equal((result.match(/releaseTestResources\(\)/g) || []).length, 1)
})

test('normalizing an already repaired fixture is idempotent', () => {
  const once = normalizeBotBindingIntegrationTest(legacyTest)
  const twice = normalizeBotBindingIntegrationTest(once)

  assert.equal(twice, once)
  assert.equal((twice.match(/func mustCreateBotBindingUser\(/g) || []).length, 1)
  assert.equal((twice.match(/dbent "github\.com\/Wei-Shaw\/sub2api\/ent"/g) || []).length, 1)
})

test('rejects unfiltered reward deletion in legacy and already normalized fixtures', () => {
  const unsafeCleanup = unrelatedCleanup.replace(
    'releaseTestResources()',
    '_, _ = integrationDB.ExecContext(ctx, "DELETE FROM redeem_codes")',
  )

  for (const source of [legacyTest, normalizeBotBindingIntegrationTest(legacyTest)]) {
    assert.throws(
      () => normalizeBotBindingIntegrationTest(source.replace(unrelatedCleanup, unsafeCleanup)),
      /cleanup must be scoped by the fixture helper/,
    )
  }
})

test('the maintained integration test already matches the generated cleanup', async () => {
  const source = (await readFile(new URL('../../backend/internal/repository/bot_binding_repo_integration_test.go', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')

  assert.equal(normalizeBotBindingIntegrationTest(source), source)
  assert.equal((source.match(/mustCreateBotBindingUser\(t, client,/g) || []).length, 6)
})
