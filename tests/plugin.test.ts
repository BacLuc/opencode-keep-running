import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveConfig, createSessionState, findSessionIdInEvent, KeepRunningPlugin, DEFAULTS } from '../src/index'
import type { PluginOptions, PluginInput, Hooks } from '@opencode-ai/plugin'
import type { Event } from '@opencode-ai/sdk'

function createMockClient() {
  const abort = vi.fn().mockResolvedValue({ data: true })
  const prompt = vi.fn().mockResolvedValue({ data: { info: { id: 'msg-1' } } })
  return {
    session: { abort, prompt },
    app: { log: vi.fn() },
  }
}

function createPluginContext(client: ReturnType<typeof createMockClient>): PluginInput {
  return {
    client: client as any,
    project: { id: 'proj-1', worktree: '/tmp/test' } as any,
    directory: '/tmp/test',
    worktree: '/tmp/test',
    $: {} as any,
    serverUrl: new URL('http://localhost:4096'),
  }
}

function makeEvent(type: string, properties: Record<string, unknown>): Event {
  return { type, properties } as Event
}

async function createPlugin(config: PluginOptions = {}) {
  const client = createMockClient()
  const ctx = createPluginContext(client)
  const hooks = await KeepRunningPlugin(ctx, { threshold: 10_000, ...config })
  return { client, hooks }
}

async function emitEvent(hooks: Hooks, type: string, properties: Record<string, unknown>) {
  await hooks.event!({ event: makeEvent(type, properties) })
}

async function emitToolAfter(hooks: Hooks, sessionId: string) {
  await hooks['tool.execute.after']!(
    { tool: 'bash', sessionID: sessionId, callID: 'c1', args: {} } as any,
    { title: '', output: '', metadata: {} } as any,
  )
}

describe('resolveConfig', () => {
  it('returns defaults when no options provided', () => {
    const config = resolveConfig(undefined)
    expect(config.threshold).toBe(DEFAULTS.threshold)
    expect(config.message).toBe(DEFAULTS.message)
    expect(config.abortBeforeContinue).toBe(DEFAULTS.abortBeforeContinue)
    expect(config.abortCooldown).toBe(DEFAULTS.abortCooldown)
    expect(config.maxContinues).toBe(DEFAULTS.maxContinues)
    expect(config.continueCooldown).toBe(DEFAULTS.continueCooldown)
    expect(config.debug).toBe(DEFAULTS.debug)
  })

  it('overrides defaults with provided values', () => {
    const config = resolveConfig({ threshold: 5000, message: 'keep going', maxContinues: 3 })
    expect(config.threshold).toBe(5000)
    expect(config.message).toBe('keep going')
    expect(config.maxContinues).toBe(3)
    expect(config.abortBeforeContinue).toBe(DEFAULTS.abortBeforeContinue)
  })
})

describe('createSessionState', () => {
  it('returns fresh state with expected defaults', () => {
    const state = createSessionState()
    expect(state.isActive).toBe(false)
    expect(state.continuesSent).toBe(0)
    expect(state.isResolvingStuck).toBe(false)
    expect(state.scheduledCheck).toBeNull()
    expect(state.lastContinueAt).toBe(0)
    expect(state.lastActivityAt).toBeGreaterThan(0)
  })
})

describe('findSessionIdInEvent', () => {
  it('finds sessionID at top level', () => {
    const event = makeEvent('session.status', { sessionID: 's1', status: { type: 'busy' } })
    expect(findSessionIdInEvent(event)).toBe('s1')
  })

  it('finds sessionID inside info', () => {
    const event = makeEvent('message.updated', { info: { sessionID: 's2', role: 'assistant' } })
    expect(findSessionIdInEvent(event)).toBe('s2')
  })

  it('finds id inside info for session.created', () => {
    const event = makeEvent('session.created', { info: { id: 's3' } })
    expect(findSessionIdInEvent(event)).toBe('s3')
  })

  it('finds sessionID inside part', () => {
    const event = makeEvent('message.part.updated', { part: { sessionID: 's4', type: 'text' } })
    expect(findSessionIdInEvent(event)).toBe('s4')
  })

  it('returns undefined when no id found', () => {
    const event = makeEvent('session.error', { error: { name: 'UnknownError' } })
    expect(findSessionIdInEvent(event)).toBeUndefined()
  })
})

describe('KeepRunningPlugin', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('normal usage — does not interfere', () => {
    it('does not abort when session receives regular activity', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000 })
      const sid = 'sess-normal'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(2_000)
        await emitToolAfter(hooks, sid)
      }

      await vi.advanceTimersByTimeAsync(2_000)

      expect(client.session.abort).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it('clears timer when session goes idle', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000 })
      const sid = 'sess-idle'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'idle' } })

      await vi.advanceTimersByTimeAsync(30_000)

      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('stops monitoring on session.idle event', async () => {
      const { client, hooks } = await createPlugin({ threshold: 5_000 })
      const sid = 'sess-idle-ev'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitEvent(hooks, 'session.idle', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(30_000)
      expect(client.session.abort).not.toHaveBeenCalled()
    })
  })

  describe('stuck detection and auto-continue', () => {
    it('aborts and sends continue message after threshold', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 1_000,
        message: 'please continue',
      })
      const sid = 'sess-stuck'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(client.session.abort).toHaveBeenCalledTimes(1)
      expect(client.session.abort).toHaveBeenCalledWith({ path: { id: sid } })
      expect(client.session.prompt).toHaveBeenCalledTimes(1)
      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: sid },
        body: { parts: [{ type: 'text', text: 'please continue' }] },
      })
    })

    it('skips abort when abortBeforeContinue is false', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortBeforeContinue: false,
        message: 'go on',
      })
      const sid = 'sess-no-abort'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).not.toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalledTimes(1)
      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: sid },
        body: { parts: [{ type: 'text', text: 'go on' }] },
      })
    })

    it('postpones detection when activity arrives before threshold', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-almost'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      expect(client.session.abort).not.toHaveBeenCalled()

      await emitToolAfter(hooks, sid)

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('treats retry status as activity, postponing detection', async () => {
      const { client, hooks } = await createPlugin({ threshold: 5_000 })
      const sid = 'sess-retry'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(4_000)

      await emitEvent(hooks, 'session.status', {
        sessionID: sid,
        status: { type: 'retry', attempt: 1, message: 'rate limited' },
      })

      await vi.advanceTimersByTimeAsync(4_000)
      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('tracks activity from message.part.updated events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-parts'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'message.part.updated', { part: { sessionID: sid, type: 'text' } })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from message.updated events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-msg'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(6_000)

      await emitEvent(hooks, 'message.updated', { info: { sessionID: sid, role: 'assistant' } })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('re-schedules after continue, detecting subsequent stucks', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        maxContinues: 3,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-restuck'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(client.session.abort).toHaveBeenCalledTimes(3)
    })
  })

  describe('max continues limit', () => {
    it('stops trying after maxContinues is reached', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        maxContinues: 2,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-max'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(2)
    })

    it('resets count when session is recreated', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        maxContinues: 2,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-fresh'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(2)

      await emitEvent(hooks, 'session.created', { info: { id: sid } })
      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(3)
    })
  })

  describe('continue cooldown', () => {
    it('waits for continueCooldown before scheduling next check', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        continueCooldown: 15_000,
        abortCooldown: 0,
      })
      const sid = 'sess-cooldown'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(2)
    })
  })

  describe('session lifecycle', () => {
    it('cleans up on session.deleted — no further checks', async () => {
      const { client, hooks } = await createPlugin({ threshold: 5_000 })
      const sid = 'sess-del'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitEvent(hooks, 'session.deleted', { info: { id: sid } })

      await vi.advanceTimersByTimeAsync(30_000)
      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('resets state on session.error — stops monitoring', async () => {
      const { client, hooks } = await createPlugin({ threshold: 5_000 })
      const sid = 'sess-err'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(3_000)
      await emitEvent(hooks, 'session.error', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(30_000)
      expect(client.session.abort).not.toHaveBeenCalled()
    })
  })
})
