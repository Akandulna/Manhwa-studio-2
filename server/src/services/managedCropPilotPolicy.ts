import {TaskConflict,canonicalJson,type CropSpec,type CropTask,type CropIdentity} from './managedTaskProtocol.js'
export const DEFAULT_CROP_CAPABILITY='chatgpt-default-crop/1'
export const LEGACY_CROP_PROMPT='managed-chatgpt-default-crop/1'
export const DEFAULT_CROP_PROMPT='managed-chatgpt-sliced-crop/1'
export const SLICED_CROP_CAPABILITY='chatgpt-sliced-crop/1'
/** provider-default names an execution policy, not a claim about the provider's underlying model. */
export function isDefaultCropPilot(spec:CropSpec):boolean {
 return spec.provider==='chatgpt'&&spec.product==='chatgpt-web'&&spec.model==='provider-default'&&spec.settings.mode===null&&spec.settings.effort===null&&[LEGACY_CROP_PROMPT,DEFAULT_CROP_PROMPT].includes(spec.promptVersion)&&spec.validatorVersion==='managed-crop-validator/1'&&spec.dependencies.length===1
}
export function requireDefaultCropPilot(spec:CropSpec):void {
 if(!isDefaultCropPilot(spec))throw new TaskConflict('This pilot supports ChatGPT default settings only; model selection and fallback are disabled')
}

/** Existing exact bindings remain historical inputs; a policy upgrade never silently replaces their task. */
export function preserveBoundPilotSpec(identity:CropIdentity,planned:CropSpec,bound:CropTask|null):CropSpec {
 if(bound&&isDefaultCropPilot(bound.spec)&&(['workspaceId','seriesId','chapterId','pageId'] as const).every(key=>bound[key]===identity[key])&&canonicalJson({...planned,promptVersion:bound.spec.promptVersion})===canonicalJson(bound.spec))return structuredClone(bound.spec)
 return planned
}
