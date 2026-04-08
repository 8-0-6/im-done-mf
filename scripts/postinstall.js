#!/usr/bin/env node
// Fix node-pty spawn-helper execute permission.
// node-pty prebuilt binaries ship without +x on spawn-helper,
// which causes posix_spawnp failed at runtime.

const fs = require('fs')
const path = require('path')

const prebuildsDir = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')

if (!fs.existsSync(prebuildsDir)) {
  // Not installed yet (e.g. running postinstall before node_modules exists) — skip
  process.exit(0)
}

let fixed = 0
for (const dir of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, dir, 'spawn-helper')
  if (fs.existsSync(helper)) {
    try {
      fs.chmodSync(helper, 0o755)
      fixed++
    } catch (e) {
      // Non-fatal: warn but don't fail install
      console.warn(`[imdone postinstall] Could not chmod ${helper}: ${e.message}`)
    }
  }
}

if (fixed > 0) {
  console.log(`[imdone postinstall] Fixed execute permission on ${fixed} node-pty spawn-helper binary/binaries`)
}
