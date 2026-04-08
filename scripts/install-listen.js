#!/usr/bin/env node
// Downloads the correct imdone-listen binary for the current platform/arch.
// Non-fatal — imdone still works without it (TTS fires, STT is skipped).

const https = require('https')
const fs = require('fs')
const path = require('path')

if (process.platform !== 'darwin') process.exit(0)

const pkg = require('../package.json')
const version = `v${pkg.version}`
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const repo = pkg.repository
const asset = `imdone-listen-darwin-${arch}`
const url = `https://github.com/${repo}/releases/download/${version}/${asset}`
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
    console.log(`[imdone] imdone-listen ready (darwin-${arch})`)
  })
  .catch(err => {
    console.warn(`[imdone] Could not download imdone-listen: ${err.message}`)
    console.warn(`[imdone] Voice input disabled. Run \`imdone --diagnose\` for details.`)
  })
