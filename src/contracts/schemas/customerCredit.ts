import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

const exactMoney = z.string().regex(/^\d{1,10}\.\d{2}$/, 'Use an amount with two decimal places')
const positiveExactMoney = exactMoney.refine((value) => Number(value) > 0, 'Amount must be greater than zero')

export const CreditTransactionTypeSchema = z.enum(['credit_sale', 'repayment']).openapi('CustomerCreditTransactionType')

export const CreditTransactionSchema = z
  .object({
    id: z.string().uuid(),
    customerId: z.string().uuid(),
    storeId: z.string().uuid(),
    storeName: z.string().nullable(),
    type: CreditTransactionTypeSchema,
    amount: z.string(),
    saleId: z.string().uuid().nullable(),
    recordedBy: z.string().uuid(),
    note: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('CustomerCreditTransaction')

export const CustomerCreditSchema = z
  .object({
    customerId: z.string().uuid(),
    balance: z.string(),
    creditLimit: z.string().nullable(),
    transactions: z.array(CreditTransactionSchema),
  })
  .openapi('CustomerCredit')

export const CreateRepaymentSchema = z
  .object({
    amount: positiveExactMoney,
    note: z.string().trim().max(500).nullable().optional(),
  })
  .openapi('CreateCustomerCreditRepaymentRequest')

export const RepaymentResponseSchema = z
  .object({
    transaction: CreditTransactionSchema,
    balance: z.string(),
    creditLimit: z.string().nullable(),
  })
  .openapi('CustomerCreditRepaymentResponse')

export const ReceivablesQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    sort: z.enum(['balance_desc', 'balance_asc', 'name_asc', 'recent']).default('balance_desc'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .openapi('ReceivablesQuery')

export const ReceivableSchema = z
  .object({
    customerId: z.string().uuid(),
    name: z.string().nullable(),
    billingName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    balance: z.string(),
    creditLimit: z.string().nullable(),
    recentActivityAt: z.string().nullable(),
  })
  .openapi('Receivable')

export const ReceivablesListSchema = z
  .object({
    items: z.array(ReceivableSchema),
    total: z.number().int().nonnegative(),
    outstandingTotal: z.string(),
  })
  .openapi('ReceivablesList')

export const CreditLimitInputSchema = exactMoney.nullable().optional()

export type CreditTransaction = z.infer<typeof CreditTransactionSchema>
export type CustomerCredit = z.infer<typeof CustomerCreditSchema>
export type CreateRepayment = z.infer<typeof CreateRepaymentSchema>
export type Receivable = z.infer<typeof ReceivableSchema>
export type ReceivablesQuery = z.infer<typeof ReceivablesQuerySchema>
