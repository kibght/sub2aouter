import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const bash = process.env.BASH_PATH || (process.platform === 'win32' ? 'D:/Program Files/Git/bin/bash.exe' : 'bash')
const workflow = await readFile('.github/workflows/sync-watchdog.yml', 'utf8')
const assessment = workflow.match(/      - name: Select final watchdog assessment[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1]
assert.ok(assessment)
const script = assessment.split('\n').map((line) => line.slice(10)).join('\n')

test('the final watchdog assessment follows recovery and retains dispatch or inspection failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sync-watchdog-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scenarios = [
    { state: 'healthy', recovery: 'success', alert: false },
    { state: 'running', recovery: 'success', alert: false },
    { state: 'recoverable', recovery: 'success', alert: true },
    { state: 'recoverable', recovery: 'failure', inputAlert: false, alert: true, expected: 'critical' },
    { state: 'recoverable', recovery: 'cancelled', alert: true, expected: 'critical' },
    { state: 'critical', recovery: 'skipped', alert: true },
    { state: 'healthy', recovery: 'skipped', inspection: 'failure', inputAlert: false, alert: true, expected: 'critical' },
  ]
  for (const [index, scenario] of scenarios.entries()) {
    const output = path.join(root, `output-${index}`)
    const result = spawnSync(bash, ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INSPECTION_RESULT: scenario.inspection || 'success', RECOVERY_RESULT: scenario.recovery,
        HEALTH_STATE: scenario.state, SHOULD_ALERT: String(scenario.inputAlert ?? scenario.alert),
        HEALTH_SUMMARY: 'health assessment',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(root, `summary-${index}`),
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const final = await readFile(output, 'utf8')
    assert.match(final, new RegExp(`^state=${scenario.expected || scenario.state}$`, 'm'))
    assert.match(final, new RegExp(`^should_alert=${scenario.alert}$`, 'm'))
  }
  assert.match(workflow, /needs\.assess\.outputs\.should_alert == 'true'/)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  mark-unhealthy:')), /needs\.inspect\.outputs\.should_alert/)
})
