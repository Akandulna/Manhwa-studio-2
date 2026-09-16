import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useSocket } from '@/lib/socket'
import { useTheme } from '@/lib/theme'
import {
  Library,
  Download,
  Settings,
  Plus,
  Mic,
  Scissors,
  Crosshair,
  Target,
  Film,
  Clapperboard,
  Music,
  SplitSquareHorizontal,
  FlaskConical,
  Droplet,
  Wifi,
  WifiOff,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Sun,
  HardDrive
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
  disabled?: boolean
}

const SIDEBAR_STORAGE_KEY = 'sidebarCollapsed'

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const { isConnected, queueStatus } = useSocket()
  const { resolvedTheme, toggleTheme } = useTheme()

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
      icon: <Library className="h-5 w-5" />,
      label: 'Library',
      href: '/'
    },
    {
      icon: <Plus className="h-5 w-5" />,
      label: 'Add Series',
      href: '/add'
    },
    {
      icon: <Download className="h-5 w-5" />,
      label: 'Downloads',
      href: '/queue',
      badge: activeDownloads > 0 ? activeDownloads : undefined
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

  // Module 3: Image Clipper items
  const clipperModuleItems: NavItem[] = [
    {
      icon: <Scissors className="h-5 w-5" />,
      label: 'Image Clipper',
      href: '/clipper'
    },
    {
      icon: <Crosshair className="h-5 w-5" />,
      label: 'Image Clipper 2.0',
      href: '/clipper2'
    },
    {
      icon: <Target className="h-5 w-5" />,
      label: 'Image Clipper 3.0',
      href: '/clipper3'
    },
    {
      icon: <Droplet className="h-5 w-5" />,
      label: 'Watermark Lab',
      href: '/clipper/watermark'
    },
    {
      icon: <FlaskConical className="h-5 w-5" />,
      label: 'AI Crop Lab',
      href: '/clipper/lab'
    }
  ]

  // Module 4: Video Editor items
  const editorModuleItems: NavItem[] = [
    {
      icon: <Film className="h-5 w-5" />,
      label: 'Editor',
      href: '/editor'
    },
    {
      icon: <Clapperboard className="h-5 w-5" />,
      label: 'Editor 2.0',
      href: '/editor2'
    },
    {
      icon: <Music className="h-5 w-5" />,
      label: 'Music',
      href: '/music'
    }
  ]

  // Future modules (disabled)
  const futureModules: NavItem[] = [
    {
      icon: <SplitSquareHorizontal className="h-5 w-5" />,
      label: 'Panel Splitter',
      href: '#',
      disabled: true
    }
  ]

  // Check if current path is in narration module
  const isInNarration = location.pathname.startsWith('/narration')
  // Check if current path is in clipper module.
  // '/clipper' is a PREFIX of '/clipper2', so a startsWith('/clipper') test also
  // matches every Image Clipper 2.0 route and would light up the v1 nav item there.
  // The v1 subtree is therefore matched exactly, and 2.0 gets its own test.
  const isInClipper = location.pathname === '/clipper' || location.pathname.startsWith('/clipper/')
  const isInClipper2 = location.pathname.startsWith('/clipper2')
  const isInClipper3 = location.pathname.startsWith('/clipper3')
  // Check if current path is in editor module.
  // '/editor' is a PREFIX of '/editor2', so a startsWith('/editor') test also
  // matches Editor 2.0 routes and would light up the v1 nav item there.
  // The v1 subtree is therefore matched exactly, and 2.0 gets its own test.
  const isInEditor = location.pathname === '/editor' || location.pathname.startsWith('/editor/')
  const isInEditor2 = location.pathname.startsWith('/editor2')
  const isInMusic = location.pathname.startsWith('/music')

  // Renders a single nav link, collapsing to an icon-only button when needed.
  const renderNavLink = (item: NavItem, active: boolean) => (
    <Link
      key={item.href}
      to={item.href}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "bg-primary text-primary-foreground"
          : "hover:bg-accent text-foreground"
      )}
    >
      <span className="relative flex-shrink-0">
        {item.icon}
        {/* Collapsed: surface the badge as a small dot on the icon */}
        {collapsed && item.badge && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
            {item.badge}
          </span>
        )}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1">{item.label}</span>
          {item.badge && (
            <Badge variant="secondary" className="ml-auto">
              {item.badge}
            </Badge>
          )}
        </>
      )}
    </Link>
  )

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
          {/* Module 1: Library & Downloader */}
          <div className="p-4">
            {renderSectionLabel('LIBRARY & DOWNLOADER')}
            <nav className="space-y-2">
              {libraryModuleItems.map((item) =>
                renderNavLink(
                  item,
                  location.pathname === item.href && !isInNarration
                )
              )}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Module 2: Narration Studio */}
          <div className="px-4 pb-4">
            {renderSectionLabel('NARRATION STUDIO')}
            <nav className="space-y-2">
              {narrationModuleItems.map((item) => renderNavLink(item, isInNarration))}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Module 3: Image Clipper */}
          <div className="px-4 pb-4">
            {renderSectionLabel('IMAGE CLIPPER')}
            <nav className="space-y-2">
              {clipperModuleItems.map((item) => {
                const onLab = location.pathname.startsWith('/clipper/lab')
                const onWatermark = location.pathname.startsWith('/clipper/watermark')
                let active: boolean
                if (item.href === '/clipper/lab') active = onLab
                else if (item.href === '/clipper/watermark') active = onWatermark
                else if (item.href === '/clipper2') active = isInClipper2
                else if (item.href === '/clipper3') active = isInClipper3
                // isInClipper excludes the '/clipper2' and '/clipper3' subtrees, so the
                // v1 item cannot be lit by a 2.0 or 3.0 route.
                else active = isInClipper && !onLab && !onWatermark
                return renderNavLink(item, active)
              })}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Module 4: Video Editor */}
          <div className="px-4 pb-4">
            {renderSectionLabel('VIDEO EDITOR')}
            <nav className="space-y-2">
              {editorModuleItems.map((item) => {
                let active: boolean
                if (item.href === '/music') active = isInMusic
                else if (item.href === '/editor2') active = isInEditor2
                else active = isInEditor
                return renderNavLink(item, active)
              })}
            </nav>
          </div>

          <Separator className="my-2" />

          {/* Future Modules */}
          <div className="px-4 pb-4">
            {renderSectionLabel('COMING SOON')}
            <nav className="space-y-2">
              {futureModules.map((item) => (
                <div
                  key={item.label}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg",
                    collapsed && "justify-center px-0",
                    "text-muted-foreground cursor-not-allowed opacity-50"
                  )}
                >
                  {item.icon}
                  {!collapsed && <span>{item.label}</span>}
                </div>
              ))}
            </nav>
          </div>
        </ScrollArea>

        {/* Bottom Section: Settings & Connection Status */}
        <div className="border-t">
          {/* Theme quick-toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            title={collapsed
              ? `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`
              : undefined}
            aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            className={cn(
              "flex w-full items-center gap-3 py-3 transition-colors hover:bg-accent text-foreground",
              collapsed ? "justify-center px-0" : "px-7"
            )}
          >
            {resolvedTheme === 'dark'
              ? <Sun className="h-5 w-5 shrink-0" />
              : <Moon className="h-5 w-5 shrink-0" />}
            {!collapsed && (
              <span>{resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            )}
          </button>

          {/* Storage — housekeeping across every module, so it lives with Settings */}
          <Link
            to="/storage"
            title={collapsed ? 'Storage' : undefined}
            className={cn(
              "flex items-center gap-3 py-3 transition-colors",
              collapsed ? "justify-center px-0" : "px-7",
              location.pathname === '/storage'
                ? "bg-primary text-primary-foreground"
                : "hover:bg-accent text-foreground"
            )}
          >
            <HardDrive className="h-5 w-5" />
            {!collapsed && <span>Storage</span>}
          </Link>

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
        <div className="h-full">
          {children}
        </div>
      </main>
    </div>
  )
}
