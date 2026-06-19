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
    experimental_workspace: { register: vi.fn() } as any,
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

async function emitToolAfter(hooks: Hooks, sessionId: string, callId: string = 'c1') {
  await hooks['tool.execute.after']!(
    { tool: 'bash', sessionID: sessionId, callID: callId, args: {} } as any,
    { title: '', output: '', metadata: {} } as any,
  )
}

async function emitToolBefore(hooks: Hooks, sessionId: string, callId: string = 'c1') {
  const output = { args: {} }
  await hooks['tool.execute.before']!({ tool: 'bash', sessionID: sessionId, callID: callId } as any, output as any)
}

async function emitCommandBefore(hooks: Hooks, sessionId: string) {
  const output = { parts: [] }
  await hooks['command.execute.before']!(
    { command: 'sleep', sessionID: sessionId, arguments: '10' } as any,
    output as any,
  )
}

async function emitPermissionAsk(hooks: Hooks, sessionId: string) {
  const output = { status: 'ask' as const }
  await hooks['permission.ask']!(
    {
      id: 'perm-1',
      type: 'file',
      sessionID: sessionId,
      messageID: 'msg-1',
      title: 'Test permission',
      metadata: {},
      time: { created: Date.now() },
    } as any,
    output,
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

    it('does not send prompt if tool starts during abort cooldown', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 1_000,
      })
      const sid = 'sess-tool-race'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      // Now in abort cooldown
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      // Tool starts during abort cooldown
      await emitToolBefore(hooks, sid)

      await vi.advanceTimersByTimeAsync(1_000)

      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it('does not send prompt if activity arrives during abort cooldown', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 1_000,
      })
      const sid = 'sess-activity-race'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      expect(client.session.abort).toHaveBeenCalledTimes(1)

      // Activity arrives during abort cooldown
      await emitEvent(hooks, 'message.part.updated', { part: { sessionID: sid, type: 'text' } })

      await vi.advanceTimersByTimeAsync(1_000)

      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it('tool running prevents abort even past threshold', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
      })
      const sid = 'sess-tool-past-threshold'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await emitToolAfter(hooks, sid)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
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

  describe('in-flight operation tracking', () => {
    it('prevents abort while a tool is running (tool.execute.before)', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-tool-flight'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('prevents abort while a command is running (command.execute.before)', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-cmd-flight'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitCommandBefore(hooks, sid)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('prevents abort when both tools and commands are pending', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-both-flight'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)
      await emitCommandBefore(hooks, sid)

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('does NOT abort while a tool is running even past threshold', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-tool-running'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid, 'call-1')

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).not.toHaveBeenCalled()
    })

    it('aborts after tool finishes and inactivity exceeds threshold again', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-tool-finishes'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid, 'call-2')

      // Tool runs past threshold
      await vi.advanceTimersByTimeAsync(6_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      // Tool finishes — this records activity and reschedules the check
      await emitToolAfter(hooks, sid, 'call-2')
      expect(client.session.abort).not.toHaveBeenCalled()

      // Now let the new threshold pass without further activity
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('does NOT send prompt if tool finishes during abortCooldown', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 2_000,
        continueCooldown: 0,
      })
      const sid = 'sess-race-abort'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      // Pass the threshold — abort is called, abortCooldown starts
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).toHaveBeenCalledTimes(1)
      expect(client.session.prompt).not.toHaveBeenCalled()

      // During the cooldown, a tool finishes (records activity)
      await emitToolAfter(hooks, sid)

      // Finish the cooldown
      await vi.advanceTimersByTimeAsync(2_000)

      // Because activity occurred during cooldown, prompt should NOT have been sent
      expect(client.session.prompt).not.toHaveBeenCalled()
    })
  })

  describe('new activity events', () => {
    it('tracks activity from command.executed events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-cmd-exec'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'command.executed', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from permission.updated events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-perm-upd'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'permission.updated', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from permission.replied events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-perm-replied'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'permission.replied', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from message.part.removed events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-part-rem'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'message.part.removed', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from session.compacted events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-compacted'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'session.compacted', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from todo.updated events', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-todo'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitEvent(hooks, 'todo.updated', { sessionID: sid })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('tracks activity from permission.ask hook', async () => {
      const { client, hooks } = await createPlugin({ threshold: 10_000, abortCooldown: 0 })
      const sid = 'sess-perm-ask'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await vi.advanceTimersByTimeAsync(8_000)

      await emitPermissionAsk(hooks, sid)

      await vi.advanceTimersByTimeAsync(8_000)
      expect(client.session.abort).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })
  })

  describe('pending counter lifecycle reset', () => {
    it('resets pending tool counter on session.error', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-err-reset'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)
      await emitEvent(hooks, 'session.error', { sessionID: sid })

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('resets pending counters when session goes idle', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-idle-reset'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)
      await emitCommandBefore(hooks, sid)
      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'idle' } })

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('resets pending counters on session.created', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-created-reset'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)
      await emitCommandBefore(hooks, sid)
      await emitEvent(hooks, 'session.created', { info: { id: sid } })

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(1)

      expect(client.session.abort).toHaveBeenCalledTimes(1)
    })

    it('does not abort after session.deleted even with pending operations', async () => {
      const { client, hooks } = await createPlugin({
        threshold: 5_000,
        abortCooldown: 0,
        continueCooldown: 0,
      })
      const sid = 'sess-del-pending'

      await emitEvent(hooks, 'session.status', { sessionID: sid, status: { type: 'busy' } })
      await emitToolBefore(hooks, sid)
      await emitEvent(hooks, 'session.deleted', { info: { id: sid } })

      await vi.advanceTimersByTimeAsync(30_000)

      expect(client.session.abort).not.toHaveBeenCalled()
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
