import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  applyNonNegativeBalance,
  BALANCE_PATCHES,
} from '../apply-non-negative-balance.mjs'

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

test('non-negative balance guard is applied and current', async () => {
  const result = await applyNonNegativeBalance({ root, check: true })
  assert.equal(result.changed, false)
  assert.ok(BALANCE_PATCHES.length >= 10)
})

test('non-negative balance guard does not patch redeem-code behavior', () => {
  assert.equal(
    BALANCE_PATCHES.some((patch) =>
      patch.replacement.includes('ApplyRedeemBalanceAdjustment') &&
      patch.replacement.includes('invalidBalanceDelta(delta)'),
    ),
    false,
  )
})

test('redeem-code adjustment remains outside the balance guard', async () => {
  const userRepo = await readFile(path.join(root, 'backend/internal/repository/user_repo.go'), 'utf8')
  const redeemStart = userRepo.indexOf('func (r *userRepository) ApplyRedeemBalanceAdjustment')
  const redeemEnd = userRepo.indexOf('\n}\n', redeemStart)
  assert.ok(redeemStart >= 0)
  assert.doesNotMatch(userRepo.slice(redeemStart, redeemEnd), /invalidBalanceDelta/)
})

test('non-negative balance guard applies cleanly to the previous upstream layout', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sub2api-balance-baseline-'))
  const contents = new Map()
  for (const target of [...new Set(BALANCE_PATCHES.map((patch) => patch.target))]) {
    const content = (await readFile(path.join(root, target), 'utf8')).replaceAll('\r\n', '\n')
    contents.set(target, content)
  }

  // Reconstruct the pre-guard layout from the checked-in result so this test
  // remains self-contained and does not depend on a git executable.
  for (const patch of [...BALANCE_PATCHES].reverse()) {
    const content = contents.get(patch.target)
    if (patch.skipWhen && content.includes(patch.skipWhen)) {
      continue
    }
    const replacement = patch.replacement.replaceAll('\r\n', '\n')
    const marker = patch.marker.replaceAll('\r\n', '\n')
    assert.ok(content.includes(replacement), `fixture is missing current replacement for ${patch.target}`)
    contents.set(patch.target, content.replace(replacement, marker))
  }

  for (const [target, content] of contents) {
    const file = path.join(fixture, target)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
  }

  const first = await applyNonNegativeBalance({ root: fixture })
  assert.equal(first.changed, true)
  const second = await applyNonNegativeBalance({ root: fixture, check: true })
  assert.equal(second.changed, false)
})

test('non-negative balance guard fails closed when an upstream marker drifts', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sub2api-balance-guard-'))
  const targets = [...new Set(BALANCE_PATCHES.map((patch) => patch.target))]
  for (const target of targets) {
    const source = path.join(root, target)
    const destination = path.join(fixture, target)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  const userRepoPath = path.join(fixture, 'backend/internal/repository/user_repo.go')
  const userRepo = await readFile(userRepoPath, 'utf8')
  await writeFile(
    userRepoPath,
    userRepo.replace(
      '// sub2aouter: non-negative-balance-create-v1',
      '// upstream: balance implementation changed',
    ),
    'utf8',
  )

  await assert.rejects(
    () => applyNonNegativeBalance({ root: fixture }),
    /Non-negative balance patch marker not found in backend\/internal\/repository\/user_repo\.go/,
  )
})

test('non-negative balance guard fails closed when a sentinel implementation drifts', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sub2api-balance-sentinel-drift-'))
  const targets = [...new Set(BALANCE_PATCHES.map((patch) => patch.target))]
  for (const target of targets) {
    const source = path.join(root, target)
    const destination = path.join(fixture, target)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  const userRepoPath = path.join(fixture, 'backend/internal/repository/user_repo.go')
  const userRepo = await readFile(userRepoPath, 'utf8')
  await writeFile(
    userRepoPath,
    userRepo.replace(
      '\t\t// Keep the balance floor in the same atomic UPDATE as the increment so\n',
      '\t\t// Upstream retained the marker but changed the implementation.\n',
    ),
    'utf8',
  )

  await assert.rejects(
    () => applyNonNegativeBalance({ root: fixture }),
    /Non-negative balance patch sentinel drift detected in backend\/internal\/repository\/user_repo\.go/,
  )
})

test('usage settlement preserves overdraft while administrative paths stay guarded', async () => {
  const userRepo = await readFile(path.join(root, 'backend/internal/repository/user_repo.go'), 'utf8')
  const usageRepo = await readFile(path.join(root, 'backend/internal/repository/usage_billing_repo.go'), 'utf8')
  const cacheRepo = await readFile(path.join(root, 'backend/internal/repository/billing_cache.go'), 'utf8')

  const deductStart = userRepo.indexOf('func (r *userRepository) DeductBalance')
  const deductEnd = userRepo.indexOf('\n}', deductStart)
  const deduct = userRepo.slice(deductStart, deductEnd)
  assert.doesNotMatch(deduct, /BalanceGTE\(amount\)/)
  assert.match(deduct, /billing-overdraft-deduct-v1/)
  assert.match(usageRepo, /WHERE id = \$2 AND deleted_at IS NULL\s+RETURNING balance/)
  assert.doesNotMatch(cacheRepo, /if newVal < 0/)
})
