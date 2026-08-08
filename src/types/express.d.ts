declare namespace Express {
  export interface Request {
    user?: {
      id: string
      role: 'owner' | 'manager' | 'cashier'
      tenantId: string
    }
    actingStaff?: {
      id: string
      role: 'owner' | 'manager' | 'cashier'
      sessionId?: string
      mustChangePin?: boolean
    }
    /**
     * Server-owned authorization facts resolved by authMiddleware in one short
     * tenant transaction. Downstream gates consume this snapshot instead of
     * opening their own independent transactions for the same request.
     */
    accessContext?: {
      subscription: {
        entitlement: 'active' | 'grace' | 'blocked'
        accessAllowed: boolean
        graceUntil: Date | null
      }
      pairedTerminalId: string | null
      operator:
        | { state: 'absent' }
        | { state: 'invalid' }
        | {
            state: 'valid'
            staff: {
              id: string
              role: 'owner' | 'manager' | 'cashier'
              sessionId?: string
              mustChangePin?: boolean
            }
          }
    }
  }
}
