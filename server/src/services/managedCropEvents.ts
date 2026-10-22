/** Local cache invalidation only. No task authority, timer or network delivery lives here. */
const listeners=new Set<()=>void>()
export function onManagedCropProjectionChange(listener:()=>void):()=>void {listeners.add(listener);return ()=>listeners.delete(listener)}
export function managedCropProjectionChanged():void {for(const listener of listeners)listener()}
