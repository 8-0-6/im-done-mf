#!/usr/bin/env node
// Downloads the imdone-listen universal binary (arm64 + x86_64).
// Non-fatal — imdone still works without it (TTS fires, STT is skipped).

const https = require('https')
const fs = require('fs')
const path = require('path')

if (process.platform !== 'darwin') process.exit(0)

const pkg = require('../package.json')
const version = `v${pkg.version}`
function getRepoSlug(repositoryField) {
  if (!repositoryField) return null

  if (typeof repositoryField === 'string') {
    return repositoryField
      .replace(/^git\+/, '')
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
  }

  if (typeof repositoryField === 'object' && typeof repositoryField.url === 'string') {
    return repositoryField.url
      .replace(/^git\+/, '')
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
  }

  return null
}

const repoSlug = getRepoSlug(pkg.repository)
if (!repoSlug) {
  console.warn('[imdone] Could not resolve repository slug from package.json')
  process.exit(0)
}

const url = `https://github.com/${repoSlug}/releases/download/${version}/imdone-listen-darwin`
const outPath = path.join(__dirname, '..', 'bin', 'imdone-listen')

fs.mkdirSync(path.dirname(outPath), { recursive: true })

function download(url, dest, hops = 5) {
  return new Promise((resolve, reject) => {
    if (hops === 0) return reject(new Error('too many redirects'))
    https.get(url, { headers: { 'User-Agent': 'imdone-mf' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest, hops - 1).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`))
      const tmp = dest + '.tmp'
      const file = fs.createWriteStream(tmp)
      res.pipe(file)
      file.on('finish', () => {
        file.close()
        fs.renameSync(tmp, dest)
        resolve()
      })
      file.on('error', reject)
    }).on('error', reject)
  })
}

download(url, outPath)
  .then(() => {
    fs.chmodSync(outPath, 0o755)
    console.log('[imdone] imdone-listen ready (universal)')
  })
  .catch(err => {
    console.warn(`[imdone] Could not download imdone-listen: ${err.message}`)
    console.warn(`[imdone] Voice input disabled. Run \`imdone --diagnose\` for details.`)
  })
