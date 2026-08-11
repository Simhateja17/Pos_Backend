declare namespace Express {
  export interface Request {
    user?: {
      id: string
      role: 'owner' | 'manager' | 'cashier'
      tenantId: string
      /**
       * The store this staff member belongs to (Phase 8). One person, one shop
       * — see migration 0042. For an owner this is their home shop and does NOT
       * constrain them; owners may act in any store of their tenant. For a
       * manager or cashier it is the only store they may act in.
       *
       * This is their MEMBERSHIP, not the store the current request acts on.
       * For that, use req.storeContext.activeStoreId.
       */
      storeId: string
    }
    /**
     * Which store this request acts on, resolved server-side by storeContext
     * middleware from verified membership plus an authorization-checked
     * X-Store-Id header. Never taken on trust from the client.
     */
    storeContext?: {
      /**
       * 'store'    — this request concerns exactly one shop (activeStoreId set).
       * 'business' — an owner asked for every shop combined, via
       *              `X-Store-Id: all`. READ-ONLY: activeStoreId is null, so
       *              any write path calling activeStoreId() throws rather than
       *              guessing which shop to write to.
       */
      scope: 'store' | 'business'
      activeStoreId: string | null
      /** True when an owner is operating inside a store that isn't their home shop. */
      actingRemotely: boolean
    }
    actingStaff?: {
      id: string
      role: 'owner' | 'manager' | 'cashier'
      /** One-person/one-store membership; optional only for legacy tokens. */
      storeId?: string
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
              /** Store membership resolved from the staff row when available. */
              storeId?: string
              sessionId?: string
              mustChangePin?: boolean
            }
          }
    }
  }
}
