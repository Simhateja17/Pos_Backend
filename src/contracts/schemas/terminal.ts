import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const TerminalSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    isActive: z.boolean(),
    /**
     * Whether a shift is currently open on this terminal. The open-shift
     * picker needs it to grey out tills that are already running, and the
     * settings screen needs it to refuse deactivation of a live counter.
     */
    hasOpenShift: z.boolean(),
    createdAt: z.string(),
  })
  .openapi('Terminal')

export const CreateTerminalSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
  })
  .strict()
  .openapi('CreateTerminalRequest')

export const UpdateTerminalSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateTerminalRequest')

export type Terminal = z.infer<typeof TerminalSchema>
export type CreateTerminalInput = z.infer<typeof CreateTerminalSchema>
export type UpdateTerminalInput = z.infer<typeof UpdateTerminalSchema>
