import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
extendZodWithOpenApi(z)

export const CreateHardwarePairingSchema = z.object({ terminalId: z.string().uuid() }).strict().openapi('CreateHardwarePairing')
export const HardwarePairSchema = z.object({ pairingCode: z.string().min(20).max(300), machineName: z.string().trim().min(1).max(120), os: z.string().trim().min(1).max(80), version: z.string().trim().min(1).max(40), capabilities: z.record(z.string(), z.unknown()).default({}) }).strict().openapi('HardwarePair')
export const HardwareHeartbeatSchema = z.object({ version: z.string().trim().min(1).max(40), capabilities: z.record(z.string(), z.unknown()).default({}) }).strict().openapi('HardwareHeartbeat')
export const HardwareJobResultSchema = z.object({ status: z.enum(['completed','failed']), error: z.string().trim().max(500).optional(), result: z.record(z.string(), z.unknown()).optional() }).strict().openapi('HardwareJobResult')
export const CreateHardwareTestJobSchema = z.object({ terminalId: z.string().uuid(), kind: z.enum(['test_print','open_drawer']), payload: z.record(z.string(), z.unknown()).default({}) }).strict().openapi('CreateHardwareTestJob')
