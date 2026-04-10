#!/usr/bin/env node
// Fix node-pty spawn-helper execute permission.
// node-pty prebuilt binaries ship without +x on spawn-helper,
// which causes posix_spawnp failed at runtime.

const fs = require('fs')
const path = require('path')

// Use require.resolve so Node's module resolution finds node-pty wherever npm
// placed it — handles hoisting (node-pty lives in the parent's node_modules,
// not imdone-mf's own node_modules) as well as nested/workspace layouts.
let prebuildsDir
try {
  const nodePtyPkg = require.resolve('node-pty/package.json')
  prebuildsDir = path.join(path.dirname(nodePtyPkg), 'prebuilds')
} catch (e) {
  // node-pty not resolvable — nothing to fix
  process.exit(0)
}

if (!fs.existsSync(prebuildsDir)) {
  // prebuilds dir absent (e.g. locally compiled build) — nothing to fix
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
