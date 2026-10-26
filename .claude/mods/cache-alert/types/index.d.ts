// What the session's last turn left the person to do, or null when it left nothing:
// the question it ended on (the desktop app's wrap-up ask, an AskUserQuestion or a
// plan awaiting approval), or a task list it stopped partway through.
export type Waiting = { reason: string } | null

declare module 'claude-code' {
  interface PluginState {
    'cache-alert': {
      lastResponseAt: number | null
      waiting: Waiting
      // The lastResponseAt an alert was already sent for, so a reload doesn't repeat it
      alertedFor: number | null
    }
  }
}
