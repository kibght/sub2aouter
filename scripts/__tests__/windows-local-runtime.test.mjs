import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import test from 'node:test'

const root = 'tools/windows-local'
const execFileAsync = promisify(execFile)

test('Windows local runtime defines the complete Sub2API stack', async () => {
  const compose = await readFile(`${root}/docker-compose.yml`, 'utf8')
  assert.match(compose, /sub2api:\s*[\s\S]*build:\s*[\s\S]*context: \.\.\/\.\./)
  assert.match(compose, /postgres:\s*[\s\S]*image: postgres:18-alpine/)
  assert.match(compose, /redis:\s*[\s\S]*image: redis:8-alpine/)
  assert.match(compose, /127\.0\.0\.1.*18080.*8080/)
  assert.match(compose, /sub2api_data:/)
  assert.match(compose, /postgres_data:/)
  assert.match(compose, /redis_data:/)
})

test('Windows launchers use Docker Compose and never start a mock API', async () => {
  const start = await readFile(`${root}/start-local.ps1`, 'utf8')
  const stop = await readFile(`${root}/stop-local.ps1`, 'utf8')
  assert.match(start, /docker compose/)
  assert.match(start, /http:\/\/127\.0\.0\.1:\$serverPort/)
  assert.doesNotMatch(start, /mock-server|Mock API/i)
  assert.match(stop, /docker compose/)
})
test('Windows startup repairs incomplete env files and validates Compose before launch', async () => {
  const start = await readFile(`${root}/start-local.ps1`, 'utf8')
  assert.match(start, /Ensure-LocalEnvironment/)
  assert.match(start, /compose[\s\S]*config[\s\S]*--quiet/)
  assert.match(start, /POSTGRES_PASSWORD[\s\S]*ADMIN_PASSWORD[\s\S]*JWT_SECRET[\s\S]*TOTP_ENCRYPTION_KEY/)
})

test('Windows startup can bootstrap missing prerequisites and elevated installer returns its real exit code', async () => {
  const start = await readFile(`${root}/start-local.ps1`, 'utf8')
  const installer = await readFile(`${root}/install-prerequisites.ps1`, 'utf8')
  assert.match(start, /install-prerequisites\.ps1/)
  assert.match(installer, /Start-Process[\s\S]*-PassThru/)
  assert.match(installer, /\.ExitCode/)
})
test('Windows environment preparation generates and repairs required secrets', { skip: process.platform !== 'win32' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sub2api-windows-env-'))
  const envFile = path.join(temp, '.env')
  const script = path.resolve(root, 'start-local.ps1')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PrepareOnly', '-EnvironmentFile', envFile])
    let env = await readFile(envFile, 'utf8')
    assert.doesNotMatch(env, /__[A-Z_]+__/)

    env = env.replace(/^POSTGRES_PASSWORD=.*$/m, 'POSTGRES_PASSWORD=')
    await writeFile(envFile, env, 'utf8')
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PrepareOnly', '-EnvironmentFile', envFile])

    const repaired = await readFile(envFile, 'utf8')
    assert.match(repaired, /^POSTGRES_PASSWORD=[0-9a-f]{48}$/m)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})