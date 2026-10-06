// Validation-only stub for the missing `multer` package: handlers/files.js only
// needs a callable multer() with a memoryStorage() helper at import time.
function multer() {
  return { single: () => (_req, _res, next) => { if (typeof next === 'function') next() } }
}

multer.memoryStorage = () => ({})

export default multer
