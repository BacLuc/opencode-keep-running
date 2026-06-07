import type { Plugin, PluginOptions } from '@opencode-ai/plugin'
import type { Event } from '@opencode-ai/sdk'

export const DEFAULTS = {
  threshold: 120_000,
  message: 'continue',
  abortBeforeContinue: true,
  abortCooldown: 3000,
  maxContinues: 5,
  continueCooldown: 30_000,
  debug: false,
} as const

export interface KeepRunningConfig {
  threshold?: number
  message?: string
  abortBeforeContinue?: boolean
  abortCooldown?: number
  maxContinues?: number
  continueCooldown?: number
  debug?: boolean
}

interface SessionState {
  isActive: boolean
  lastActivityAt: number
  scheduledCheck: ReturnType<typeof setTimeout> | null
  continuesSent: number
  lastContinueAt: number
  isResolvingStuck: boolean
  pendingTools: number
  pendingCommands: number
  runningTools: Set<string>
}

interface ResolvedConfig {
  threshold: number
  message: string
  abortBeforeContinue: boolean
  abortCooldown: number
  maxContinues: number
  continueCooldown: number
  debug: boolean
}

export function resolveConfig(raw: PluginOptions | undefined): ResolvedConfig {
  return {
    threshold: (raw?.threshold as number) ?? DEFAULTS.threshold,
    message: (raw?.message as string) ?? DEFAULTS.message,
    abortBeforeContinue: (raw?.abortBeforeContinue as boolean) ?? DEFAULTS.abortBeforeContinue,
    abortCooldown: (raw?.abortCooldown as number) ?? DEFAULTS.abortCooldown,
    maxContinues: (raw?.maxContinues as number) ?? DEFAULTS.maxContinues,
    continueCooldown: (raw?.continueCooldown as number) ?? DEFAULTS.continueCooldown,
    debug: (raw?.debug as boolean) ?? DEFAULTS.debug,
  }
}

export function createSessionState(): SessionState {
  return {
    isActive: false,
    lastActivityAt: Date.now(),
    scheduledCheck: null,
    continuesSent: 0,
    lastContinueAt: 0,
    isResolvingStuck: false,
    pendingTools: 0,
    pendingCommands: 0,
    runningTools: new Set<string>(),
  }
}

export function findSessionIdInEvent(event: Event): string | undefined {
  const props = event.properties as Record<string, unknown>

  if (typeof props.sessionID === 'string') return props.sessionID

  if (props.info && typeof props.info === 'object') {
    const info = props.info as Record<string, unknown>
    if (typeof info.sessionID === 'string') return info.sessionID
    if (typeof info.id === 'string') return info.id
  }

  if (props.part && typeof props.part === 'object') {
    const part = props.part as Record<string, unknown>
    if (typeof part.sessionID === 'string') return part.sessionID
  }

  return undefined
}

export const KeepRunningPlugin: Plugin = async (ctx, rawOptions) => {
  const config = resolveConfig(rawOptions)
  const client = ctx.client

  const log = (msg: string) => {
    if (!config.debug) return
    client.app.log({
      body: { service: 'keep-running', level: 'info', message: msg },
    })
  }

  log(`initialized threshold=${config.threshold}ms message="${config.message}"`)

  const sessions = new Map<string, SessionState>()

  function getOrCreate(sessionId: string): SessionState {
    let state = sessions.get(sessionId)
    if (!state) {
      state = createSessionState()
      sessions.set(sessionId, state)
    }
    return state
  }

  function cancelScheduledCheck(state: SessionState) {
    if (state.scheduledCheck !== null) {
      clearTimeout(state.scheduledCheck)
      state.scheduledCheck = null
    }
  }

  function recordActivity(sessionId: string) {
    const state = getOrCreate(sessionId)
    state.lastActivityAt = Date.now()
    if (state.isActive) {
      scheduleCheck(sessionId)
    }
  }

  function scheduleCheck(sessionId: string) {
    const state = getOrCreate(sessionId)
    cancelScheduledCheck(state)

    if (!state.isActive || state.isResolvingStuck) return

    if (state.continuesSent >= config.maxContinues) {
      log(`${sessionId}: max continues reached, skipping check`)
      return
    }

    const sinceLastContinue = Date.now() - state.lastContinueAt
    if (state.lastContinueAt > 0 && sinceLastContinue < config.continueCooldown) {
      const remaining = config.continueCooldown - sinceLastContinue
      log(`${sessionId}: in cooldown, retrying in ${remaining}ms`)
      state.scheduledCheck = setTimeout(() => {
        state.scheduledCheck = null
        scheduleCheck(sessionId)
      }, remaining)
      return
    }

    const sinceLastActivity = Date.now() - state.lastActivityAt
    const delay = Math.max(0, config.threshold - sinceLastActivity)

    log(`${sessionId}: check scheduled in ${delay}ms`)

    state.scheduledCheck = setTimeout(async () => {
      state.scheduledCheck = null
      await attemptContinue(sessionId)
    }, delay)
  }

  async function attemptContinue(sessionId: string) {
    const state = getOrCreate(sessionId)

    if (!state.isActive || state.isResolvingStuck) return

    if (state.continuesSent >= config.maxContinues) {
      log(`${sessionId}: max continues reached, giving up`)
      return
    }

    if (state.pendingTools > 0 || state.pendingCommands > 0) {
      log(`${sessionId}: ${state.pendingTools} tool(s) and ${state.pendingCommands} command(s) pending, skipping abort`)
      state.lastActivityAt = Date.now()
      scheduleCheck(sessionId)
      return
    }

    if (state.runningTools.size > 0) {
      log(`${sessionId}: ${state.runningTools.size} tool(s) actively running, skipping abort`)
      state.lastActivityAt = Date.now()
      scheduleCheck(sessionId)
      return
    }

    const stuckFor = Date.now() - state.lastActivityAt
    if (stuckFor < config.threshold) {
      log(`${sessionId}: activity ${stuckFor}ms ago, rescheduling`)
      scheduleCheck(sessionId)
      return
    }

    state.isResolvingStuck = true
    state.continuesSent++
    state.lastContinueAt = Date.now()

    log(`${sessionId}: stuck for ${stuckFor}ms, continue #${state.continuesSent}/${config.maxContinues}`)

    try {
      if (config.abortBeforeContinue) {
        log(`${sessionId}: aborting`)
        try {
          await client.session.abort({ path: { id: sessionId } })
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, config.abortCooldown))
      }

      if (!state.isActive) return
      if (state.pendingTools > 0 || state.pendingCommands > 0) {
        log(
          `${sessionId}: ${state.pendingTools} tool(s) and ${state.pendingCommands} command(s) pending after abort, skipping prompt`,
        )
        state.isResolvingStuck = false
        state.lastActivityAt = Date.now()
        scheduleCheck(sessionId)
        return
      }
      const stuckForAfterAbort = Date.now() - state.lastActivityAt
      if (stuckForAfterAbort < config.threshold) {
        log(`${sessionId}: activity ${stuckForAfterAbort}ms ago after abort, skipping prompt`)
        state.isResolvingStuck = false
        state.lastActivityAt = Date.now()
        scheduleCheck(sessionId)
        return
      }

      log(`${sessionId}: sending "${config.message}"`)
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: 'text' as const, text: config.message }] },
        })
      } catch {}
    } finally {
      state.isResolvingStuck = false
      state.lastActivityAt = Date.now()
      if (state.isActive) {
        scheduleCheck(sessionId)
      }
    }
  }

  function markIdle(sessionId: string) {
    const state = getOrCreate(sessionId)
    state.isActive = false
    state.pendingTools = 0
    state.pendingCommands = 0
    state.runningTools.clear()
    cancelScheduledCheck(state)
  }

  return {
    async event({ event }) {
      switch (event.type) {
        case 'session.status': {
          const { sessionID, status } = event.properties as {
            sessionID?: string
            status?: { type?: string; attempt?: number; message?: string }
          }
          if (!sessionID || !status) break
          const state = getOrCreate(sessionID)

          if (status.type === 'busy') {
            log(`${sessionID}: busy`)
            state.isActive = true
            state.lastActivityAt = Date.now()
            scheduleCheck(sessionID)
          } else if (status.type === 'idle') {
            log(`${sessionID}: idle`)
            markIdle(sessionID)
          } else if (status.type === 'retry') {
            state.lastActivityAt = Date.now()
          }
          break
        }

        case 'session.idle': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (sessionID) markIdle(sessionID)
          break
        }

        case 'message.part.updated':
        case 'message.updated': {
          const sessionId = findSessionIdInEvent(event)
          if (sessionId) recordActivity(sessionId)
          break
        }

        case 'session.error': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (!sessionID) break
          const state = getOrCreate(sessionID)
          cancelScheduledCheck(state)
          state.isActive = false
          state.isResolvingStuck = false
          state.pendingTools = 0
          state.pendingCommands = 0
          state.runningTools.clear()
          break
        }

        case 'session.created': {
          const sessionId = findSessionIdInEvent(event)
          if (sessionId) {
            const old = sessions.get(sessionId)
            if (old) {
              cancelScheduledCheck(old)
              old.runningTools.clear()
            }
            sessions.delete(sessionId)
          }
          break
        }

        case 'session.deleted': {
          const sessionId = findSessionIdInEvent(event)
          if (sessionId) {
            const state = sessions.get(sessionId)
            if (state) {
              cancelScheduledCheck(state)
              state.runningTools.clear()
            }
            sessions.delete(sessionId)
          }
          break
        }

        case 'command.executed': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (sessionID) {
            const state = getOrCreate(sessionID)
            state.pendingCommands = Math.max(0, state.pendingCommands - 1)
            recordActivity(sessionID)
          }
          break
        }

        case 'permission.updated': {
          const props = event.properties as { sessionID?: string }
          if (props.sessionID) recordActivity(props.sessionID)
          break
        }

        case 'permission.replied': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (sessionID) recordActivity(sessionID)
          break
        }

        case 'message.part.removed': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (sessionID) recordActivity(sessionID)
          break
        }

        case 'session.compacted': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (sessionID) recordActivity(sessionID)
          break
        }

        case 'todo.updated': {
          const { sessionID } = event.properties as { sessionID?: string }
          if (sessionID) recordActivity(sessionID)
          break
        }
      }
    },

    async 'tool.execute.before'(input, _output) {
      if (input.sessionID) {
        const state = getOrCreate(input.sessionID)
        state.pendingTools++
        if (input.callID) {
          state.runningTools.add(input.callID)
        }
        recordActivity(input.sessionID)
      }
    },

    async 'command.execute.before'(input, _output) {
      if (input.sessionID) {
        const state = getOrCreate(input.sessionID)
        state.pendingCommands++
        recordActivity(input.sessionID)
      }
    },

    async 'permission.ask'(input, _output) {
      if (input.sessionID) recordActivity(input.sessionID)
    },

    async 'tool.execute.after'(input, _output) {
      if (input.sessionID) {
        const state = getOrCreate(input.sessionID)
        state.pendingTools = Math.max(0, state.pendingTools - 1)
        if (input.callID) {
          state.runningTools.delete(input.callID)
        }
        recordActivity(input.sessionID)
      }
    },
  }
}

export default KeepRunningPlugin
