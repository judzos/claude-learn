export type PlanRow = { title: string; status: 'current' | 'visited' | 'upcoming'; needs: string[] }

export type PlanView = { topic: string; summary: string; rows: PlanRow[] }

declare module 'claude-code' {
  interface PluginState {
    learn: { plan: PlanView | null }
  }
}
