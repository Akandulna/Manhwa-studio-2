import {S3Client} from '@aws-sdk/client-s3'

/** Shared credential shape only; prefix, scheduling and upload ownership are not selected here. */
export interface S3StorageConfig {accountId:string;accessKeyId:string;secretAccessKey:string;bucket:string}

/** Existing ordinary client behavior, including the SDK/environment retry policy. */
export function createLegacyR2S3Client(config:S3StorageConfig):S3Client {
 return new S3Client({region:'auto',endpoint:`https://${config.accountId}.r2.cloudflarestorage.com`,credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey}})
}
