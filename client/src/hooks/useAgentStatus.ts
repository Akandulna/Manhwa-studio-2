import { useCallback, useEffect, useState } from 'react'
import { agentApi, type AgentStatus } from '@/lib/api'

const CHANGED = 'studio-agent-changed'

/** Tell every mounted useAgentStatus (sidebar switch, Settings, chat page) to re-read. */
export const notifyAgentChanged = () => window.dispatchEvent(new Event(CHANGED))

export function useAgentStatus() {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const refresh = useCallback(async (fresh = false) => {
    try { setStatus(await agentApi.status(fresh)) } catch { /* server not reachable: keep the last answer */ }
  }, [])
  useEffect(() => {
    void refresh()
    const on = () => void refresh()
    window.addEventListener(CHANGED, on)
    return () => window.removeEventListener(CHANGED, on)
  }, [refresh])
  const setEnabled = useCallback(async (enabled: boolean) => {
    await agentApi.saveSettings({ enabled })
    notifyAgentChanged()
  }, [])
  return { status, refresh, setEnabled }
}
