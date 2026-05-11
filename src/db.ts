import { PrismaClient } from '@prisma/client'
import { config } from './config'

export const prisma = new PrismaClient({
  log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})
