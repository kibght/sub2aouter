import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reconcileUpstreamGoToolchain } from '../reconcile-upstream-go-toolchain.mjs'

test('upstream Dockerfiles use the Go version declared by backend/go.mod', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstream-go-toolchain-'))
  try {
    await mkdir(path.join(root, 'backend'))
    await mkdir(path.join(root, 'deploy'))
    await writeFile(path.join(root, 'backend/go.mod'), [
      'module example.test/app',
      '',
      'go 1.27.3',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'Dockerfile'), [
      'ARG GOLANG_IMAGE=golang:1.27.2-alpine',
      'FROM $' + '{GOLANG_IMAGE}',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'backend/Dockerfile'), [
      'FROM golang:1.27.2-alpine',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'deploy/Dockerfile'), [
      'ARG GOLANG_IMAGE=golang:1.27.2-alpine',
      '',
    ].join('\n'))

    const result = await reconcileUpstreamGoToolchain({ root })

    assert.equal(result.version, '1.27.3')
    assert.deepEqual(result.changedFiles, ['Dockerfile', 'backend/Dockerfile', 'deploy/Dockerfile'])
    for (const file of ['Dockerfile', 'backend/Dockerfile', 'deploy/Dockerfile']) {
      assert.match(await readFile(path.join(root, file), 'utf8'), /golang:1\.27\.3-alpine/)
    }
    assert.deepEqual((await reconcileUpstreamGoToolchain({ root })).changedFiles, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('upstream Go toolchain reconciliation rejects missing versions and image references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'upstream-go-toolchain-invalid-'))
  try {
    await mkdir(path.join(root, 'backend'))
    await mkdir(path.join(root, 'deploy'))
    await writeFile(path.join(root, 'backend/go.mod'), [
      'module example.test/app',
      'go 1.27',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'Dockerfile'), [
      'FROM golang:1.27.2-alpine',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'backend/Dockerfile'), [
      'FROM golang:1.27.2-alpine',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'deploy/Dockerfile'), [
      'FROM golang:1.27.2-alpine',
      '',
    ].join('\n'))
    await assert.rejects(reconcileUpstreamGoToolchain({ root }), /full Go version/)

    await writeFile(path.join(root, 'backend/go.mod'), [
      'module example.test/app',
      '',
      'go 1.27.3',
      '',
    ].join('\n'))
    await writeFile(path.join(root, 'Dockerfile'), [
      'FROM alpine:3.22',
      '',
    ].join('\n'))
    await assert.rejects(reconcileUpstreamGoToolchain({ root }), /Dockerfile has no full golang image reference/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
