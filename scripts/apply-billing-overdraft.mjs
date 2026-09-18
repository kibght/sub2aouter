#!/usr/bin/env node

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const lines = (...items) => items.join('\n')

// This overlay is applied after the historical non-negative balance overlay.
// It preserves non-negative administrative balance mutations while restoring
// overdraft for usage settlement and adding the user-scoped hard stop.
export const BILLING_OVERDRAFT_PATCHES = Object.freeze([
  {
    target: 'backend/internal/repository/user_repo.go',
    marker: lines(
      'func (r *userRepository) DeductBalance(ctx context.Context, id int64, amount float64) error {',
      '\t// sub2aouter: non-negative-balance-deduct-input-v1',
      '\tif invalidBalanceDelta(amount) || amount < 0 {',
      '\t\tif amount == 0 {',
      '\t\t\treturn nil',
      '\t\t}',
      '\t\treturn fmt.Errorf("deduct balance amount must be positive")',
      '\t}',
      '\tclient := clientFromContext(ctx, r.client)',
      '\tn, err := client.User.Update().',
      '\t\tWhere(dbuser.IDEQ(id), dbuser.BalanceGTE(amount)).',
      '\t\tAddBalance(-amount).',
      '\t\tSave(ctx)',
      '\tif err != nil {',
      '\t\treturn err',
      '\t}',
      '\tif n > 0 {',
      '\t\treturn nil',
      '\t}',
      '',
      '\t// sub2aouter: non-negative-balance-deduct-floor-v1',
      '\tif _, queryErr := client.User.Query().Where(dbuser.IDEQ(id)).Only(ctx); queryErr != nil {',
      '\t\treturn translatePersistenceError(queryErr, service.ErrUserNotFound, nil)',
      '\t}',
      '\treturn service.ErrBalanceNegative',
      '}',
    ),
    replacement: lines(
      'func (r *userRepository) DeductBalance(ctx context.Context, id int64, amount float64) error {',
      '\t// sub2aouter: billing-overdraft-deduct-v1',
      '\tif invalidBalanceDelta(amount) || amount < 0 {',
      '\t\tif amount == 0 {',
      '\t\t\treturn nil',
      '\t\t}',
      '\t\treturn fmt.Errorf("deduct balance amount must be positive")',
      '\t}',
      '\tclient := clientFromContext(ctx, r.client)',
      '\tn, err := client.User.Update().',
      '\t\tWhere(dbuser.IDEQ(id)).',
      '\t\tAddBalance(-amount).',
      '\t\tSave(ctx)',
      '\tif err != nil {',
      '\t\treturn err',
      '\t}',
      '\tif n > 0 {',
      '\t\treturn nil',
      '\t}',
      '\tif _, queryErr := client.User.Query().Where(dbuser.IDEQ(id)).Only(ctx); queryErr != nil {',
      '\t\treturn translatePersistenceError(queryErr, service.ErrUserNotFound, nil)',
      '\t}',
      '\treturn nil',
      '}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-deduct-v1',
  },
  {
    target: 'backend/internal/repository/usage_billing_repo.go',
    marker: lines(
      'func deductUsageBillingBalance(ctx context.Context, tx *sql.Tx, userID int64, amount float64) (float64, bool, error) {',
      '\tvar newBalance float64',
      '\terr := tx.QueryRowContext(ctx, `',
      '\t\tUPDATE users',
      '\t\tSET balance = balance - $1,',
      '\t\t\tupdated_at = NOW()',
      '\t\tWHERE id = $2 AND deleted_at IS NULL AND balance >= $1',
      '\t\tRETURNING balance',
      '\t`, amount, userID).Scan(&newBalance)',
      '\tif err == nil {',
      '\t\treturn newBalance, true, nil',
      '\t}',
      '\tif !errors.Is(err, sql.ErrNoRows) {',
      '\t\treturn 0, false, err',
      '\t}',
      '',
      '\t// sub2aouter: non-negative-balance-unified-billing-v1',
      '\tif exists, existsErr := userExistsForBilling(ctx, tx, userID); existsErr != nil {',
      '\t\treturn 0, false, existsErr',
      '\t} else if !exists {',
      '\t\treturn 0, false, service.ErrUserNotFound',
      '\t}',
      '\treturn 0, false, service.ErrInsufficientBalance',
      '}',
    ),
    replacement: lines(
      'func deductUsageBillingBalance(ctx context.Context, tx *sql.Tx, userID int64, amount float64) (float64, bool, error) {',
      '\t// sub2aouter: billing-overdraft-unified-v1',
      '\tvar newBalance float64',
      '\terr := tx.QueryRowContext(ctx, `',
      '\t\tUPDATE users',
      '\t\tSET balance = balance - $1,',
      '\t\t\tupdated_at = NOW()',
      '\t\tWHERE id = $2 AND deleted_at IS NULL',
      '\t\tRETURNING balance',
      '\t`, amount, userID).Scan(&newBalance)',
      '\tif err == nil {',
      '\t\treturn newBalance, newBalance >= 0, nil',
      '\t}',
      '\tif !errors.Is(err, sql.ErrNoRows) {',
      '\t\treturn 0, false, err',
      '\t}',
      '',
      '\tif exists, existsErr := userExistsForBilling(ctx, tx, userID); existsErr != nil {',
      '\t\treturn 0, false, existsErr',
      '\t} else if !exists {',
      '\t\treturn 0, false, service.ErrUserNotFound',
      '\t}',
      '\treturn 0, false, service.ErrUserNotFound',
      '}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-unified-v1',
  },
  {
    target: 'backend/internal/repository/billing_cache.go',
    marker: lines(
      '\t\t-- sub2aouter: non-negative-balance-cache-script-v1',
      '\t\tlocal currentVal = tonumber(current)',
      '\t\tlocal amount = tonumber(ARGV[1])',
      '\t\tif currentVal == nil or amount == nil or amount < 0 then',
      '\t\t\treturn 0',
      '\t\tend',
      '\t\tlocal newVal = currentVal - amount',
      '\t\tif newVal < 0 then',
      '\t\t\tnewVal = 0',
      '\t\tend',
      "\t\tredis.call('SET', KEYS[1], newVal)",
    ),
    replacement: lines(
      '\t\t-- sub2aouter: billing-overdraft-cache-script-v1',
      '\t\tlocal currentVal = tonumber(current)',
      '\t\tlocal amount = tonumber(ARGV[1])',
      '\t\tif currentVal == nil or amount == nil or amount < 0 then',
      '\t\t\treturn 0',
      '\t\tend',
      '\t\tlocal newVal = currentVal - amount',
      "\t\tredis.call('SET', KEYS[1], newVal)",
    ),
    sentinel: '-- sub2aouter: billing-overdraft-cache-script-v1',
  },
  {
    target: 'backend/internal/repository/billing_cache.go',
    marker: lines(
      'func (c *billingCache) SetUserBalance(ctx context.Context, userID int64, balance float64) error {',
      '\t// sub2aouter: non-negative-balance-cache-set-v1',
      '\tif balance < 0 || math.IsNaN(balance) || math.IsInf(balance, 0) {',
      '\t\treturn service.ErrBalanceNegative',
      '\t}',
      '\tkey := billingBalanceKey(userID)',
      '\treturn c.rdb.Set(ctx, key, balance, jitteredTTL()).Err()',
      '}',
    ),
    replacement: lines(
      'func (c *billingCache) SetUserBalance(ctx context.Context, userID int64, balance float64) error {',
      '\t// sub2aouter: billing-overdraft-cache-set-v1',
      '\tif math.IsNaN(balance) || math.IsInf(balance, 0) {',
      '\t\treturn fmt.Errorf("balance must be finite")',
      '\t}',
      '\tkey := billingBalanceKey(userID)',
      '\treturn c.rdb.Set(ctx, key, balance, jitteredTTL()).Err()',
      '}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-cache-set-v1',
  },
  {
    target: 'backend/internal/repository/billing_cache.go',
    marker: lines(
      'func (c *billingCache) DeductUserBalance(ctx context.Context, userID int64, amount float64) error {',
      '\t// sub2aouter: non-negative-balance-cache-deduct-v1',
      '\tif amount < 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {',
      '\t\treturn fmt.Errorf("deduct balance amount must be non-negative and finite")',
      '\t}',
      '\tif amount == 0 {',
      '\t\treturn nil',
      '\t}',
      '\tkey := billingBalanceKey(userID)',
      '\t_, err := deductBalanceScript.Run(ctx, c.rdb, []string{key}, amount, int(jitteredTTL().Seconds())).Result()',
      '\tif err != nil && !errors.Is(err, redis.Nil) {',
      '\t\tlog.Printf("Warning: deduct balance cache failed for user %d: %v", userID, err)',
      '\t\treturn err',
      '\t}',
      '\treturn nil',
      '}',
    ),
    replacement: lines(
      'func (c *billingCache) DeductUserBalance(ctx context.Context, userID int64, amount float64) error {',
      '\t// sub2aouter: billing-overdraft-cache-deduct-v1',
      '\tif amount < 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {',
      '\t\treturn fmt.Errorf("deduct balance amount must be non-negative and finite")',
      '\t}',
      '\tif amount == 0 {',
      '\t\treturn nil',
      '\t}',
      '\tkey := billingBalanceKey(userID)',
      '\t_, err := deductBalanceScript.Run(ctx, c.rdb, []string{key}, amount, int(jitteredTTL().Seconds())).Result()',
      '\tif err != nil && !errors.Is(err, redis.Nil) {',
      '\t\tlog.Printf("Warning: deduct balance cache failed for user %d: %v", userID, err)',
      '\t\treturn err',
      '\t}',
      '\treturn nil',
      '}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-cache-deduct-v1',
  },
  {
    target: 'backend/internal/service/gateway_usage_billing.go',
    marker: lines(
      '\t\tif cost.ActualCost > 0 {',
      '\t\t\tif err := deps.userRepo.DeductBalance(billingCtx, p.User.ID, cost.ActualCost); err != nil {',
      '\t\t\t\tslog.Error("deduct balance failed", "user_id", p.User.ID, "error", err)',
      '\t\t\t} else if deps.billingCacheService != nil {',
      '\t\t\t\tif err := deps.billingCacheService.InvalidateUserBalance(billingCtx, p.User.ID); err != nil {',
      '\t\t\t\t\tslog.Warn("invalidate balance cache after legacy deduction failed", "user_id", p.User.ID, "error", err)',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
    ),
    replacement: lines(
      '\t\tif cost.ActualCost > 0 {',
      '\t\t\tif err := deps.userRepo.DeductBalance(billingCtx, p.User.ID, cost.ActualCost); err != nil {',
      '\t\t\t\tslog.Error("deduct balance failed", "user_id", p.User.ID, "error", err)',
      '\t\t\t} else {',
      '\t\t\t\tif deps.billingCacheService != nil {',
      '\t\t\t\t\tif err := deps.billingCacheService.InvalidateUserBalance(billingCtx, p.User.ID); err != nil {',
      '\t\t\t\t\t\tslog.Warn("invalidate balance cache after legacy deduction failed", "user_id", p.User.ID, "error", err)',
      '\t\t\t\t\t}',
      '\t\t\t\t}',
      '\t\t\t\t// The legacy path has no RETURNING balance. Its request snapshot is',
      '\t\t\t\t// the best available signal in this degraded path; production uses the',
      '\t\t\t\t// unified repository result above, which is authoritative.',
      '\t\t\t\tif p.User.Balance-cost.ActualCost < 0 {',
      '\t\t\t\t\t// sub2aouter: billing-overdraft-legacy-cancel-v1',
      '\t\t\t\t\tCancelGatewayRequestsForUser(p.User.ID)',
      '\t\t\t\t}',
      '\t\t\t}',
      '\t\t}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-legacy-cancel-v1',
  },
  {
    target: 'backend/internal/service/gateway_usage_billing.go',
    marker: lines(
      '\tif result == nil || !result.Applied {',
      '\t\tdeps.deferredService.ScheduleLastUsedUpdate(p.Account.ID)',
      '\t\treturn false, nil',
      '\t}',
      '',
      '\tif result.APIKeyQuotaExhausted {',
    ),
    replacement: lines(
      '\tif result == nil || !result.Applied {',
      '\t\tdeps.deferredService.ScheduleLastUsedUpdate(p.Account.ID)',
      '\t\treturn false, nil',
      '\t}',
      '\tif !p.IsSubscriptionBill && p.User != nil && result.NewBalance != nil && *result.NewBalance < 0 {',
      '\t\t// Commit has succeeded, so the negative balance is the authoritative',
      '\t\t// sub2aouter: billing-overdraft-commit-cancel-v1',
      '\t\t// overdraft event. Cancel every other request registered for this user;',
      '\t\t// their upstream clients and stream loops observe ctx.Done().',
      '\t\tCancelGatewayRequestsForUser(p.User.ID)',
      '\t}',
      '',
      '\tif result.APIKeyQuotaExhausted {',
    ),
    sentinel: '// sub2aouter: billing-overdraft-commit-cancel-v1',
  },
  {
    target: 'backend/internal/service/gateway_usage_billing.go',
    marker: lines(
      'func detachStreamUpstreamContext(ctx context.Context, stream bool) (context.Context, context.CancelFunc) {',
      '\tif ctx == nil {',
      '\t\treturn context.Background(), func() {}',
      '\t}',
      '\tif !stream {',
      '\t\treturn ctx, func() {}',
      '\t}',
      '\treturn context.WithoutCancel(ctx), func() {}',
      '}',
      '',
      'func detachUpstreamContext(ctx context.Context) (context.Context, context.CancelFunc) {',
      '\tif ctx == nil {',
      '\t\treturn context.Background(), func() {}',
      '\t}',
      '\treturn context.WithoutCancel(ctx), func() {}',
      '}',
    ),
    replacement: lines(
      'func detachStreamUpstreamContext(ctx context.Context, stream bool) (context.Context, context.CancelFunc) {',
      '\tif ctx == nil {',
      '\t\treturn context.Background(), func() {}',
      '\t}',
      '\t// A balance-overdraft cancellation is an operator-controlled hard stop,',
      '\t// not a client disconnect. Preserve the cancellation cause so the upstream',
      '\t// request is interrupted instead of being detached and drained.',
      '\tif IsGatewayBalanceOverdraft(ctx) {',
      '\t\treturn ctx, func() {}',
      '\t}',
      '\tif !stream {',
      '\t\treturn ctx, func() {}',
      '\t}',
      '\treturn detachOverdraftAwareContext(ctx)',
      '}',
      '',
      'func detachUpstreamContext(ctx context.Context) (context.Context, context.CancelFunc) {',
      '\tif ctx == nil {',
      '\t\treturn context.Background(), func() {}',
      '\t}',
      '\tif IsGatewayBalanceOverdraft(ctx) {',
      '\t\treturn ctx, func() {}',
      '\t}',
      '\treturn detachOverdraftAwareContext(ctx)',
      '}',
      '',
      '// detachOverdraftAwareContext keeps the historical detached behavior for',
      '// ordinary client disconnects while still propagating the explicit overdraft',
      '// cancellation that must stop upstream generation and failover.',
      'func detachOverdraftAwareContext(ctx context.Context) (context.Context, context.CancelFunc) {',
      '\tbase := context.WithoutCancel(ctx)',
      '\tdetached, cancel := context.WithCancelCause(base)',
      '\tgo func() {',
      '\t\tselect {',
      '\t\tcase <-ctx.Done():',
      '\t\t\tif IsGatewayBalanceOverdraft(ctx) {',
      '\t\t\t\tcancel(ErrGatewayBalanceOverdraft)',
      '\t\t\t}',
      '\t\tcase <-detached.Done():',
      '\t\t}',
      '\t}()',
      '\t// sub2aouter: billing-overdraft-upstream-context-v1',
      '\t// Callers build the http.Request before sending it and historically invoke',
      '\t// the returned release function immediately after that build step. Releasing',
      '\t// here must therefore not cancel the request; the request lifecycle is still',
      '\t// active and only an explicit overdraft cause should stop it. The parent',
      '\t// request cancellation ends the watcher for ordinary disconnects, while the',
      '\t// detached context remains usable for the upstream call as before.',
      '\treturn detached, func() {}',
      '}',
    ),
    sentinel: 'func detachOverdraftAwareContext(ctx context.Context) (context.Context, context.CancelFunc) {',
  },
  {
    target: 'backend/internal/server/middleware/api_key_auth.go',
    marker: lines(
      '\t\tctx := context.WithValue(c.Request.Context(), ctxkey.UserID, apiKey.User.ID)',
      '\t\tc.Request = c.Request.WithContext(ctx)',
    ),
    replacement: lines(
      '\t\tctx := context.WithValue(c.Request.Context(), ctxkey.UserID, apiKey.User.ID)',
      '\t\t// Keep every authenticated gateway request cancellable by user. When a',
      '\t\t// completed concurrent request commits a negative balance, billing calls',
      '\t\t// CancelGatewayRequestsForUser and the derived context tears down all',
      '\t\t// remaining upstream HTTP/stream/WebSocket work for this user.',
      '\t\trequestCtx, unregisterGatewayRequest := service.RegisterGatewayRequest(ctx, apiKey.User.ID)',
      '\t\tdefer unregisterGatewayRequest()',
      '\t\tc.Request = c.Request.WithContext(requestCtx)',
    ),
    sentinel: 'service.RegisterGatewayRequest(ctx, apiKey.User.ID)',
  },
  {
    target: 'backend/internal/handler/openai_gateway_handler.go',
    marker: '\t\t\tBeforeRequest: func(turn int, payload []byte, originalModel string) error {',
    replacement: lines(
      '\t\t\tBeforeRequest: func(turn int, payload []byte, originalModel string) error {',
      '\t\t\t\tif err := ctx.Err(); err != nil {',
      '\t\t\t\t\t// sub2aouter: billing-overdraft-ws-before-request-v1',
      '\t\t\t\t\treturn service.NewOpenAIWSClientCloseError(coderws.StatusTryAgainLater, "request cancelled after balance overdraft", err)',
      '\t\t\t\t}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-ws-before-request-v1',
  },
  {
    target: 'backend/internal/handler/openai_gateway_handler.go',
    marker: '\t\t\tBeforeTurn: func(turn int) error {',
    replacement: lines(
      '\t\t\tBeforeTurn: func(turn int) error {',
      '\t\t\t\tif err := ctx.Err(); err != nil {',
      '\t\t\t\t\t// sub2aouter: billing-overdraft-ws-before-turn-v1',
      '\t\t\t\t\treturn service.NewOpenAIWSClientCloseError(coderws.StatusTryAgainLater, "request cancelled after balance overdraft", err)',
      '\t\t\t\t}',
    ),
    sentinel: '// sub2aouter: billing-overdraft-ws-before-turn-v1',
  },
])

export const BILLING_OVERDRAFT_COPY_FILES = Object.freeze([
  'backend/internal/service/gateway_request_cancellation.go',
  'backend/internal/service/gateway_request_cancellation_test.go',
  'backend/internal/repository/usage_billing_repo_unit_test.go',
  'backend/migrations/193_restore_usage_balance_overdraft.sql',
])

function withDetectedLineEndings(content, value) {
  return content.includes('\r\n') ? value.replaceAll('\n', '\r\n') : value
}

async function applyPatch(root, patch, check) {
  const file = path.join(root, patch.target)
  const content = await readFile(file, 'utf8')
  const replacement = withDetectedLineEndings(content, patch.replacement)
  if (content.includes(patch.sentinel)) {
    const sentinelIndex = content.indexOf(patch.sentinel)
    const replacementSentinelIndex = replacement.indexOf(patch.sentinel)
    const replacementStart = sentinelIndex - replacementSentinelIndex
    if (
      replacementSentinelIndex < 0 ||
      replacementStart < 0 ||
      content.slice(replacementStart, replacementStart + replacement.length) !== replacement
    ) {
      throw new Error(`Billing overdraft patch sentinel drift detected in ${patch.target}: ${patch.sentinel}`)
    }
    return false
  }
  const marker = withDetectedLineEndings(content, patch.marker)
  const index = content.indexOf(marker)
  if (index < 0) {
    throw new Error(`Billing overdraft patch marker not found in ${patch.target}: ${patch.marker.slice(0, 120)}`)
  }
  if (check) throw new Error(`Billing overdraft patch drift detected in ${patch.target}`)
  await writeFile(file, `${content.slice(0, index)}${replacement}${content.slice(index + marker.length)}`, 'utf8')
  return true
}

async function copyFiles(root, sourceRoot, check) {
  if (!sourceRoot) return false
  let changed = false
  for (const relative of BILLING_OVERDRAFT_COPY_FILES) {
    const source = path.join(sourceRoot, relative)
    const target = path.join(root, relative)
    const sourceContent = await readFile(source)
    let targetContent = null
    try {
      targetContent = await readFile(target)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (targetContent && Buffer.compare(sourceContent, targetContent) === 0) continue
    if (check) throw new Error(`Billing overdraft copied file drift detected in ${relative}`)
    await copyFile(source, target)
    changed = true
  }
  return changed
}

export async function applyBillingOverdraft({ root, sourceRoot = '', check = false }) {
  const resolvedRoot = path.resolve(root)
  let changed = false
  for (const patch of BILLING_OVERDRAFT_PATCHES) {
    changed = (await applyPatch(resolvedRoot, patch, check)) || changed
  }
  changed = (await copyFiles(resolvedRoot, sourceRoot ? path.resolve(sourceRoot) : '', check)) || changed
  return { changed }
}

async function main() {
  const args = process.argv.slice(2)
  const rootIndex = args.indexOf('--root')
  const sourceIndex = args.indexOf('--source')
  const root = rootIndex >= 0 ? args[rootIndex + 1] : args[0]
  const sourceRoot = sourceIndex >= 0 ? args[sourceIndex + 1] : ''
  if (!root) throw new Error('Usage: node scripts/apply-billing-overdraft.mjs --root <path> [--source <path>] [--check]')
  const result = await applyBillingOverdraft({ root, sourceRoot, check: args.includes('--check') })
  console.log(result.changed ? 'Applied billing overdraft policy.' : 'Billing overdraft policy already current.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
