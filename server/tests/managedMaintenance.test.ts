import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import path from 'node:path'
const state=vi.hoisted(()=>({authority:{timeline:vi.fn()},fenced:{timeline:vi.fn()},retire:vi.fn(),lease:vi.fn(),create:vi.fn(),pause:vi.fn()}))
vi.mock('../src/services/managedCropPilot.js',()=>({pilotAuthority:state.create}))
vi.mock('../src/services/relayDeliveryPause.js',()=>({relayPauseForDatabase:state.pause}))
vi.mock('../src/services/managedPilotRetirement.js',()=>({retireUnsentPilot:state.retire}))
vi.mock('../src/services/managedProductionCoordinator.js',()=>({managedProductionCoordinator:{withLease:state.lease}}))
import {initManagedMaintenanceRoutes} from '../src/routes/managedMaintenance.js'
const taskId='task:sha256:'+'a'.repeat(64),root=path.resolve('/private/tmp/maintenance-fixture-root')
beforeEach(()=>{
 vi.resetAllMocks();vi.stubEnv('DOWNLOAD_ROOT',root);vi.stubEnv('MANAGED_PILOT','1');vi.stubEnv('MANAGED_WORKSPACE_ID','fixture-workspace');vi.stubEnv('MANAGED_STUDIO_TOKEN','fixture-studio-token');vi.stubEnv('RELAY_URL','https://fixture.invalid');vi.stubEnv('RELAY_TOKEN','fixture-legacy-token')
 state.create.mockReturnValue(state.authority);state.pause.mockReturnValue({fixture:true});state.lease.mockImplementation(async(_authority,work)=>work(state.fenced));state.retire.mockResolvedValue({taskId})
})
afterEach(()=>vi.unstubAllEnvs())
async function call(page:unknown,body:unknown={taskId}){
 const findUnique=vi.fn(async()=>page),db={page:{findUnique}} as any,router=initManagedMaintenanceRoutes(db)
 const layer=(router as any).stack.find((entry:any)=>entry.route?.path==='/pages/:id/retire-unsent-pilot')
 const request={params:{id:'selected-page'},body},res:any={statusCode:200,status:vi.fn(function(this:any,status:number){this.statusCode=status;return this}),json:vi.fn()}
 await layer.route.stack[0].handle(request,res)
 return {res,findUnique,db}
}
function page(localPath:string|null='Series/Chapter/page_007.webp',folderPath='Series/Chapter'){return {id:'selected-page',localPath,index:99,chapter:{folderPath}}}
describe('exact local page identity in managed maintenance',()=>{
 it('passes the filename from Prisma localPath, never a guessed index or nonexistent filename field',async()=>{
  const {res,findUnique}=await call(page())
  expect(res.statusCode).toBe(200);expect(findUnique).toHaveBeenCalledWith({where:{id:'selected-page'},include:{chapter:true}})
  expect(state.retire).toHaveBeenCalledWith('Series/Chapter','page_007.webp',taskId,state.fenced)
  expect(state.lease).toHaveBeenCalledWith(state.authority,expect.any(Function));expect(res.json).toHaveBeenCalledWith({retired:true,taskId,retained:true})
 })
 it('accepts an absolute local path only when it belongs to that exact chapter under the library root',async()=>{
  const {res}=await call(page(path.join(root,'Series/Chapter/page_007.png')))
  expect(res.statusCode).toBe(200);expect(state.retire).toHaveBeenCalledWith('Series/Chapter','page_007.png',taskId,state.fenced)
 })
 it.each([null,'','Other/Chapter/page_007.webp','Series/Chapter/subfolder/page_007.webp','../outside/page_007.webp','Series/Chapter\\page_007.webp','Series/Chapter/page\u0000.webp'])('holds missing, foreign or malformed local paths %j before authority acquisition',async localPath=>{
  const {res}=await call(page(localPath));expect(res.statusCode).toBe(409)
  expect(state.create).not.toHaveBeenCalled();expect(state.lease).not.toHaveBeenCalled();expect(state.retire).not.toHaveBeenCalled()
 })
 it.each(['..','../outside','.',root+'/../outside'])('refuses an out-of-library or root chapter %j',async folder=>{
  const {res}=await call(page('page_007.webp',folder));expect(res.statusCode).toBe(409);expect(state.retire).not.toHaveBeenCalled();expect(state.lease).not.toHaveBeenCalled()
 })
 it('holds a missing database page without contacting authority',async()=>{
  const {res}=await call(null);expect(res.statusCode).toBe(409);expect(res.json).toHaveBeenCalledWith({error:'Page not found'});expect(state.create).not.toHaveBeenCalled()
 })
 it.each([{},null,{taskId:'wrong'},{taskId,filename:'other.webp'}])('refuses non-exact request intent %j',async body=>{
  const {res,findUnique}=await call(page(),body);expect(res.statusCode).toBe(409);expect(findUnique).not.toHaveBeenCalled();expect(state.retire).not.toHaveBeenCalled()
 })
 it('keeps the existing off switch ahead of authority and retirement',async()=>{
  vi.stubEnv('MANAGED_PILOT','0')
  const {res}=await call(page());expect(res.statusCode).toBe(409);expect(state.create).not.toHaveBeenCalled();expect(state.retire).not.toHaveBeenCalled()
 })
 it('does not retire anything when the coordinator cannot acquire authority',async()=>{
  state.lease.mockRejectedValue(new Error('Original lease unavailable'))
  const {res}=await call(page());expect(res.statusCode).toBe(409);expect(state.retire).not.toHaveBeenCalled()
 })
 it('preserves authority refusal rather than reporting a successful retirement',async()=>{
  state.retire.mockRejectedValue(new Error('Original task is not confirmed unsent'))
  const {res}=await call(page());expect(res.statusCode).toBe(409);expect(res.json).toHaveBeenCalledWith({error:'Original task is not confirmed unsent'})
 })
})
