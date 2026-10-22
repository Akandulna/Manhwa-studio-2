import { Link } from 'react-router-dom'
import { useManagers } from '@/hooks/useManagers'

export default function ManagerNotifications() {
  const { data, error } = useManagers()
  const unavailable = error || data?.error || (data?.enabled && data.managers.some(m => m.id === 'issues' && m.state !== 'reporting'))
  if (unavailable) {
    return (
      <div role="alert" className="border-b bg-amber-500/10 px-6 py-2 text-sm">
        Production reporting is unavailable or last known. <Link className="underline" to="/sleeper-cells/issues">Open reporting status</Link>.
      </div>
    )
  }
  const incidents = data?.incidents.filter(i =>
    !i.acknowledgedAt && i.state !== 'resolved' && (i.state === 'action_required' || i.severity === 'blocking')
  ) ?? []
  if (!incidents.length) return null
  return (
    <div role="status" className="border-b bg-amber-500/10 px-6 py-2 text-sm">
      <Link className="underline" to="/sleeper-cells/issues">{incidents.length} production issue{incidents.length === 1 ? '' : 's'} need attention</Link>.
      Independent work can continue where its prerequisites are ready.
    </div>
  )
}
