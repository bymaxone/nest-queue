/**
 * @fileoverview Sandboxed processor fixture: waits `job.data.ms`, and reports progress every
 * `job.data.progressMs` while it waits when that is set.
 * @layer test/e2e/fixtures
 */
const { setInterval, clearInterval, setTimeout } = require('node:timers')

module.exports = async (job) => {
  const { ms, progressMs } = job.data
  let beats = 0
  const beat = progressMs
    ? setInterval(() => void job.updateProgress(++beats), progressMs)
    : undefined
  await new Promise((resolve) => setTimeout(resolve, ms))
  clearInterval(beat)
  return 'sandboxed'
}
