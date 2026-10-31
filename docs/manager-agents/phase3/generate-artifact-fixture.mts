import fs from 'node:fs/promises'
import {cropTaskIdentity} from '../../../server/src/services/managedTaskProtocol.js'
import {MANAGED_CROP_VALIDATOR} from '../../../server/src/services/managedCropArtifact.js'
const fixture=JSON.parse(await fs.readFile(new URL('./command-fixture.json',import.meta.url),'utf8'))
fixture.task.spec.validatorVersion=MANAGED_CROP_VALIDATOR
const {workspaceId,seriesId,chapterId,pageId}=fixture.task
const identity=await cropTaskIdentity({workspaceId,seriesId,chapterId,pageId},fixture.task.spec)
fixture.task.id=identity.taskId;fixture.task.fingerprint=identity.fingerprint
fixture.attempt.taskId=identity.taskId;fixture.command.taskId=identity.taskId;fixture.command.fingerprint=identity.fingerprint
await fs.writeFile(new URL('./artifact-command-fixture.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n')
