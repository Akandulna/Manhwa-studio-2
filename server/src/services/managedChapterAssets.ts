import {getChapterManifest} from './chapterManifest.js'
import {managedCropBindingCount,withManagedCropWorkspaceLock,withManagedChapterLock} from './managedCropProjection.js'
import {readManagedCropReview,reviewedManagedCropFile} from './managedCropReview.js'
import {readManagedCropCut} from './managedCropCut.js'
import {artifactHash} from './managedCropArtifact.js'
import {canonicalJson,TaskConflict} from './managedTaskProtocol.js'

export const withManagedChapterAssetsLock=<T>(folder:string,work:()=>Promise<T>)=>withManagedCropWorkspaceLock(()=>withManagedChapterLock(folder,work))
async function inventory(folder:string) {
 const count=await managedCropBindingCount(folder)
 if(!count)return null
 const manifest=await getChapterManifest(folder)
 if(manifest.images.length>1000||count!==manifest.images.length)throw new TaskConflict('Every source page must have a current managed reviewed cut; mixed chapters are blocked')
 const pages=[]
 for(const image of manifest.images) {
  const review=await readManagedCropReview(folder,image.filename)
  if(!review.reviewed||!review.cut.complete)throw new TaskConflict('Every managed page must be explicitly reviewed and cut')
  const cut=await readManagedCropCut(folder,image.filename)
  if(!cut)throw new TaskConflict('Current managed cut required')
  const assets=cut.files.map((file,index)=>({...file,output:file.filename,
   filename:`managed_${review.taskId.slice(12)}_${review.revision}_${String(index+1).padStart(4,'0')}.png`,
   sourceFilename:image.filename,reviewRevision:review.revision,taskId:review.taskId}))
  // Projection only: original provider metadata and immutable bytes remain untouched.
  const metadata={...review.metadata,crops:review.metadata.crops.map((crop:any)=>({...crop,exportedFilename:assets.find(file=>file.cropId===crop.id)!.filename}))}
  pages.push({filename:image.filename,revision:review.revision,reviewedAt:review.reviewedAt!,metadata,pointers:review.pointers,assets})
 }
 const revision=await artifactHash(new TextEncoder().encode(canonicalJson(pages.map(page=>({filename:page.filename,revision:page.revision,files:page.assets.map(({filename,sha256,bytes,width,height})=>({filename,sha256,bytes,width,height}))})))))
 return {revision,pages,assets:pages.flatMap(page=>page.assets)}
}
/** Null means wholly legacy. Bound but incomplete/corrupt/mixed input throws; never fall back to crops3. */
export const readManagedChapterAssets=(folder:string)=>withManagedChapterAssetsLock(folder,async()=>{
 const first=await inventory(folder)
 if(first&&(await inventory(folder))?.revision!==first.revision)throw new TaskConflict('Managed chapter changed during inventory')
 return first
})
export async function assertManagedChapterRevision(folder:string,expected:string|null) {
 const current=await readManagedChapterAssets(folder)
 if((current?.revision??null)!==expected)throw new TaskConflict('Managed chapter changed; rebuild its Editor inputs')
}
export async function managedChapterImage(folder:string,expected:string,filename:string) {
 return withManagedChapterAssetsLock(folder,async()=>{
  const current=await readManagedChapterAssets(folder)
  if(!current||current.revision!==expected)throw new TaskConflict('Managed chapter revision changed')
  const asset=current.assets.find(file=>file.filename===filename)
  if(!asset)throw new TaskConflict('Unknown managed chapter image')
  const bytes=await reviewedManagedCropFile(folder,asset.sourceFilename,asset.reviewRevision,asset.output)
  await assertManagedChapterRevision(folder,expected)
  return bytes
 })
}
