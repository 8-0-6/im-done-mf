#!/usr/bin/env node
'use strict'

// Downloads Piper TTS binary + en_US-lessac-high voice model to ~/.imdone/piper/
// Run via: imdone --setup-piper

const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

if (process.platform !== 'darwin') {
  console.error('[imdone] --setup-piper is only supported on macOS')
  process.exit(1)
}

const IMDONE_DIR = path.join(os.homedir(), '.imdone')
const PIPER_DIR = path.join(IMDONE_DIR, 'piper')
const VOICE = 'en_US-lessac-high'
const PIPER_BINARY = path.join(PIPER_DIR, 'piper')
const MODEL_PATH = path.join(IMDONE_DIR, `${VOICE}.onnx`)
const CONFIG_PATH = path.join(IMDONE_DIR, `${VOICE}.onnx.json`)

const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
const PIPER_VERSION = '2023.11.14-2'
const PIPER_URL = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_macos_${arch}.tar.gz`
const VOICE_BASE = `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/high`
const MODEL_URL = `${VOICE_BASE}/${VOICE}.onnx`
const CONFIG_URL = `${VOICE_BASE}/${VOICE}.onnx.json`

function download(url, dest, hops = 8) {
  return new Promise((resolve, reject) => {
    if (hops === 0) return reject(new Error('too many redirects'))
    https.get(url, { headers: { 'User-Agent': 'imdone-mf' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        return download(res.headers.location, dest, hops - 1).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`))
      const tmp = dest + '.tmp'
      const file = fs.createWriteStream(tmp)
      res.pipe(file)
      file.on('finish', () => { file.close(); fs.renameSync(tmp, dest); resolve() })
      file.on('error', reject)
    }).on('error', reject)
  })
}

async function main() {
  fs.mkdirSync(IMDONE_DIR, { recursive: true })

  // --- Piper binary ---
  if (fs.existsSync(PIPER_BINARY)) {
    console.log('[imdone] Piper binary already installed.')
  } else {
    console.log(`[imdone] Downloading Piper binary (${arch})...`)
    const tarPath = path.join(IMDONE_DIR, 'piper.tar.gz')
    await download(PIPER_URL, tarPath)
    console.log('[imdone] Extracting...')
    execFileSync('tar', ['-xzf', tarPath, '-C', IMDONE_DIR])
    fs.unlinkSync(tarPath)
    fs.chmodSync(PIPER_BINARY, 0o755)
    console.log('[imdone] Piper binary ready.')
  }

  // --- Voice model ---
  if (fs.existsSync(MODEL_PATH) && fs.existsSync(CONFIG_PATH)) {
    console.log('[imdone] Voice model already installed.')
  } else {
    console.log('[imdone] Downloading voice model (en_US-lessac-high, ~63MB)...')
    await download(MODEL_URL, MODEL_PATH)
    await download(CONFIG_URL, CONFIG_PATH)
    console.log('[imdone] Voice model ready.')
  }

  console.log('\nimdone --setup-piper complete.')
  console.log('Run `imdone` — Piper will be used automatically.\n')
}

main().catch(err => {
  console.error(`[imdone] --setup-piper failed: ${err.message}`)
  process.exit(1)
})
