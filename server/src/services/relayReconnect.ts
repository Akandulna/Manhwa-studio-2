/** Each failed handshake consumes a backoff step; only this session's stable open resets it. */
export class RelayReconnect {
  private attempt = 0
  private opened: number | null = null
  private authenticationBlocked = false
  constructor(private now = Date.now, private random = Math.random) {}
  begin(): void { this.opened = null }
  open(): void { this.opened = this.now() }
  blockAuthentication(): void { this.authenticationBlocked = true }
  reset(): void { this.attempt = 0; this.opened = null; this.authenticationBlocked = false }
  next(): number | null {
    if (this.authenticationBlocked) return null
    if (this.opened !== null && this.now() - this.opened >= 60_000) this.attempt = 0
    this.opened = null
    const ceiling = [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(this.attempt++, 4)]
    return Math.ceil(ceiling * (0.75 + 0.25 * this.random()))
  }
}
