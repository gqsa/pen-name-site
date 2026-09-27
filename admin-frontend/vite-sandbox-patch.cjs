// vite-sandbox-patch.cjs — build workaround for the confined Windows sandbox.
//
// Under the DSH Windows sandbox (workspace-write confinement) any `spawn` with
// piped stdio throws `EPERM` SYNCHRONOUSLY (errno -4048) — the callback is
// never registered, so callback-based error handling cannot catch it. Vite's
// one-time Windows initialisation (optimizeSafeRealPathSync) calls
// exec('net use') to map network drives; the synchronous throw crashes the
// whole build before anything runs.
//
// This preloaded module wraps child_process.exec / execFile and converts a
// synchronous EPERM throw into the normal callback-error form. Vite's code
// treats that as "no network drives" and proceeds with plain fs.realpathSync —
// the build then runs to completion. Loaded via:
//
//   node -r ./vite-sandbox-patch.cjs ../node_modules/vite/bin/vite.js build
//
// Outside the sandbox the wrapper is transparent (the try-block wins).
'use strict'
const cp = require('child_process')

function wrapWithSwallow(fn) {
  return function patched(...args) {
    try {
      return fn.apply(cp, args)
    } catch (err) {
      const cb = (typeof args[args.length - 1] === 'function')
        ? args[args.length - 1]
        : (typeof args[args.length - 2] === 'function' ? args[args.length - 2] : null)
      if (cb) process.nextTick(() => cb(err, '', ''))
      return { on() {}, kill() {}, pid: undefined }
    }
  }
}
cp.exec = wrapWithSwallow(cp.exec)
cp.execFile = wrapWithSwallow(cp.execFile)
