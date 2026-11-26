/**
 * @fileoverview Unit tests for the adapter over BullMQ's protected `processFn`, and the pin on the
 * members of the installed BullMQ that it relies on.
 * @layer server/utils
 */

import { Worker } from 'bullmq'
import { abandonWorker } from './abandoned-workers'
import { dropSandboxOutcomeOnceAbandoned } from './drop-sandbox-outcome'

type Runner = (...args: unknown[]) => Promise<unknown>

/** A stand-in for a sandboxed worker, wrapped by the adapter. */
function wrapped(sandbox: Runner): { worker: { processFn: Runner }; run: Runner } {
  const worker = { processFn: sandbox }
  dropSandboxOutcomeOnceAbandoned(worker)
  return { worker, run: worker.processFn }
}

/** Whether `call` settles before the macrotask queue turns twice. */
async function settles(call: Promise<unknown>): Promise<boolean> {
  let settled = false
  const mark = (): void => {
    settled = true
  }
  void call.then(mark, mark)
  await new Promise((done) => setImmediate(done))
  await new Promise((done) => setImmediate(done))
  return settled
}

describe('dropSandboxOutcomeOnceAbandoned', () => {
  // While the worker runs, the adapter changes nothing: same arguments in, same result out.
  it('hands on the arguments and the result of a worker that is still running', async () => {
    const sandbox = jest.fn<Promise<unknown>, unknown[]>().mockResolvedValue('done')
    const { run } = wrapped(sandbox)

    await expect(run('job', 'token', 'signal')).resolves.toBe('done')
    expect(sandbox).toHaveBeenCalledWith('job', 'token', 'signal')
  })

  // A failure of a running worker is BullMQ's to record.
  it('hands on the failure of a worker that is still running', async () => {
    const failure = new Error('boom')
    const { run } = wrapped(() => Promise.reject(failure))

    await expect(run()).rejects.toBe(failure)
  })

  // The late result would be written over a closed connection.
  it('never settles for a result that arrives after the worker was stopped', async () => {
    const { worker, run } = wrapped(() => Promise.resolve('late'))
    const call = run()
    abandonWorker(worker)

    await expect(settles(call)).resolves.toBe(false)
  })

  // A terminated thread rejects at once; recording that would fail a job that should run again.
  it('never settles for a failure that arrives after the worker was stopped', async () => {
    const { worker, run } = wrapped(() => Promise.reject(new Error('Unexpected exit code: 1')))
    const call = run()
    abandonWorker(worker)

    await expect(settles(call)).resolves.toBe(false)
  })

  // A mocked or renamed member must not turn into a processor that was never there.
  it('adds nothing to a worker without the member, and says it wrapped nothing', () => {
    const worker = {}

    expect(dropSandboxOutcomeOnceAbandoned(worker)).toBe(false)
    expect(worker).toEqual({})
  })

  // The caller reports a worker it could not wrap, so a wrapped one must not read as one.
  it('says it wrapped a worker that has the member', () => {
    expect(dropSandboxOutcomeOnceAbandoned({ processFn: () => Promise.resolve() })).toBe(true)
  })
})

describe('the members of the installed BullMQ Worker the adapter relies on', () => {
  const members = Worker.prototype as unknown as {
    createSandbox: (this: object, processor: string) => void
    callProcessJob: (this: object, job: string, token: string, signal: string) => unknown
  }

  // If this fails, BullMQ renamed the member and a sandboxed worker's late outcome is not dropped.
  it('assigns the sandbox to processFn', () => {
    const target: { childPool: object; processFn?: unknown } = { childPool: {} }

    members.createSandbox.call(target, '/processor.js')

    expect(typeof target.processFn).toBe('function')
  })

  // The replacement takes effect only because the member is read for each job.
  it('reads processFn again for every job', () => {
    const processFn = jest.fn()

    members.callProcessJob.call({ processFn }, 'job', 'token', 'signal')

    expect(processFn).toHaveBeenCalledWith('job', 'token', 'signal')
  })
})
