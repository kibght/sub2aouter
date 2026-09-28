#!/usr/bin/env node

import { nextReleaseVersion } from './lib/release-version.mjs'

console.log(nextReleaseVersion(process.argv[2] || ''))
