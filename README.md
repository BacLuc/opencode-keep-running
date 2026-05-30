# opencode-keep-running

An [OpenCode](https://opencode.ai) plugin that detects when the AI agent is stuck and automatically sends a "continue" prompt to keep the session running.

## How It Works

1. **Tracks activity** — Monitors `session.status`, `message.part.updated`, `message.updated`, and `tool.execute.after` events
2. **Detects stuck sessions** — When a session is busy but no activity is detected within the threshold, it's considered stuck
3. **Auto-continues** — Aborts the stuck run and sends a configurable message to prompt the agent to keep going
4. **Re-schedules monitoring** — After a continue is sent, monitoring resumes so subsequent stucks are also detected (up to `maxContinues`)

## Installation

```bash
opencode plugin bacluc-opencode-keep-running
```

Or add to your `opencode.json`:

```json
{
  "plugin": ["bacluc-opencode-keep-running@<version>"]
}
```

## Configuration

```json
{
  "plugin": [
    [
      "opencode-keep-running",
      {
        "threshold": 120000,
        "message": "continue",
        "abortBeforeContinue": true,
        "abortCooldown": 3000,
        "maxContinues": 5,
        "continueCooldown": 30000,
        "debug": false
      }
    ]
  ]
}
```

| Option                | Type      | Default          | Description                                                   |
| --------------------- | --------- | ---------------- | ------------------------------------------------------------- |
| `threshold`           | `number`  | `120000` (2 min) | Inactivity threshold in ms before considering the agent stuck |
| `message`             | `string`  | `"continue"`     | Message to send when the agent is stuck                       |
| `abortBeforeContinue` | `boolean` | `true`           | Whether to abort the current run before sending continue      |
| `abortCooldown`       | `number`  | `3000` (3s)      | Delay in ms after aborting before sending continue            |
| `maxContinues`        | `number`  | `5`              | Maximum continue attempts per session                         |
| `continueCooldown`    | `number`  | `30000` (30s)    | Cooldown in ms between continues                              |
| `debug`               | `boolean` | `false`          | Enable debug logging via opencode app.log                     |

## Behavior Details

- **Continue count** is tracked per session and resets only when a new session is created. Going idle does not reset the count — if the agent gets stuck 5 times in the same session, it stops trying.
- **Activity events** reset the inactivity timer, meaning any tool call, message part, or status change (including retry) keeps the session from being considered stuck.
- **Re-scheduling**: After a continue is sent, monitoring resumes automatically. If the agent gets stuck again, another continue is sent (subject to `maxContinues` and `continueCooldown`).

## Development

```bash
npm install
npm test
```
