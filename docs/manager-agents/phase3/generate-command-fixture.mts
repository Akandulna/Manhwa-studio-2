import { writeFileSync } from 'node:fs'
import { cropTaskIdentity } from '../../../server/src/services/managedTaskProtocol.ts'
const identity={workspaceId:'fixture-workspace',seriesId:'fixture-series',chapterId:'fixture-chapter',pageId:'fixture-page'}
const spec={version:'crop-page/1' as const,provider:'chatgpt' as const,product:'chatgpt-web',model:'owner-selected-model-🧪',settings:{mode:'Chat',effort:null},pageRevision:'page-r1',promptVersion:'prompt-1',validatorVersion:'crop-validator-1',dependencies:[{id:'fixture-page',revision:'page-r1',sha256:'a'.repeat(64)}]}
const computed=await cropTaskIdentity(identity,spec)
const fixture={task:{...identity,id:computed.taskId,fingerprint:computed.fingerprint,spec,state:'assigned',generation:1,attemptId:'fixture-attempt',canonical:null},attempt:{id:'fixture-attempt',activeCommandId:'fixture-command',taskId:computed.taskId,generation:1,deviceId:'fixture-phone',profileId:'fixture-profile',accountId:null,leaseExpiresAt:'2026-10-19T00:05:00Z',phase:'assigned',submission:'unsent',checkpointRef:null},command:{id:'fixture-command',taskId:computed.taskId,attemptId:'fixture-attempt',generation:1,fingerprint:computed.fingerprint,action:'start',phase:'queued'}}
writeFileSync(new URL('./command-fixture.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n')
