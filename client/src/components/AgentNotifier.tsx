import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useSocket } from '@/lib/socket'
import { useToast } from '@/components/ui/use-toast'

/** A toast when the agent speaks up by itself (a script run it started ended or hit a problem), unless its chat is open. */
export function AgentNotifier() {
  const { socket } = useSocket()
  const { toast } = useToast()
  const { pathname } = useLocation()
  useEffect(() => {
    if (!socket || pathname.startsWith('/agent')) return
    const onMessage = (event: { text?: string }) => toast({ title: 'Agent', description: (event.text ?? '').slice(0, 220) })
    socket.on('agent:message', onMessage)
    return () => { socket.off('agent:message', onMessage) }
  }, [socket, toast, pathname])
  return null
}
