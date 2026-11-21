const helperName = 'mustCreateBotBindingUser'
const helper = `func mustCreateBotBindingUser(t *testing.T, client *dbent.Client, input *service.User) *service.User {
	t.Helper()
	user := mustCreateUser(t, client, input)
	t.Cleanup(func() {
		ctx := context.Background()
		// Redeem records retain their rows when a user is deleted, so remove them first.
		_, err := integrationDB.ExecContext(ctx, "DELETE FROM redeem_codes WHERE used_by = $1", user.ID)
		require.NoError(t, err, "clean up bot binding reward records")
		_, err = integrationDB.ExecContext(ctx, "DELETE FROM users WHERE id = $1", user.ID)
		require.NoError(t, err, "clean up bot binding user")
	})
	return user
}
`

function verifyFixtureCleanup(text) {
  const outsideHelper = text.replace(helper, '')
  if (!text.includes(helper) || outsideHelper.includes('mustCreateUser(t, client,')) {
    throw new Error('bot binding integration fixtures have incomplete cleanup')
  }
  if (/DELETE\s+FROM\s+(?:bot_bindings|bot_binding_codes|redeem_codes|users)\b/i.test(outsideHelper)) {
    throw new Error('bot binding integration cleanup must be scoped by the fixture helper')
  }
  return text
}

export function normalizeBotBindingIntegrationTest(source) {
  let text = source.replace(/\r\n/g, '\n')
  if (text.includes(`func ${helperName}(`)) {
    return verifyFixtureCleanup(text)
  }

  // Replace the legacy partial cleanup with cleanup registered for every fixture.
  // Keep unrelated cleanup callbacks intact.
  text = text.replace(/\n\tt\.Cleanup\(func\(\) \{\n(?:\t\t[^\n]*\n)+\t\}\)\n/g, (block) => (
    /DELETE FROM (?:bot_bindings|bot_binding_codes)\b/.test(block) ? '\n' : block
  ))
  if (!text.includes('mustCreateUser(t, client,')) {
    throw new Error('bot binding integration user fixtures not found')
  }
  text = text.replaceAll('mustCreateUser(t, client,', `${helperName}(t, client,`)

  const serviceImport = '\t"github.com/Wei-Shaw/sub2api/internal/service"'
  const entImport = '\tdbent "github.com/Wei-Shaw/sub2api/ent"'
  if (!text.includes(entImport)) {
    if (!text.includes(serviceImport)) throw new Error('bot binding integration service import not found')
    text = text.replace(serviceImport, `${entImport}\n${serviceImport}`)
  }
  const firstTest = text.indexOf('func TestBotBindingRepository')
  if (firstTest < 0) throw new Error('bot binding integration test entry not found')
  return verifyFixtureCleanup(text.slice(0, firstTest) + helper + '\n' + text.slice(firstTest))
}
