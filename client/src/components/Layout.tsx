import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useSocket } from '@/lib/socket'
import { usePhoneRelay } from '@/hooks/usePhoneRelay'
import ManagerNotifications from '@/components/ManagerNotifications'
import {
  Library,
  Download,
  Settings,
  Plus,
  Mic,
  Target,
  FileJson,
  Clapperboard,
  Youtube,
  Wifi,
  WifiOff,
  PanelLeftClose,
  PanelLeftOpen,
  Smartphone,
  Layers,
  Users,
  Activity,
  Orbit
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'

interface LayoutProps {
  children: React.ReactNode
}

interface NavItem {
  icon: React.ReactNode
  label: string
  href: string
  badge?: number
  /** Small second line under the label. */
  hint?: string
  /** Shown but not clickable (e.g. coming soon). */
  disabled?: boolean
  /** A status dot on the icon (a bg-* class). */
  dot?: string
  dotTitle?: string
}

const SIDEBAR_STORAGE_KEY = 'sidebarCollapsed'

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const { isConnected, queueStatus } = useSocket()
  const relay = usePhoneRelay()

  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  )

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next))
      return next
    })
  }

  const activeDownloads = queueStatus.pending + queueStatus.active

  // Library & Downloader module items
  const libraryModuleItems: NavItem[] = [
    {
      icon: <Plus className="h-5 w-5" />,
      label: 'Add Series',
      href: '/add'
    },
    {
      icon: <Library className="h-5 w-5" />,
      label: 'Library',
      href: '/'
    },
    {
      icon: <Download className="h-5 w-5" />,
      label: 'Downloads',
      href: '/queue',
      badge: activeDownloads > 0 ? activeDownloads : undefined
    },
    {
      icon: <Layers className="h-5 w-5" />,
      label: 'Page Stitcher',
      href: '/stitch'
    }
  ]

  // Narration Studio module items
  const narrationModuleItems: NavItem[] = [
    {
      icon: <Mic className="h-5 w-5" />,
      label: 'Narration Library',
      href: '/narration'
    }
  ]

  // Module 3: Image Clipper — two clippers (SleeperCell, AI Engines) plus Metadata
  const clipperModuleItems: NavItem[] = [
    {
      icon: <Target className="h-5 w-5" />,
      label: 'SleeperCell',
      hint: 'Image Clipper 3.0',
      href: '/clipper3'
    },
    {
      icon: <Orbit className="h-5 w-5" />,
      label: 'AI Engines',
      href: '/antigravity'
    },
    {
      icon: <FileJson className="h-5 w-5" />,
      label: 'Metadata',
      href: '/metadata'
    }
  ]

  // Module 4: Video Editor items
  const editorModuleItems: NavItem[] = [
    {
      icon: <Clapperboard className="h-5 w-5" />,
      label: 'Editor 2.0',
      href: '/editor2'
    }
  ]

  // Sleeper Cells: the phone app, its accounts, and what it's doing. The dot is live only with the phone relay.
  const sleeperModuleItems: NavItem[] = [
    {
      icon: <Smartphone className="h-5 w-5" />,
      label: 'Phone Status',
      href: '/sleeper-cells',
      ...(relay?.configured && {
        dot: !relay.connected ? 'bg-amber-500' : relay.phones > 0 ? 'bg-emerald-500' : 'bg-muted-foreground/60',
        dotTitle: !relay.connected ? 'Relay offline' : relay.phones > 0 ? 'Sleeper-Cell is open' : 'Sleeper-Cell is closed'
      })
    },
    {
      icon: <Users className="h-5 w-5" />,
      label: 'Accounts',
      href: '/sleeper-cells/accounts'
    },
    {
      icon: <Activity className="h-5 w-5" />,
      label: 'Live Progress',
      href: '/sleeper-cells/live'
    },
    {
      icon: <Activity className="h-5 w-5" />,
      label: 'Production Issues',
      href: '/sleeper-cells/issues'
    }
  ]

  // Check if current path is in narration module
  const isInNarration = location.pathname.startsWith('/narration')
  const isInEditor2 = location.pathname.startsWith('/editor2')

  // Renders a single nav link, collapsing to an icon-only button when needed.
  const renderNavLink = (item: NavItem, active: boolean) => {
    const title = collapsed ? [item.label, item.hint, item.dotTitle].filter(Boolean).join(' · ') : item.dotTitle
    const className = cn(
      "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors",
      collapsed && "justify-center px-0",
      item.disabled
        ? "text-muted-foreground opacity-60 cursor-not-allowed"
        : active
          ? "bg-primary text-primary-foreground"
          : "hover:bg-accent text-foreground"
    )
    const body = (
      <>
      <span className="relative flex-shrink-0">
        {item.icon}
        {item.dot && (
          <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card", item.dot)} />
        )}
        {/* Collapsed: surface the badge as a small dot on the icon */}
        {collapsed && item.badge && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
            {item.badge}
          </span>
        )}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 min-w-0">
            <span className="block truncate">{item.label}</span>
            {item.hint && <span className="block truncate text-xs opacity-70">{item.hint}</span>}
          </span>
          {item.badge && (
            <Badge variant="secondary" className="ml-auto">
              {item.badge}
            </Badge>
          )}
        </>
      )}
      </>
    )
    if (item.disabled) {
      return (
        <div key={item.href} title={title} aria-disabled="true" className={className}>
          {body}
        </div>
      )
    }
    return (
      <Link key={item.href} to={item.href} title={title} className={className}>
        {body}
      </Link>
    )
  }

  const renderSectionLabel = (label: string) =>
    !collapsed && (
      <p className="text-xs font-medium text-muted-foreground mb-3 px-3">
        {label}
      </p>
    )

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "border-r bg-card flex flex-col transition-all duration-200",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {/* Logo + Collapse toggle */}
        <div
          className={cn(
            "flex items-center p-4",
            collapsed ? "justify-center" : "justify-between px-6"
          )}
        >
          {!collapsed && (
            <h1 className="text-2xl font-bold text-primary truncate">Manhwa Studio</h1>
          )}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-5 w-5" />
            ) : (
              <PanelLeftClose className="h-5 w-5" />
            )}
          </button>
        </div>

        <Separator />

        {/* Modules Navigation */}
        <ScrollArea className="flex-1">
          {/* Library & Downloader */}
          <div className="p-4">
            {renderSectionLabel('LIBRARY & DOWNLOADER')}
            <nav className="space-y-2">
              {libraryModuleItems.map((item) =>
                renderNavLink(
                  item,
                  (location.pathname === item.href ||
                    (item.href === '/stitch' && location.pathname.startsWith('/stitch/'))) &&
                    !isInNarration
                )
              )}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Narration Studio */}
          <div className="px-4 pb-4">
            {renderSectionLabel('NARRATION STUDIO')}
            <nav className="space-y-2">
              {narrationModuleItems.map((item) => renderNavLink(item, isInNarration))}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Image Clipper */}
          <div className="px-4 pb-4">
            {renderSectionLabel('IMAGE CLIPPER')}
            <nav className="space-y-2">
              {clipperModuleItems.map((item) => renderNavLink(item, location.pathname === item.href || location.pathname.startsWith(`${item.href}/`)))}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Video Editor */}
          <div className="px-4 pb-4">
            {renderSectionLabel('VIDEO EDITOR')}
            <nav className="space-y-2">
              {editorModuleItems.map((item) => renderNavLink(item, isInEditor2))}
            </nav>
          </div>

          <Separator className="my-2" />

          <div className="px-4 pb-4">
            {renderSectionLabel('YOUTUBE')}
            <nav className="space-y-2">
              {renderNavLink({ icon: <Youtube className="h-5 w-5" />, label: 'YouTube', href: '/youtube' }, location.pathname.startsWith('/youtube'))}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Sleeper Cells */}
          <div className="px-4 pb-4">
            {renderSectionLabel('SLEEPER CELLS')}
            <nav className="space-y-2">
              {sleeperModuleItems.map((item) => renderNavLink(item, location.pathname === item.href))}
            </nav>
          </div>
        </ScrollArea>

        {/* Bottom Section: Settings & Connection Status */}
        <div className="border-t">
          {/* Universal Settings */}
          <Link
            to="/settings"
            title={collapsed ? 'Settings' : undefined}
            className={cn(
              "flex items-center gap-3 py-3 transition-colors",
              collapsed ? "justify-center px-0" : "px-7",
              location.pathname === '/settings'
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent text-foreground"
            )}
          >
            <Settings className="h-5 w-5" />
            {!collapsed && <span>Settings</span>}
          </Link>

          {/* Connection Status */}
          <div
            className={cn(
              "py-3 border-t",
              collapsed ? "flex justify-center px-0" : "px-7"
            )}
            title={collapsed ? (isConnected ? 'Connected' : 'Disconnected') : undefined}
          >
            <div className="flex items-center gap-2 text-sm">
              {isConnected ? (
                <>
                  <Wifi className="h-4 w-4 text-green-500" />
                  {!collapsed && <span className="text-muted-foreground">Connected</span>}
                </>
              ) : (
                <>
                  <WifiOff className="h-4 w-4 text-destructive" />
                  {!collapsed && <span className="text-destructive">Disconnected</span>}
                </>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <ManagerNotifications />
        <div className="h-full">
          {children}
        </div>
      </main>
    </div>
  )
}
