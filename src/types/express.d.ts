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
    }
  }
}
