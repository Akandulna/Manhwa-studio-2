import {recordManagerRecovery} from './managerReporting.js'
import type {PrismaClient} from '@prisma/client'
import {AutomationRecovery} from './automationRecovery.js'
import {productionJobDatabase} from './productionJobDatabase.js'
/** Instances share the transactional journal, not an in-memory retry counter. */
export const automationRecoveryForDatabase=(db:PrismaClient)=>new AutomationRecovery(productionJobDatabase(()=>db),Date.now,new Set(['restore_local','upload_saved','account_recheck','navigate','ui_repair']),recordManagerRecovery)
