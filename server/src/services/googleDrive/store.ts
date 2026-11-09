/**
 * Persistence for the Drive connection (PRD §15): the imported OAuth client,
 * authorized accounts and Studio-owned folder mappings. A Prisma-backed store
 * for the app and an in-memory one for tests share one interface.
 */

import type { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'

export type ConnectionStatus = 'connected' | 'reconnect_required' | 'disconnected' | 'error'
export type FolderKind = 'root' | 'series' | 'chapters' | 'chapter' | 'page'

export interface DriveClientRecord {
  clientId: string
  projectId: string | null
  secretRef: string
  importedAt: Date
}

export interface DriveConnectionRecord {
  id: string
  clientId: string
  googleSubject: string
  email: string
  scopes: string
  secretRef: string
  active: boolean
  status: ConnectionStatus
  lastError: string | null
  lastTestJson: string | null
  connectedAt: Date
  updatedAt: Date
}

export interface FolderMappingRecord {
  id: string
  connectionId: string
  kind: FolderKind
  entityKey: string
  folderId: string | null
  intentId: string | null
  parentId: string | null
  name: string
  verifiedAt: Date | null
}

export type ConnectionPatch = Partial<Pick<DriveConnectionRecord, 'email' | 'scopes' | 'secretRef' | 'status' | 'lastError' | 'lastTestJson' | 'connectedAt'>>
export type MappingPatch = Partial<Pick<FolderMappingRecord, 'folderId' | 'intentId' | 'parentId' | 'name' | 'verifiedAt'>>

export interface DriveStore {
  getClient(): Promise<DriveClientRecord | null>
  saveClient(client: Omit<DriveClientRecord, 'importedAt'>): Promise<DriveClientRecord>
  getConnection(id: string): Promise<DriveConnectionRecord | null>
  activeConnection(): Promise<DriveConnectionRecord | null>
  listConnections(): Promise<DriveConnectionRecord[]>
  findConnection(clientId: string, googleSubject: string): Promise<DriveConnectionRecord | null>
  /** Create or update the row for this client + Google account. */
  upsertConnection(data: Pick<DriveConnectionRecord, 'clientId' | 'googleSubject' | 'email' | 'scopes' | 'secretRef' | 'status'>): Promise<DriveConnectionRecord>
  updateConnection(id: string, patch: ConnectionPatch): Promise<DriveConnectionRecord>
  /** Make one connection active and every other one inactive. `null` deactivates all. */
  setActive(id: string | null): Promise<void>
  getMapping(connectionId: string, kind: FolderKind, entityKey: string): Promise<FolderMappingRecord | null>
  upsertMapping(connectionId: string, kind: FolderKind, entityKey: string, patch: MappingPatch & { name: string }): Promise<FolderMappingRecord>
}

const CLIENT_ROW = 'default'

const asConnection = (row: Record<string, unknown>) => row as unknown as DriveConnectionRecord
const asMapping = (row: Record<string, unknown>) => row as unknown as FolderMappingRecord

export function prismaDriveStore(prisma: PrismaClient): DriveStore {
  return {
    async getClient() {
      return prisma.driveOAuthClient.findUnique({ where: { id: CLIENT_ROW } })
    },
    async saveClient(client) {
      const data = { clientId: client.clientId, projectId: client.projectId, secretRef: client.secretRef, importedAt: new Date() }
      return prisma.driveOAuthClient.upsert({ where: { id: CLIENT_ROW }, create: { id: CLIENT_ROW, ...data }, update: data })
    },
    async getConnection(id) {
      const row = await prisma.driveConnection.findUnique({ where: { id } })
      return row && asConnection(row)
    },
    async activeConnection() {
      const row = await prisma.driveConnection.findFirst({ where: { active: true }, orderBy: { updatedAt: 'desc' } })
      return row && asConnection(row)
    },
    async listConnections() {
      return (await prisma.driveConnection.findMany({ orderBy: { connectedAt: 'asc' } })).map(asConnection)
    },
    async findConnection(clientId, googleSubject) {
      const row = await prisma.driveConnection.findUnique({ where: { clientId_googleSubject: { clientId, googleSubject } } })
      return row && asConnection(row)
    },
    async upsertConnection(data) {
      const row = await prisma.driveConnection.upsert({
        where: { clientId_googleSubject: { clientId: data.clientId, googleSubject: data.googleSubject } },
        create: { ...data, lastError: null },
        update: { email: data.email, scopes: data.scopes, secretRef: data.secretRef, status: data.status, lastError: null, connectedAt: new Date() }
      })
      return asConnection(row)
    },
    async updateConnection(id, patch) {
      return asConnection(await prisma.driveConnection.update({ where: { id }, data: patch }))
    },
    async setActive(id) {
      await prisma.$transaction([
        prisma.driveConnection.updateMany({ where: { active: true, ...(id && { NOT: { id } }) }, data: { active: false } }),
        ...(id ? [prisma.driveConnection.update({ where: { id }, data: { active: true } })] : [])
      ])
    },
    async getMapping(connectionId, kind, entityKey) {
      const row = await prisma.driveFolderMapping.findUnique({ where: { connectionId_kind_entityKey: { connectionId, kind, entityKey } } })
      return row && asMapping(row)
    },
    async upsertMapping(connectionId, kind, entityKey, patch) {
      const row = await prisma.driveFolderMapping.upsert({
        where: { connectionId_kind_entityKey: { connectionId, kind, entityKey } },
        create: { connectionId, kind, entityKey, ...patch },
        update: patch
      })
      return asMapping(row)
    }
  }
}

export function memoryDriveStore(): DriveStore & { connections: Map<string, DriveConnectionRecord>; mappings: Map<string, FolderMappingRecord> } {
  let client: DriveClientRecord | null = null
  const connections = new Map<string, DriveConnectionRecord>()
  const mappings = new Map<string, FolderMappingRecord>()
  const mapKey = (c: string, k: string, e: string) => `${c}|${k}|${e}`
  const copy = <T>(v: T | null | undefined): T | null => (v ? { ...v } : null)
  return {
    connections,
    mappings,
    async getClient() { return copy(client) },
    async saveClient(c) { client = { ...c, importedAt: new Date() }; return { ...client } },
    async getConnection(id) { return copy(connections.get(id)) },
    async activeConnection() { return copy([...connections.values()].find(c => c.active)) },
    async listConnections() { return [...connections.values()].map(c => ({ ...c })) },
    async findConnection(clientId, sub) { return copy([...connections.values()].find(c => c.clientId === clientId && c.googleSubject === sub)) },
    async upsertConnection(data) {
      const existing = [...connections.values()].find(c => c.clientId === data.clientId && c.googleSubject === data.googleSubject)
      const now = new Date()
      const row: DriveConnectionRecord = existing
        ? { ...existing, ...data, lastError: null, connectedAt: now, updatedAt: now }
        : { id: crypto.randomUUID(), ...data, active: false, lastError: null, lastTestJson: null, connectedAt: now, updatedAt: now }
      connections.set(row.id, row)
      return { ...row }
    },
    async updateConnection(id, patch) {
      const row = connections.get(id)
      if (!row) throw new Error('connection not found')
      Object.assign(row, patch, { updatedAt: new Date() })
      return { ...row }
    },
    async setActive(id) {
      for (const c of connections.values()) c.active = c.id === id
    },
    async getMapping(c, k, e) { return copy(mappings.get(mapKey(c, k, e))) },
    async upsertMapping(connectionId, kind, entityKey, patch) {
      const key = mapKey(connectionId, kind, entityKey)
      const existing = mappings.get(key)
      const row: FolderMappingRecord = existing
        ? { ...existing, ...patch }
        : { id: crypto.randomUUID(), connectionId, kind, entityKey, folderId: null, intentId: null, parentId: null, verifiedAt: null, ...patch }
      mappings.set(key, row)
      return { ...row }
    }
  }
}
