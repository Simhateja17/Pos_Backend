import crypto from 'node:crypto'
import path from 'node:path'

import bcrypt from 'bcrypt'
import dotenv from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Client } from 'pg'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const PROJECT_REF = 'nlmyfiamdwedzaezoets'
const QA_SEED = 'ambel-manual-qa-v1'
const OWNER_EMAIL = 'simhateja17@gmail.com'
const ISOLATION_A_EMAIL = 'simhateja17+qa-isolation-a@gmail.com'
const ISOLATION_B_EMAIL = 'simhateja17+qa-isolation-b@gmail.com'

const PIN = {
  owner: '9001',
  managerS1: '2468',
  managerS9: '1357',
  cashierS1A: '4101',
  cashierS1B: '4102',
  cashierS2A: '4201',
  cashierS2B: '4202',
  cashierS3: '4301',
  cashierS10: '5001',
  isolationA: '6101',
  isolationB: '6201',
} as const

const START_DATE = new Date(Date.UTC(2025, 4, 1))
const END_DATE = new Date(Date.UTC(2026, 7, 10))
const INDIA_TZ = 'Asia/Kolkata'
// Tax columns store decimal fractions, not human percentages: 0.18 means 18%.
// Keeping the split derived from one constant prevents a seed reset from
// reintroducing the percentage-vs-fraction billing bug.
const QA_GST_RATE = 0.18
const QA_STATE_TAX_RATE = QA_GST_RATE / 2
const QA_COUNTY_TAX_RATE = QA_GST_RATE / 2

type UUID = string
type StoreSpec = {
  key: string
  name: string
  city: string
  postalCode: string
  counters: number
  dailySales: number
  starts: Date
  ends?: Date
  active: boolean
}

type VariantMeta = {
  id: UUID
  productId: UUID
  productKey: string
  productName: string
  sku: string
  size: string | null
  color: string | null
  material: string | null
  price: number
  taxable: boolean
  taxRate: number
  unit: string
  threshold: number
  barcode: string | null
  hsnSac: string
}

type SaleLinePlan = {
  id: UUID
  variant: VariantMeta
  quantity: number
  unitPrice: number
  discountAmount: number
  lineTotal: number
}

type SalePlan = {
  id: UUID
  clientSaleId: UUID
  store: StoreSpec
  storeId: UUID
  shiftId: UUID
  staffId: UUID
  customerId: UUID | null
  createdAt: Date
  source: 'pos' | 'import'
  lines: SaleLinePlan[]
  subtotal: number
  discountAmount: number
  taxAmount: number
  totalAmount: number
  payments: Array<{ method: 'cash' | 'card' | 'check' | 'upi'; amount: number; referenceCode: string | null }>
  returnedLine?: SaleLinePlan
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} in backend/.env`)
  return value
}

function stableUuid(key: string): UUID {
  const digest = crypto.createHash('sha256').update(`${QA_SEED}:${key}`).digest()
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function atIstHour(day: Date, hour: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour - 5, 30))
}

function financialYear(date: Date): string {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  return month >= 3 ? `${year}-${String(year + 1).slice(-2)}` : `${year - 1}-${String(year).slice(-2)}`
}

async function insertRows(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  const invalidRow = rows.find((row) => row.length !== columns.length)
  if (invalidRow) {
    throw new Error(`QA seed row width mismatch for ${table}: expected ${columns.length}, got ${invalidRow.length}`)
  }
  const batchSize = 200
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize)
    const values: unknown[] = []
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = row.map((value, columnIndex) => {
        values.push(value)
        return `$${rowIndex * row.length + columnIndex + 1}`
      })
      return `(${placeholders.join(', ')})`
    })
    await client.query(
      `INSERT INTO public.${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values,
    )
  }
}

async function ensureAuthUser(
  admin: SupabaseClient<any, any, any>,
  email: string,
): Promise<{ id: UUID; created: boolean }> {
  const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listError) throw new Error(`Could not list Auth users for ${email}: ${listError.message}`)
  const existing = listed.users.find((user) => user.email?.toLowerCase() === email.toLowerCase())
  if (existing) return { id: existing.id, created: false }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: crypto.randomBytes(32).toString('base64url'),
    user_metadata: { qaSeed: QA_SEED },
  })
  if (error || !data.user) throw new Error(`Could not create Auth user ${email}: ${error?.message ?? 'no user returned'}`)
  return { id: data.user.id, created: true }
}

const MAIN_STORES: StoreSpec[] = [
  { key: 'S1', name: 'QA - Anvaya HQ Bengaluru', city: 'Bengaluru', postalCode: '560001', counters: 8, dailySales: 5, starts: START_DATE, active: true },
  { key: 'S2', name: 'QA - Anvaya Mall Bengaluru', city: 'Bengaluru', postalCode: '560103', counters: 4, dailySales: 4, starts: START_DATE, active: true },
  { key: 'S3', name: 'QA - Anvaya High Street Mysuru', city: 'Mysuru', postalCode: '570001', counters: 2, dailySales: 3, starts: START_DATE, active: true },
  { key: 'S4', name: 'QA - Anvaya Pop-up Mandya', city: 'Mandya', postalCode: '571401', counters: 1, dailySales: 1, starts: START_DATE, active: true },
  { key: 'S5', name: 'QA - Anvaya Kiosk Bengaluru', city: 'Bengaluru', postalCode: '560038', counters: 1, dailySales: 1, starts: START_DATE, active: true },
  { key: 'S6', name: 'QA - Anvaya Seasonal Udupi', city: 'Udupi', postalCode: '576101', counters: 3, dailySales: 2, starts: START_DATE, active: true },
  { key: 'S7', name: 'QA - Anvaya New Store No Counter', city: 'Tumakuru', postalCode: '572101', counters: 0, dailySales: 0, starts: END_DATE, active: true },
  { key: 'S8', name: 'QA - Anvaya Closed Store History', city: 'Hassan', postalCode: '573201', counters: 6, dailySales: 3, starts: START_DATE, ends: new Date(Date.UTC(2026, 6, 15)), active: false },
  { key: 'S9', name: 'QA - Anvaya New Store', city: 'Shivamogga', postalCode: '577201', counters: 2, dailySales: 1, starts: new Date(Date.UTC(2026, 5, 1)), active: true },
  { key: 'S10', name: 'QA - Anvaya Entitlement Boundary', city: 'Belagavi', postalCode: '590001', counters: 5, dailySales: 2, starts: START_DATE, active: true },
]

const CATEGORIES = [
  'Kurtas',
  'Sarees',
  'Dresses',
  'Shirts',
  'Bottoms',
  'Kidswear',
  'Accessories',
  'Services',
]

const PRODUCT_SPECS: Array<{
  key: string
  name: string
  category: string
  taxable: boolean
  unit: string
  variants: Array<{ size: string | null; color: string | null; material: string; price: number }>
}> = [
  { key: 'KURTA', name: 'QA - Cotton Kurta', category: 'Kurtas', taxable: true, unit: 'piece', variants: ['S', 'M', 'L', 'XL'].flatMap((size) => ['Ivory', 'Teal'].map((color) => ({ size, color, material: 'Cotton', price: 1299 }))) },
  { key: 'SAREE', name: 'QA - Handloom Saree', category: 'Sarees', taxable: true, unit: 'piece', variants: ['Maroon', 'Indigo', 'Mustard'].map((color) => ({ size: 'Free', color, material: 'Handloom Cotton', price: 2499 })) },
  { key: 'ANARKALI', name: 'QA - Anarkali Dress', category: 'Dresses', taxable: true, unit: 'piece', variants: ['S', 'M', 'L', 'XL'].flatMap((size) => ['Rose', 'Navy'].map((color) => ({ size, color, material: 'Rayon', price: 2199 }))) },
  { key: 'SHIRT', name: 'QA - Linen Shirt', category: 'Shirts', taxable: true, unit: 'piece', variants: ['S', 'M', 'L', 'XL'].flatMap((size) => ['White', 'Blue'].map((color) => ({ size, color, material: 'Linen', price: 1799 }))) },
  { key: 'JEANS', name: 'QA - Denim Jeans', category: 'Bottoms', taxable: true, unit: 'piece', variants: ['28', '30', '32', '34'].flatMap((size) => ['Black', 'Blue'].map((color) => ({ size, color, material: 'Denim', price: 1999 }))) },
  { key: 'CHURIDAR', name: 'QA - Churidar Set', category: 'Kurtas', taxable: true, unit: 'piece', variants: ['S', 'M', 'L', 'XL'].flatMap((size) => ['Pink', 'Green'].map((color) => ({ size, color, material: 'Cotton Silk', price: 1599 }))) },
  { key: 'FROCK', name: 'QA - Kids Frock', category: 'Kidswear', taxable: true, unit: 'piece', variants: ['2Y', '4Y', '6Y'].flatMap((size) => ['Yellow', 'Red'].map((color) => ({ size, color, material: 'Cotton', price: 899 }))) },
  { key: 'DUPATTA', name: 'QA - Handloom Dupatta', category: 'Accessories', taxable: true, unit: 'metre', variants: ['2m', '2.5m'].flatMap((size) => ['Orange', 'Green', 'Blue'].map((color) => ({ size, color, material: 'Cotton', price: 699 }))) },
  { key: 'BELT', name: 'QA - Leather Belt', category: 'Accessories', taxable: true, unit: 'piece', variants: ['S', 'M', 'L'].map((size) => ({ size, color: 'Brown', material: 'Leather', price: 799 })) },
  { key: 'HANDBAG', name: 'QA - Handcrafted Handbag', category: 'Accessories', taxable: true, unit: 'piece', variants: ['Small', 'Medium', 'Large'].map((size) => ({ size, color: 'Tan', material: 'Vegan Leather', price: 1499 })) },
  { key: 'TSHIRT', name: 'QA - Everyday T-shirt', category: 'Shirts', taxable: true, unit: 'piece', variants: ['S', 'M', 'L', 'XL'].flatMap((size) => ['White', 'Black'].map((color) => ({ size, color, material: 'Cotton', price: 599 }))) },
  { key: 'TROUSER', name: 'QA - Formal Trouser', category: 'Bottoms', taxable: true, unit: 'piece', variants: ['30', '32', '34', '36'].map((size) => ({ size, color: 'Charcoal', material: 'Poly Viscose', price: 1699 })) },
  { key: 'FABRIC', name: 'QA - Tailoring Fabric', category: 'Services', taxable: true, unit: 'metre', variants: ['2m', '5m', '10m'].map((size) => ({ size, color: 'Natural', material: 'Cotton', price: 249 })) },
  { key: 'BAG', name: 'QA - Reusable Cloth Bag', category: 'Services', taxable: false, unit: 'piece', variants: [{ size: 'One Size', color: 'Natural', material: 'Cotton', price: 49 }] },
  { key: 'BOUNDARY', name: 'QA - Reorder Boundary Tee', category: 'Shirts', taxable: true, unit: 'piece', variants: ['S', 'M', 'L'].map((size) => ({ size, color: 'Grey', material: 'Cotton', price: 749 })) },
  { key: 'ZERO', name: 'QA - Zero Stock Basic Tee', category: 'Shirts', taxable: true, unit: 'piece', variants: ['S', 'M', 'L'].map((size) => ({ size, color: 'White', material: 'Cotton', price: 499 })) },
]

async function main(): Promise<void> {
  const supabaseUrl = required('SUPABASE_URL')
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY')
  const projectRef = required('SUPABASE_PROJECT_REF')
  if (projectRef !== PROJECT_REF || supabaseUrl !== `https://${PROJECT_REF}.supabase.co`) {
    throw new Error(`Refusing to seed unexpected Supabase project: ${projectRef} / ${supabaseUrl}`)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  const authUsers = await Promise.all([
    ensureAuthUser(admin, OWNER_EMAIL),
    ensureAuthUser(admin, ISOLATION_A_EMAIL),
    ensureAuthUser(admin, ISOLATION_B_EMAIL),
  ])
  const [ownerAuth, isolationAAuth, isolationBAuth] = authUsers

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) throw new Error('Missing DIRECT_URL or DATABASE_URL in backend/.env')
  const db = new Client({ connectionString })
  await db.connect()

  const mainTenantId = stableUuid('tenant:main')
  const isolationATenantId = stableUuid('tenant:isolation-a')
  const isolationBTenantId = stableUuid('tenant:isolation-b')
  const mainOwnerId = stableUuid('staff:main:owner')
  const isolationAOwnerId = stableUuid('staff:isolation-a:owner')
  const isolationBOwnerId = stableUuid('staff:isolation-b:owner')

  try {
    const existingQa = await db.query<{ business_name: string }>(
      `SELECT business_name FROM public.tenants WHERE id = $1 OR business_name LIKE 'QA - Anvaya%' LIMIT 1`,
      [mainTenantId],
    )
    if (existingQa.rows.length > 0) {
      throw new Error(`QA seed already exists (${existingQa.rows[0].business_name}). No rows were changed.`)
    }

    const mainStoreIds = new Map(MAIN_STORES.map((store) => [store.key, stableUuid(`store:main:${store.key}`)]))
    const isolationAStoreId = stableUuid('store:isolation-a:main')
    const isolationBStoreId = stableUuid('store:isolation-b:main')

    const categoryIds = new Map(CATEGORIES.map((name) => [name, stableUuid(`category:main:${name}`)]))
    const productIds = new Map(PRODUCT_SPECS.map((product) => [product.key, stableUuid(`product:main:${product.key}`)]))
    const variants: VariantMeta[] = []
    const variantRows: unknown[][] = []
    for (const product of PRODUCT_SPECS) {
      product.variants.forEach((variant, index) => {
        const variantId = stableUuid(`variant:main:${product.key}:${index}`)
        const sku = `QA-${product.key}-${String(index + 1).padStart(2, '0')}`
        const barcode = `890QA${String(100000 + variants.length).padStart(6, '0')}`
        const meta: VariantMeta = {
          id: variantId,
          productId: productIds.get(product.key)!,
          productKey: product.key,
          productName: product.name,
          sku,
          size: variant.size,
          color: variant.color,
          material: variant.material,
          price: variant.price,
          taxable: product.taxable,
          taxRate: product.taxable ? QA_GST_RATE : 0,
          unit: product.unit,
          threshold: product.key === 'BOUNDARY' ? 8 : product.key === 'ZERO' ? 4 : product.unit === 'metre' ? 12 : 6,
          barcode,
          hsnSac: product.taxable ? '6204' : '6307',
        }
        variants.push(meta)
        variantRows.push([
          meta.id,
          mainTenantId,
          meta.productId,
          meta.sku,
          meta.size,
          meta.color,
          meta.material,
          meta.price,
          meta.threshold,
          false,
          atIstHour(START_DATE, 9),
          meta.taxable,
          meta.taxRate,
          Math.round(meta.price * 0.48 * 100) / 100,
          { qaSeed: QA_SEED, hsnSac: meta.hsnSac },
          meta.unit,
          meta.barcode,
        ])
      })
    }

    const ownerHash = await bcrypt.hash(PIN.owner, 12)
    const managerS1Hash = await bcrypt.hash(PIN.managerS1, 12)
    const managerS9Hash = await bcrypt.hash(PIN.managerS9, 12)
    const cashierHashes = await Promise.all([
      bcrypt.hash(PIN.cashierS1A, 12),
      bcrypt.hash(PIN.cashierS1B, 12),
      bcrypt.hash(PIN.cashierS2A, 12),
      bcrypt.hash(PIN.cashierS2B, 12),
      bcrypt.hash(PIN.cashierS3, 12),
      bcrypt.hash(PIN.cashierS10, 12),
    ])

    const storeRows = MAIN_STORES.map((store, index) => {
      const storeId = mainStoreIds.get(store.key)!
      return [
        storeId,
        mainTenantId,
        store.name,
        `${index + 1}, QA Main Road`,
        null,
        store.city,
        'Karnataka',
        store.postalCode,
        'IN',
        store.active,
        store.starts,
        QA_STATE_TAX_RATE,
        QA_COUNTY_TAX_RATE,
        0,
        0,
        'per_invoice',
        '29',
        `Q${index + 1}`,
        1,
      ]
    })
    storeRows.push([
      isolationAStoreId,
      isolationATenantId,
      'QA - Isolation A Store',
      '1 QA Isolation Road',
      null,
      'Bengaluru',
      'Karnataka',
      '560001',
      'IN',
      true,
      START_DATE,
      QA_STATE_TAX_RATE,
      QA_COUNTY_TAX_RATE,
      0,
      0,
      'per_invoice',
      '29',
      'IA1',
      1,
    ])
    storeRows.push([
      isolationBStoreId,
      isolationBTenantId,
      'QA - Isolation B Store',
      '1 QA Isolation Road',
      null,
      'Mysuru',
      'Karnataka',
      '570001',
      'IN',
      true,
      START_DATE,
      QA_STATE_TAX_RATE,
      QA_COUNTY_TAX_RATE,
      0,
      0,
      'per_invoice',
      '29',
      'IB1',
      1,
    ])

    const terminalRows: unknown[][] = []
    for (const store of MAIN_STORES) {
      const storeId = mainStoreIds.get(store.key)!
      for (let counter = 1; counter <= store.counters; counter += 1) {
        terminalRows.push([
          stableUuid(`terminal:main:${store.key}:${counter}`),
          mainTenantId,
          storeId,
          `QA ${store.key} Counter ${String(counter).padStart(2, '0')}`,
          true,
          store.starts,
          'cash',
          null,
          null,
          null,
        ])
      }
    }
    terminalRows.push([stableUuid('terminal:isolation-a:1'), isolationATenantId, isolationAStoreId, 'QA Isolation A Counter 01', true, START_DATE, 'cash', null, null, null])
    terminalRows.push([stableUuid('terminal:isolation-b:1'), isolationBTenantId, isolationBStoreId, 'QA Isolation B Counter 01', true, START_DATE, 'cash', null, null, null])

    const staffRows: unknown[][] = [
      [mainOwnerId, mainTenantId, mainStoreIds.get('S1'), ownerAuth.id, 'QA Owner - Simha Teja', 'owner', OWNER_EMAIL, ownerHash, 0, null, false, true, START_DATE],
      [stableUuid('staff:main:manager-s1'), mainTenantId, mainStoreIds.get('S1'), null, 'QA Manager - HQ', 'manager', null, managerS1Hash, 0, null, false, true, START_DATE],
      [stableUuid('staff:main:manager-s9'), mainTenantId, mainStoreIds.get('S9'), null, 'QA Manager - New Store', 'manager', null, managerS9Hash, 0, null, false, true, new Date(Date.UTC(2026, 5, 1))],
      [stableUuid('staff:main:cashier-s1-a'), mainTenantId, mainStoreIds.get('S1'), null, 'QA Cashier - HQ A', 'cashier', null, cashierHashes[0], 0, null, false, true, START_DATE],
      [stableUuid('staff:main:cashier-s1-b'), mainTenantId, mainStoreIds.get('S1'), null, 'QA Cashier - HQ B', 'cashier', null, cashierHashes[1], 0, null, false, true, START_DATE],
      [stableUuid('staff:main:cashier-s2-a'), mainTenantId, mainStoreIds.get('S2'), null, 'QA Cashier - Mall A', 'cashier', null, cashierHashes[2], 0, null, false, true, START_DATE],
      [stableUuid('staff:main:cashier-s2-b'), mainTenantId, mainStoreIds.get('S2'), null, 'QA Cashier - Mall B', 'cashier', null, cashierHashes[3], 0, null, false, true, START_DATE],
      [stableUuid('staff:main:cashier-s3'), mainTenantId, mainStoreIds.get('S3'), null, 'QA Cashier - Mysuru', 'cashier', null, cashierHashes[4], 0, null, false, true, START_DATE],
      [stableUuid('staff:main:cashier-s10'), mainTenantId, mainStoreIds.get('S10'), null, 'QA Cashier - Boundary', 'cashier', null, cashierHashes[5], 0, null, false, true, START_DATE],
      [isolationAOwnerId, isolationATenantId, isolationAStoreId, isolationAAuth.id, 'QA Isolation A Owner', 'owner', ISOLATION_A_EMAIL, await bcrypt.hash(PIN.isolationA, 12), 0, null, false, true, START_DATE],
      [isolationBOwnerId, isolationBTenantId, isolationBStoreId, isolationBAuth.id, 'QA Isolation B Owner', 'owner', ISOLATION_B_EMAIL, await bcrypt.hash(PIN.isolationB, 12), 0, null, false, true, START_DATE],
    ]

    const tenantRows = [
      [mainTenantId, 'QA - Anvaya Fashion House (Manual QA)', '1 QA Main Road', null, 'Bengaluru', 'Karnataka', '560001', 'IN', '29ABCDE1234F1Z5', 15, QA_STATE_TAX_RATE, QA_COUNTY_TAX_RATE, 0, 0, 'per_invoice', { qaSeed: QA_SEED, purpose: 'manual multi-store QA', historyStart: '2025-05-01', storeCount: 10 }, 8, new Date(), INDIA_TZ, 'QA - Anvaya', 'regular', 'ABCDE1234F', '29', 'fashion_retail', 'code128'],
      [isolationATenantId, 'QA - Isolation Tenant A', '1 QA Isolation Road', null, 'Bengaluru', 'Karnataka', '560001', 'IN', null, 15, QA_STATE_TAX_RATE, QA_COUNTY_TAX_RATE, 0, 0, 'per_invoice', { qaSeed: QA_SEED, purpose: 'cross-tenant isolation A' }, 8, new Date(), INDIA_TZ, 'QA Isolation A', 'unregistered', null, '29', 'fashion_retail', 'code128'],
      [isolationBTenantId, 'QA - Isolation Tenant B', '1 QA Isolation Road', null, 'Mysuru', 'Karnataka', '570001', 'IN', null, 15, QA_STATE_TAX_RATE, QA_COUNTY_TAX_RATE, 0, 0, 'per_invoice', { qaSeed: QA_SEED, purpose: 'cross-tenant isolation B' }, 8, new Date(), INDIA_TZ, 'QA Isolation B', 'unregistered', null, '29', 'fashion_retail', 'code128'],
    ]

    const subscriptionRows = [
      [stableUuid('subscription:main'), mainTenantId, null, 'razorpay', 'qa-main-subscription', 'qa-premium', 'IN', 'premium', 'monthly', 'INR', 209900, 37782, 247682, 1800, 5, 5, 'active', 'active', false, new Date(), new Date(Date.UTC(2027, 4, 1)), null, null, null, { qaSeed: QA_SEED, fakeProviderRecord: true }, new Date(), new Date()],
      [stableUuid('subscription:isolation-a'), isolationATenantId, null, 'razorpay', 'qa-isolation-a-subscription', 'qa-professional', 'IN', 'professional', 'monthly', 'INR', 129900, 23382, 153282, 1800, 3, 0, 'active', 'active', false, new Date(), new Date(Date.UTC(2027, 4, 1)), null, null, null, { qaSeed: QA_SEED, fakeProviderRecord: true }, new Date(), new Date()],
      [stableUuid('subscription:isolation-b'), isolationBTenantId, null, 'razorpay', 'qa-isolation-b-subscription', 'qa-professional', 'IN', 'professional', 'monthly', 'INR', 129900, 23382, 153282, 1800, 3, 0, 'active', 'active', false, new Date(), new Date(Date.UTC(2027, 4, 1)), null, null, null, { qaSeed: QA_SEED, fakeProviderRecord: true }, new Date(), new Date()],
    ]

    const categoriesRows = CATEGORIES.map((name, index) => [categoryIds.get(name), mainTenantId, `QA - ${name}`, index, START_DATE])
    const isolationCategoryRows = [
      [stableUuid('category:isolation-a'), isolationATenantId, 'QA - Isolation Category A', 0, START_DATE],
      [stableUuid('category:isolation-b'), isolationBTenantId, 'QA - Isolation Category B', 0, START_DATE],
    ]
    const productRows = PRODUCT_SPECS.map((product) => [productIds.get(product.key), mainTenantId, product.name, START_DATE, categoryIds.get(product.category)])
    const isolationProductRows = [
      [stableUuid('product:isolation-a'), isolationATenantId, 'QA - Isolation A Product', START_DATE, stableUuid('category:isolation-a')],
      [stableUuid('product:isolation-b'), isolationBTenantId, 'QA - Isolation B Product', START_DATE, stableUuid('category:isolation-b')],
    ]
    const isolationVariantRows = [
      [stableUuid('variant:isolation-a'), isolationATenantId, stableUuid('product:isolation-a'), 'QA-ISO-A-01', 'One Size', 'Blue', 'Cotton', 999, 4, false, START_DATE, true, QA_GST_RATE, 400, { qaSeed: QA_SEED }, 'piece', '890QA900001'],
      [stableUuid('variant:isolation-b'), isolationBTenantId, stableUuid('product:isolation-b'), 'QA-ISO-B-01', 'One Size', 'Red', 'Cotton', 999, 4, false, START_DATE, true, QA_GST_RATE, 400, { qaSeed: QA_SEED }, 'piece', '890QA900002'],
    ]

    const customerRows: unknown[][] = []
    for (let index = 1; index <= 120; index += 1) {
      const id = stableUuid(`customer:main:${index}`)
      customerRows.push([
        id,
        mainTenantId,
        `QA Customer ${String(index).padStart(3, '0')}`,
        `98${String(70000000 + index).padStart(8, '0')}`,
        `qa.customer.${String(index).padStart(3, '0')}@example.test`,
        `QA Customer ${String(index).padStart(3, '0')}`,
        index % 19 === 0 ? '29ABCDE1234F1Z5' : null,
        `${index} QA Customer Street`,
        null,
        index % 2 === 0 ? 'Bengaluru' : 'Mysuru',
        '29',
        index % 2 === 0 ? '560001' : '570001',
        'IN',
        index % 17 === 0 ? 'QA customer with notes for manual search testing' : null,
        START_DATE,
        START_DATE,
      ])
    }

    const supplierSpecs = [
      ['SUP-A', 'QA - Bengaluru Textiles', 'Asha Rao', 'qa.supplier.a@example.test', '08040000001', 5, 'Net 30'],
      ['SUP-B', 'QA - Mysuru Handlooms', 'Ravi Kumar', 'qa.supplier.b@example.test', '08214000002', 14, 'Net 15'],
      ['SUP-C', 'QA - South India Apparel', 'Nisha Menon', 'qa.supplier.c@example.test', '08040000003', 21, 'Advance'],
      ['SUP-D', 'QA - Accessories Co', 'Farhan Ali', 'qa.supplier.d@example.test', '08040000004', 7, 'Net 30'],
      ['SUP-E', 'QA - Kidswear Works', 'Meera Shah', 'qa.supplier.e@example.test', '08040000005', 10, 'Net 15'],
      ['SUP-F', 'QA - Slow Supplier', 'Dev Patel', 'qa.supplier.f@example.test', '08040000006', 45, 'Net 45'],
      ['SUP-G', 'QA - Inactive Supplier', 'Kiran Das', 'qa.supplier.g@example.test', '08040000007', 12, 'Net 30'],
      ['SUP-H', 'QA - Seasonal Supplier', 'Sana Khan', 'qa.supplier.h@example.test', '08040000008', 30, 'Advance'],
    ] as const
    const supplierIds = new Map(supplierSpecs.map(([key]) => [key, stableUuid(`supplier:main:${key}`)]))
    const supplierRows = supplierSpecs.map(([key, name, contact, email, phone, leadTime, terms], index) => [supplierIds.get(key), mainTenantId, name, contact, email, phone, leadTime, terms, key !== 'SUP-G', new Date(Date.UTC(2025, 3, 15 + index))])

    const staffByStore = new Map<string, UUID>([
      ['S1', stableUuid('staff:main:cashier-s1-a')],
      ['S2', stableUuid('staff:main:cashier-s2-a')],
      ['S3', stableUuid('staff:main:cashier-s3')],
      ['S4', stableUuid('staff:main:cashier-s3')],
      ['S5', stableUuid('staff:main:cashier-s1-a')],
      ['S6', stableUuid('staff:main:cashier-s2-a')],
      ['S8', stableUuid('staff:main:cashier-s3')],
      ['S9', stableUuid('staff:main:manager-s9')],
      ['S10', stableUuid('staff:main:cashier-s10')],
    ])
    const managerByStore = new Map<string, UUID>([
      ['S1', stableUuid('staff:main:manager-s1')],
      ['S2', stableUuid('staff:main:manager-s1')],
      ['S3', stableUuid('staff:main:manager-s1')],
      ['S4', stableUuid('staff:main:manager-s1')],
      ['S5', stableUuid('staff:main:manager-s1')],
      ['S6', stableUuid('staff:main:manager-s1')],
      ['S8', stableUuid('staff:main:manager-s1')],
      ['S9', stableUuid('staff:main:manager-s9')],
      ['S10', stableUuid('staff:main:manager-s1')],
    ])

    const activeVariants = variants.filter((variant) => variant.productKey !== 'BAG').slice(0, 70)
    const customers = customerRows.map((row) => String(row[0]))
    const plannedUnits = new Map<string, number>()
    const shiftMeta = new Map<string, { store: StoreSpec; storeId: UUID; staffId: UUID; terminalId: UUID; day: Date; cashCollected: number }>()
    const salePlans: SalePlan[] = []
    const mainStoreIndex = new Map(MAIN_STORES.map((store, index) => [store.key, index]))

    for (const store of MAIN_STORES) {
      if (store.counters === 0 || store.dailySales === 0) continue
      const storeId = mainStoreIds.get(store.key)!
      const staffId = staffByStore.get(store.key)!
      const end = store.ends ?? END_DATE
      const start = store.starts < START_DATE ? START_DATE : store.starts
      let dayIndex = 0
      for (let day = new Date(start); day <= end; day = addDays(day, 1)) {
        if (day.getUTCDay() === 0 && store.key !== 'S1') {
          dayIndex += 1
          continue
        }
        const terminalNumber = (dayIndex % store.counters) + 1
        const terminalId = stableUuid(`terminal:main:${store.key}:${terminalNumber}`)
        const shiftId = stableUuid(`shift:main:${store.key}:${dateKey(day)}`)
        shiftMeta.set(shiftId, { store, storeId, staffId, terminalId, day, cashCollected: 0 })
        const count = store.dailySales + ((dayIndex + (mainStoreIndex.get(store.key) ?? 0)) % 7 === 0 ? 1 : 0)
        for (let saleIndex = 0; saleIndex < count; saleIndex += 1) {
          const firstVariant = activeVariants[(dayIndex * 11 + saleIndex * 7 + (mainStoreIndex.get(store.key) ?? 0)) % activeVariants.length]
          const secondVariant = saleIndex % 4 === 0 ? activeVariants[(dayIndex * 13 + saleIndex * 5 + 3) % activeVariants.length] : null
          const lineVariants = secondVariant && secondVariant.id !== firstVariant.id ? [firstVariant, secondVariant] : [firstVariant]
          const lines: SaleLinePlan[] = lineVariants.map((variant, lineIndex) => {
            const quantity = variant.unit === 'metre' ? (saleIndex + lineIndex) % 2 === 0 ? 1.5 : 2 : 1 + ((dayIndex + saleIndex + lineIndex) % 3 === 0 ? 1 : 0)
            const discountAmount = (dayIndex + saleIndex + lineIndex) % 23 === 0 ? roundMoney(variant.price * quantity * 0.08) : 0
            const lineTotal = roundMoney(variant.price * quantity - discountAmount)
            plannedUnits.set(`${store.key}:${variant.id}`, (plannedUnits.get(`${store.key}:${variant.id}`) ?? 0) + quantity)
            return {
              id: stableUuid(`sale-line:main:${store.key}:${dateKey(day)}:${saleIndex}:${lineIndex}`),
              variant,
              quantity,
              unitPrice: variant.price,
              discountAmount,
              lineTotal,
            }
          })
          const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0))
          const discountAmount = roundMoney(lines.reduce((sum, line) => sum + line.discountAmount, 0))
          const taxAmount = roundMoney(lines.reduce((sum, line) => sum + (line.variant.taxable ? line.lineTotal * line.variant.taxRate : 0), 0))
          const totalAmount = roundMoney(subtotal - discountAmount + taxAmount)
          const createdAt = atIstHour(day, 10 + ((saleIndex + dayIndex) % 8))
          const id = stableUuid(`sale:main:${store.key}:${dateKey(day)}:${saleIndex}`)
          const methods: Array<'cash' | 'card' | 'check' | 'upi'> = ['cash', 'card', 'upi', 'cash', 'check']
          const method = methods[(saleIndex + dayIndex) % methods.length]
          const split = saleIndex % 9 === 0
          const half = roundMoney(totalAmount / 2)
          const payments = split
            ? [
                { method: 'cash' as const, amount: half, referenceCode: null },
                { method: 'upi' as const, amount: roundMoney(totalAmount - half), referenceCode: `QA-UPI-${dateKey(day)}-${saleIndex}` },
              ]
            : [{ method, amount: totalAmount, referenceCode: method === 'cash' ? null : `QA-${method.toUpperCase()}-${dateKey(day)}-${saleIndex}` }]
          const plan: SalePlan = {
            id,
            clientSaleId: stableUuid(`client-sale:main:${store.key}:${dateKey(day)}:${saleIndex}`),
            store,
            storeId,
            shiftId,
            staffId,
            customerId: customers[(dayIndex * 3 + saleIndex + (mainStoreIndex.get(store.key) ?? 0)) % customers.length] ?? null,
            createdAt,
            source: saleIndex % 17 === 0 ? 'import' : 'pos',
            lines,
            subtotal,
            discountAmount,
            taxAmount,
            totalAmount,
            payments,
          }
          if ((dayIndex + saleIndex + (mainStoreIndex.get(store.key) ?? 0)) % 197 === 0 && lines[0].variant.unit === 'piece') {
            plan.returnedLine = lines[0]
          }
          salePlans.push(plan)
          const cash = payments.filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + payment.amount, 0)
          const shift = shiftMeta.get(shiftId)!
          shift.cashCollected = roundMoney(shift.cashCollected + cash)
        }
        dayIndex += 1
      }
    }

    const shiftRows: unknown[][] = [...shiftMeta.entries()].map(([id, shift], index) => {
      const startingCash = 5000 + ((mainStoreIndex.get(shift.store.key) ?? 0) * 250)
      const variance = index % 41 === 0 ? -50 : index % 67 === 0 ? 100 : 0
      return [id, mainTenantId, shift.storeId, shift.staffId, startingCash, atIstHour(shift.day, 9), roundMoney(startingCash + shift.cashCollected + variance), variance, atIstHour(shift.day, 21), shift.terminalId]
    })
    const activeShiftId = stableUuid('shift:main:active')
    shiftRows.push([activeShiftId, mainTenantId, mainStoreIds.get('S1'), stableUuid('staff:main:cashier-s1-a'), 5000, new Date(), null, null, null, stableUuid('terminal:main:S1:1')])

    const initialStockRows: unknown[][] = []
    const boundaryVariants = variants.filter((variant) => variant.productKey === 'BOUNDARY')
    const stockSeedVariants = [...activeVariants, ...boundaryVariants.filter((variant) => !activeVariants.includes(variant))]
    for (const store of MAIN_STORES) {
      if (store.counters === 0) continue
      const managerId = managerByStore.get(store.key)!
      for (const variant of stockSeedVariants) {
        if (variant.productKey === 'BOUNDARY' && store.key !== 'S10') continue
        const planned = plannedUnits.get(`${store.key}:${variant.id}`) ?? 0
        let quantity = Math.ceil(planned * 1.1 + variant.threshold)
        if (store.key === 'S9') quantity = variant.productKey === 'BOUNDARY' ? 8 : 3
        if (store.key === 'S4' && variant.productKey === 'ZERO') quantity = 0
        if (store.key === 'S3' && variant.productKey === 'ZERO') quantity = Math.max(0, Math.ceil(planned - 2))
        if (variant.productKey === 'BOUNDARY') quantity = Math.ceil(planned + variant.threshold)
        if (store.key === 'S10' && variant.productKey === 'BOUNDARY') {
          const boundaryOffset = variant.sku.endsWith('-01') ? 0 : variant.sku.endsWith('-02') ? -1 : 1
          quantity = variant.threshold + boundaryOffset
        }
        initialStockRows.push([
          stableUuid(`movement:opening:main:${store.key}:${variant.id}`),
          mainTenantId,
          mainStoreIds.get(store.key),
          variant.id,
          'receive',
          quantity,
          null,
          `QA seed opening stock for ${store.key}`,
          null,
          managerId,
          store.starts,
        ])
      }
    }

    const saleRows = salePlans.map((sale) => [sale.id, mainTenantId, sale.storeId, sale.clientSaleId, sale.shiftId, sale.customerId, sale.subtotal, sale.discountAmount, sale.taxAmount, sale.totalAmount, 'completed', sale.staffId, sale.createdAt, sale.source, { qaSeed: QA_SEED, scenario: sale.returnedLine ? 'return-candidate' : 'historical-sale' }, sale.source === 'import' ? stableUuid('import:main:historical-sales') : null])
    const saleLineRows = salePlans.flatMap((sale) => sale.lines.map((line) => [line.id, mainTenantId, sale.id, line.variant.id, line.quantity, line.unitPrice, line.discountAmount > 0 ? roundMoney((line.discountAmount / (line.unitPrice * line.quantity)) * 100) : null, line.discountAmount, line.variant.taxable, line.variant.taxRate, line.lineTotal, sale.createdAt]))
    const paymentRows = salePlans.flatMap((sale) => sale.payments.map((payment, index) => [stableUuid(`payment:main:${sale.id}:${index}`), mainTenantId, sale.id, payment.method, 'payment', payment.amount, payment.referenceCode, sale.staffId, sale.createdAt]))
    const saleMovementRows = salePlans.flatMap((sale) => sale.lines.map((line) => [stableUuid(`movement:sale:${sale.id}:${line.id}`), mainTenantId, sale.storeId, line.variant.id, 'sale', -line.quantity, null, `QA historical sale ${sale.id}`, sale.id, sale.staffId, sale.createdAt]))
    const returnMovementRows = salePlans.filter((sale) => sale.returnedLine).map((sale) => [stableUuid(`movement:return:${sale.id}`), mainTenantId, sale.storeId, sale.returnedLine!.variant.id, 'return', sale.returnedLine!.quantity, null, 'QA historical customer return', sale.id, sale.staffId, addDays(sale.createdAt, 2)])
    const refundRows = salePlans.filter((sale) => sale.returnedLine).map((sale) => [stableUuid(`payment:refund:${sale.id}`), mainTenantId, sale.id, sale.payments[0].method, 'refund', sale.returnedLine!.lineTotal, sale.payments[0].referenceCode ? `QA-REFUND-${sale.id.slice(0, 8)}` : null, sale.staffId, addDays(sale.createdAt, 2)])

    const importBatchId = stableUuid('import:main:historical-sales')
    const importRows = [[importBatchId, mainTenantId, 'sales', 'QA-historical-sales.csv', stableUuid('hash:main:historical-sales'), 512000, 'receipt_no,date,sku,quantity,amount', JSON.stringify(['receipt_no', 'date', 'sku', 'quantity', 'amount']), salePlans.filter((sale) => sale.source === 'import').length, { saleSource: 'historical', qaSeed: QA_SEED }, 'committed', { importedRows: salePlans.filter((sale) => sale.source === 'import').length }, null, new Date(), stableUuid('staff:main:manager-s1'), START_DATE]]

    const supplierProductRows = variants.map((variant, index) => {
      const supplierKey = supplierSpecs[index % supplierSpecs.length][0]
      return [stableUuid(`supplier-product:main:${variant.id}`), mainTenantId, supplierIds.get(supplierKey), variant.id, true, Number(supplierSpecs[index % supplierSpecs.length][5]), roundMoney(variant.price * 0.48), `SUP-${supplierKey}-${variant.sku}`, variant.unit === 'metre' ? 10 : 2, START_DATE]
    })

    const priceOverrideRows = [
      [variants[0].id, mainStoreIds.get('S1'), mainTenantId, 1399, new Date()],
      [variants[0].id, mainStoreIds.get('S2'), mainTenantId, 1199, new Date()],
      [variants[8].id, mainStoreIds.get('S10'), mainTenantId, 2699, new Date()],
    ]

    const poRows: unknown[][] = []
    const poLineRows: unknown[][] = []
    const receiptRows: unknown[][] = []
    const receiptLineRows: unknown[][] = []
    const poConfigs = [
      { key: 'received', store: 'S1', supplier: 'SUP-A', status: 'sent', quantity: 80, received: 80 },
      { key: 'partial', store: 'S2', supplier: 'SUP-B', status: 'sent', quantity: 60, received: 25 },
      { key: 'sent', store: 'S9', supplier: 'SUP-F', status: 'sent', quantity: 40, received: 0 },
      { key: 'cancelled', store: 'S3', supplier: 'SUP-G', status: 'cancelled', quantity: 20, received: 0 },
    ] as const
    for (const config of poConfigs) {
      const poId = stableUuid(`po:main:${config.key}`)
      const variant = variants.find((candidate) => candidate.productKey === (config.key === 'sent' ? 'BOUNDARY' : 'KURTA')) ?? variants[0]
      const lineId = stableUuid(`po-line:main:${config.key}`)
      const receiptId = stableUuid(`po-receipt:main:${config.key}`)
      const receivedAt = new Date(Date.UTC(2026, 7, 5))
      poRows.push([poId, mainTenantId, mainStoreIds.get(config.store), supplierIds.get(config.supplier), `QA-PO-${config.key.toUpperCase()}`, config.status, new Date(Date.UTC(2026, 7, 20)), `QA seed ${config.key} purchase order`, managerByStore.get(config.store), new Date(Date.UTC(2026, 6, 20))])
      poLineRows.push([lineId, mainTenantId, poId, variant.id, config.quantity, 0, roundMoney(variant.price * 0.45), new Date(Date.UTC(2026, 6, 20))])
      if (config.received > 0) {
        receiptRows.push([receiptId, mainTenantId, mainStoreIds.get(config.store), poId, stableUuid(`po-receipt-client:main:${config.key}`), receivedAt, managerByStore.get(config.store), `QA ${config.key} receipt`])
        receiptLineRows.push([stableUuid(`po-receipt-line:main:${config.key}`), mainTenantId, receiptId, lineId, variant.id, config.received, roundMoney(variant.price * 0.45), receivedAt])
      }
    }

    const reorderRows = [
      [stableUuid('reorder:main:S1:forecast'), mainTenantId, mainStoreIds.get('S1'), variants.find((variant) => variant.productKey === 'KURTA')!.id, supplierIds.get('SUP-A'), 24, { qaSeed: QA_SEED, basis: '30-day demand', onOrder: 0, stock: 3 }, 'forecast', 'high', new Date()],
      [stableUuid('reorder:main:S2:heuristic'), mainTenantId, mainStoreIds.get('S2'), variants.find((variant) => variant.productKey === 'BOUNDARY')!.id, supplierIds.get('SUP-B'), 18, { qaSeed: QA_SEED, basis: 'heuristic', onOrder: 25, stock: 2 }, 'heuristic', 'medium', new Date()],
      [stableUuid('reorder:main:S9:borrowed'), mainTenantId, mainStoreIds.get('S9'), variants.find((variant) => variant.productKey === 'ZERO')!.id, supplierIds.get('SUP-C'), 10, { qaSeed: QA_SEED, basis: 'other_stores', borrowedFrom: 'S1', localHistoryDays: 0 }, 'heuristic', 'low', new Date()],
    ]

    const notificationRows = MAIN_STORES.filter((store) => store.key !== 'S7').map((store, index) => [stableUuid(`notification:main:${store.key}`), mainTenantId, mainStoreIds.get(store.key), 'stock_low', `QA low stock alert - ${store.key}`, `P4 is low or unavailable in ${store.name}.`, '/app/inventory', { qaSeed: QA_SEED, store: store.key }, index % 2 === 0 ? null : new Date(), addDays(END_DATE, 1)])
    const emailLogRows = [
      [stableUuid('email-log:main:sent'), mainTenantId, 'receipt', 'qa.customer.001@example.test', 'QA receipt', 'sent', 'qa-provider-sent', null, salePlans[0].id, 1, salePlans[0].createdAt, salePlans[0].createdAt, null, null, salePlans[0].createdAt],
      [stableUuid('email-log:main:failed'), mainTenantId, 'receipt', 'qa.customer.017@example.test', 'QA receipt', 'failed', null, 'QA provider failure scenario', salePlans[1].id, 1, salePlans[1].createdAt, null, salePlans[1].createdAt, null, salePlans[1].createdAt],
      [stableUuid('email-log:main:suppressed'), mainTenantId, 'receipt', 'qa.customer.034@example.test', 'QA receipt', 'suppressed', null, 'QA bounce suppression scenario', salePlans[2].id, 0, null, null, null, null, salePlans[2].createdAt],
    ]
    const suppressionRows = [
      [stableUuid('suppression:main:unsubscribe'), mainTenantId, 'qa.customer.017@example.test', 'unsubscribed', 'QA marketing unsubscribe scenario', START_DATE],
      [stableUuid('suppression:main:bounce'), mainTenantId, 'qa.customer.034@example.test', 'bounced', 'QA hard bounce scenario', START_DATE],
    ]

    const invoiceRows: unknown[][] = []
    const invoiceLineRows: unknown[][] = []
    const creditNoteRows: unknown[][] = []
    const creditNoteLineRows: unknown[][] = []
    const sequenceNext = new Map<string, number>()
    const invoiceBySaleId = new Map<UUID, { id: UUID; lineIds: Map<UUID, UUID>; number: string; fy: string; seq: number }>()
    const invoiceCandidates = salePlans.filter((sale, index) => index % 25 === 0 || Boolean(sale.returnedLine))
    for (const sale of invoiceCandidates) {
      const fy = financialYear(sale.createdAt)
      const sequenceKey = `${sale.storeId}:tax_invoice:${fy}`
      const sequence = sequenceNext.get(sequenceKey) ?? 1
      sequenceNext.set(sequenceKey, sequence + 1)
      const invoiceId = stableUuid(`tax-invoice:${sale.id}`)
      const prefix = MAIN_STORES.find((store) => store.key === sale.store.key) ? `Q${mainStoreIndex.get(sale.store.key)! + 1}` : 'QA'
      const documentNumber = `${prefix}-${fy.replace('-', '')}-${String(sequence).padStart(4, '0')}`
      const customerIndex = sale.customerId ? customers.indexOf(sale.customerId) : -1
      const lineIds = new Map<UUID, UUID>()
      const cgst = roundMoney(sale.taxAmount / 2)
      const taxableWeight = sale.lines.reduce((sum, line) => sum + (line.variant.taxable ? line.lineTotal * line.variant.taxRate : 0), 0)
      const invoiceLineValues = sale.lines.map((line, index) => {
        const lineId = stableUuid(`tax-invoice-line:${sale.id}:${line.id}`)
        lineIds.set(line.id, lineId)
        const lineTax = line.variant.taxable ? roundMoney((line.lineTotal * line.variant.taxRate / taxableWeight) * sale.taxAmount) : 0
        return [lineId, mainTenantId, invoiceId, index + 1, line.id, null, line.variant.id, `${line.variant.productName} ${line.variant.size ?? ''}`.trim(), line.variant.sku, line.variant.hsnSac, line.variant.unit, line.quantity, line.unitPrice, roundMoney(line.unitPrice * line.quantity), line.discountAmount, line.variant.taxable ? line.lineTotal : 0, line.variant.taxable ? line.variant.taxRate * 100 : 0, line.variant.taxable ? roundMoney(lineTax / 2) : 0, line.variant.taxable ? roundMoney(lineTax - roundMoney(lineTax / 2)) : 0, 0, 0, roundMoney(line.lineTotal + lineTax)]
      })
      invoiceLineRows.push(...invoiceLineValues)
      invoiceRows.push([
        invoiceId,
        mainTenantId,
        sale.storeId,
        'tax_invoice',
        fy,
        sequence,
        documentNumber,
        sale.createdAt,
        sale.id,
        sale.customerId,
        null,
        null,
        { businessName: 'QA - Anvaya Fashion House', store: sale.store.name, gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
        customerIndex >= 0 ? { name: `QA Customer ${String(customerIndex + 1).padStart(3, '0')}`, stateCode: 'KA' } : null,
        { state: 'Karnataka', stateCode: '29', isInterState: false },
        JSON.stringify(sale.payments),
        sale.subtotal,
        sale.discountAmount,
        roundMoney(sale.lines.reduce((sum, line) => sum + (line.variant.taxable ? line.lineTotal : 0), 0)),
        cgst,
        roundMoney(sale.taxAmount - cgst),
        0,
        0,
        0,
        sale.totalAmount,
        sale.staffId,
        sale.createdAt,
      ])
      invoiceBySaleId.set(sale.id, { id: invoiceId, lineIds, number: documentNumber, fy, seq: sequence })
    }
    for (const sale of salePlans.filter((candidate) => candidate.returnedLine && invoiceBySaleId.has(candidate.id))) {
      const invoice = invoiceBySaleId.get(sale.id)!
      const returnedLine = sale.returnedLine!
      const sequenceKey = `${sale.storeId}:credit_note:${invoice.fy}`
      const sequence = sequenceNext.get(sequenceKey) ?? 1
      sequenceNext.set(sequenceKey, sequence + 1)
      const creditId = stableUuid(`tax-credit-note:${sale.id}`)
      const returnReferenceId = stableUuid(`return-reference:${sale.id}`)
      const documentNumber = `C${mainStoreIndex.get(sale.store.key)! + 1}-${invoice.fy.replace('-', '')}-${String(sequence).padStart(4, '0')}`
      const originalLineId = invoice.lineIds.get(returnedLine.id)!
      const refundTax = returnedLine.variant.taxable ? roundMoney(returnedLine.lineTotal * returnedLine.variant.taxRate) : 0
      const refundTotal = roundMoney(returnedLine.lineTotal + refundTax)
      creditNoteRows.push([
        creditId,
        mainTenantId,
        sale.storeId,
        'credit_note',
        invoice.fy,
        sequence,
        documentNumber,
        addDays(sale.createdAt, 2),
        sale.id,
        sale.customerId,
        returnReferenceId,
        invoice.id,
        { businessName: 'QA - Anvaya Fashion House', store: sale.store.name, gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
        null,
        { state: 'Karnataka', stateCode: '29', isInterState: false },
        JSON.stringify([{ method: sale.payments[0].method, direction: 'refund', amount: refundTotal, referenceCode: `QA-REFUND-${sale.id.slice(0, 8)}` }]),
        returnedLine.lineTotal,
        0,
        returnedLine.variant.taxable ? returnedLine.lineTotal : 0,
        returnedLine.variant.taxable ? roundMoney(refundTax / 2) : 0,
        returnedLine.variant.taxable ? roundMoney(refundTax - roundMoney(refundTax / 2)) : 0,
        0,
        0,
        0,
        refundTotal,
        sale.staffId,
        addDays(sale.createdAt, 2),
      ])
      creditNoteLineRows.push([
        stableUuid(`tax-credit-note-line:${sale.id}`),
        mainTenantId,
        creditId,
        1,
        null,
        originalLineId,
        returnedLine.variant.id,
        `${returnedLine.variant.productName} ${returnedLine.variant.size ?? ''}`.trim(),
        returnedLine.variant.sku,
        returnedLine.variant.hsnSac,
        returnedLine.variant.unit,
        returnedLine.quantity,
        returnedLine.unitPrice,
        roundMoney(returnedLine.unitPrice * returnedLine.quantity),
        returnedLine.discountAmount,
        returnedLine.variant.taxable ? returnedLine.lineTotal : 0,
        returnedLine.variant.taxable ? returnedLine.variant.taxRate * 100 : 0,
        returnedLine.variant.taxable ? roundMoney(refundTax / 2) : 0,
        returnedLine.variant.taxable ? roundMoney(refundTax - roundMoney(refundTax / 2)) : 0,
        0,
        0,
        refundTotal,
      ])
    }
    const sequenceRows = [...sequenceNext.entries()].map(([key, next]) => {
      const [storeId, documentType, fy] = key.split(':')
      return [mainTenantId, storeId, documentType, fy, next]
    })

    const setupRows = MAIN_STORES.map((store) => [mainTenantId, mainStoreIds.get(store.key), store.key === 'S7' ? null : 'staffed', store.key === 'S7' ? null : 'verified', store.key === 'S7' ? null : new Date(), store.key === 'S7' ? null : variants[0].id, START_DATE, new Date()])

    await db.query('BEGIN')
    await db.query("SET LOCAL statement_timeout = '900s'")
    await insertRows(db, 'tenants', ['id', 'business_name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'tax_id', 'discount_threshold_percent', 'tax_rate_state', 'tax_rate_county', 'tax_rate_city', 'tax_rate_district', 'tax_rounding_basis', 'onboarding_data', 'onboarding_step', 'onboarding_completed_at', 'timezone', 'trade_name', 'gst_status', 'pan', 'place_of_supply', 'business_type', 'barcode_label_format'], tenantRows)
    await insertRows(db, 'billing_subscriptions', ['id', 'tenant_id', 'attempt_id', 'provider', 'provider_subscription_id', 'provider_plan_id', 'region', 'plan_key', 'billing_cycle', 'currency', 'base_amount_minor', 'tax_amount_minor', 'total_amount_minor', 'tax_rate_bps', 'included_store_count', 'additional_store_count', 'status', 'entitlement_status', 'cancel_at_cycle_end', 'current_start_at', 'current_end_at', 'grace_until_at', 'last_payment_id', 'last_invoice_id', 'provider_payload', 'created_at', 'updated_at'], subscriptionRows)
    await insertRows(db, 'stores', ['id', 'tenant_id', 'name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'is_active', 'created_at', 'tax_rate_state', 'tax_rate_county', 'tax_rate_city', 'tax_rate_district', 'tax_rounding_basis', 'place_of_supply', 'invoice_prefix', 'invoice_start_number'], storeRows)
    await insertRows(db, 'categories', ['id', 'tenant_id', 'name', 'sort_order', 'created_at'], [...categoriesRows, ...isolationCategoryRows])
    await insertRows(db, 'products', ['id', 'tenant_id', 'name', 'created_at', 'category_id'], [...productRows, ...isolationProductRows])
    await insertRows(db, 'variants', ['id', 'tenant_id', 'product_id', 'sku', 'size', 'color', 'material', 'price', 'reorder_threshold', 'identity_locked', 'created_at', 'is_taxable', 'tax_rate', 'moving_average_cost', 'source_metadata', 'unit_of_measure', 'barcode'], [...variantRows, ...isolationVariantRows])
    await insertRows(db, 'staff_members', ['id', 'tenant_id', 'store_id', 'user_id', 'name', 'role', 'email', 'pin_hash', 'pin_attempts', 'pin_locked_until', 'pin_must_change', 'is_active', 'created_at'], staffRows)
    await insertRows(db, 'terminals', ['id', 'tenant_id', 'store_id', 'name', 'is_active', 'created_at', 'cash_mode', 'device_token_hash', 'device_paired_at', 'device_last_seen_at'], terminalRows)
    await insertRows(db, 'customers', ['id', 'tenant_id', 'name', 'phone', 'email', 'billing_name', 'gstin', 'address_line1', 'address_line2', 'city', 'state_code', 'postal_code', 'country', 'notes', 'created_at', 'updated_at'], customerRows)
    await insertRows(db, 'suppliers', ['id', 'tenant_id', 'name', 'contact_name', 'email', 'phone', 'lead_time_days', 'payment_terms', 'is_active', 'created_at'], supplierRows)
    await insertRows(db, 'supplier_products', ['id', 'tenant_id', 'supplier_id', 'variant_id', 'is_primary', 'lead_time_days', 'unit_cost', 'supplier_sku', 'min_order_qty', 'created_at'], supplierProductRows)
    await insertRows(db, 'variant_store_prices', ['variant_id', 'store_id', 'tenant_id', 'price', 'updated_at'], priceOverrideRows)
    await insertRows(db, 'import_batches', ['id', 'tenant_id', 'kind', 'file_name', 'file_hash', 'file_size_bytes', 'source_text', 'source_columns', 'row_count', 'mapping', 'status', 'summary', 'error_message', 'committed_at', 'created_by', 'created_at'], importRows)
    await insertRows(db, 'shifts', ['id', 'tenant_id', 'store_id', 'staff_id', 'starting_cash', 'opened_at', 'counted_cash', 'variance', 'closed_at', 'terminal_id'], shiftRows)
    await insertRows(db, 'stock_movements', ['id', 'tenant_id', 'store_id', 'variant_id', 'movement_type', 'quantity_delta', 'reason_code', 'reason_note', 'reference_id', 'created_by', 'created_at'], initialStockRows)
    await insertRows(db, 'sales', ['id', 'tenant_id', 'store_id', 'client_sale_id', 'shift_id', 'customer_id', 'subtotal', 'discount_amount', 'tax_amount', 'total_amount', 'status', 'created_by', 'created_at', 'source', 'source_metadata', 'import_batch_id'], saleRows)
    await insertRows(db, 'sale_line_items', ['id', 'tenant_id', 'sale_id', 'variant_id', 'quantity', 'unit_price', 'discount_percent', 'discount_amount', 'is_taxable', 'tax_rate', 'line_total', 'created_at'], saleLineRows)
    await insertRows(db, 'payments', ['id', 'tenant_id', 'sale_id', 'method', 'direction', 'amount', 'reference_code', 'created_by', 'created_at'], [...paymentRows, ...refundRows])
    await insertRows(db, 'stock_movements', ['id', 'tenant_id', 'store_id', 'variant_id', 'movement_type', 'quantity_delta', 'reason_code', 'reason_note', 'reference_id', 'created_by', 'created_at'], [...saleMovementRows, ...returnMovementRows])
    await insertRows(db, 'purchase_orders', ['id', 'tenant_id', 'store_id', 'supplier_id', 'po_number', 'status', 'expected_date', 'notes', 'created_by', 'created_at'], poRows)
    await insertRows(db, 'purchase_order_lines', ['id', 'tenant_id', 'purchase_order_id', 'variant_id', 'quantity_ordered', 'quantity_received', 'unit_cost', 'created_at'], poLineRows)
    await insertRows(db, 'purchase_order_receipts', ['id', 'tenant_id', 'store_id', 'purchase_order_id', 'client_receipt_id', 'received_at', 'created_by', 'note'], receiptRows)
    await insertRows(db, 'purchase_order_receipt_lines', ['id', 'tenant_id', 'receipt_id', 'purchase_order_line_id', 'variant_id', 'quantity_received', 'unit_cost', 'created_at'], receiptLineRows)
    await insertRows(db, 'reorder_suggestions', ['id', 'tenant_id', 'store_id', 'variant_id', 'supplier_id', 'suggested_quantity', 'reason', 'method', 'confidence', 'generated_at'], reorderRows)
    await insertRows(db, 'notifications', ['id', 'tenant_id', 'store_id', 'type', 'title', 'body', 'link', 'metadata', 'read_at', 'created_at'], notificationRows)
    await insertRows(db, 'email_log', ['id', 'tenant_id', 'kind', 'recipient', 'subject', 'status', 'provider_message_id', 'error_message', 'sale_id', 'attempts', 'last_attempt_at', 'delivered_at', 'failed_at', 'created_by', 'created_at'], emailLogRows)
    await insertRows(db, 'email_suppressions', ['id', 'tenant_id', 'email', 'reason', 'detail', 'created_at'], suppressionRows)
    await insertRows(db, 'tax_documents', ['id', 'tenant_id', 'store_id', 'document_type', 'financial_year', 'sequence_number', 'document_number', 'document_date', 'sale_id', 'customer_id', 'return_reference_id', 'original_document_id', 'seller_snapshot', 'buyer_snapshot', 'place_of_supply_snapshot', 'payment_snapshot', 'subtotal', 'discount_total', 'taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'cess_total', 'rounding_amount', 'grand_total', 'created_by', 'created_at'], [...invoiceRows, ...creditNoteRows])
    await insertRows(db, 'tax_document_lines', ['id', 'tenant_id', 'document_id', 'line_number', 'sale_line_item_id', 'original_line_id', 'variant_id', 'description', 'sku', 'hsn_sac', 'unit', 'quantity', 'unit_price', 'gross_value', 'discount_value', 'taxable_value', 'gst_rate', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'line_total'], [...invoiceLineRows, ...creditNoteLineRows])
    await insertRows(db, 'tax_document_sequences', ['tenant_id', 'store_id', 'document_type', 'financial_year', 'next_number'], sequenceRows)
    await insertRows(db, 'store_setup_progress', ['tenant_id', 'store_id', 'team_mode', 'scanner_choice', 'scanner_verified_at', 'scanner_variant_id', 'created_at', 'updated_at'], setupRows)

    await db.query(`UPDATE public.purchase_orders po SET status = CASE WHEN EXISTS (SELECT 1 FROM public.purchase_order_receipts r WHERE r.purchase_order_id = po.id) AND EXISTS (SELECT 1 FROM public.purchase_order_lines l WHERE l.purchase_order_id = po.id AND l.quantity_received < l.quantity_ordered) THEN 'partial'::public.purchase_order_status WHEN EXISTS (SELECT 1 FROM public.purchase_order_receipts r WHERE r.purchase_order_id = po.id) THEN 'received'::public.purchase_order_status ELSE po.status END WHERE po.tenant_id = $1`, [mainTenantId])
    await db.query('COMMIT')

    const counts = await db.query(`
      SELECT json_build_object(
        'tenants', (SELECT count(*) FROM public.tenants WHERE id IN ($1::uuid,$2::uuid,$3::uuid)),
        'stores', (SELECT count(*) FROM public.stores WHERE tenant_id = $1),
        'terminals', (SELECT count(*) FROM public.terminals WHERE tenant_id = $1),
        'staff', (SELECT count(*) FROM public.staff_members WHERE tenant_id = $1),
        'products', (SELECT count(*) FROM public.products WHERE tenant_id = $1),
        'variants', (SELECT count(*) FROM public.variants WHERE tenant_id = $1),
        'customers', (SELECT count(*) FROM public.customers WHERE tenant_id = $1),
        'shifts', (SELECT count(*) FROM public.shifts WHERE tenant_id = $1),
        'sales', (SELECT count(*) FROM public.sales WHERE tenant_id = $1),
        'saleLines', (SELECT count(*) FROM public.sale_line_items WHERE tenant_id = $1),
        'payments', (SELECT count(*) FROM public.payments WHERE tenant_id = $1),
        'stockMovements', (SELECT count(*) FROM public.stock_movements WHERE tenant_id = $1),
        'purchaseOrders', (SELECT count(*) FROM public.purchase_orders WHERE tenant_id = $1),
        'taxDocuments', (SELECT count(*) FROM public.tax_documents WHERE tenant_id = $1),
        'reorderSuggestions', (SELECT count(*) FROM public.reorder_suggestions WHERE tenant_id = $1)
      ) AS summary
    `, [mainTenantId, isolationATenantId, isolationBTenantId])

    console.log(JSON.stringify({
      project: PROJECT_REF,
      seed: QA_SEED,
      ownerEmail: OWNER_EMAIL,
      isolationEmails: [ISOLATION_A_EMAIL, ISOLATION_B_EMAIL],
      otp: 'Request a fresh OTP for the email account; it is never fixed.',
      pins: PIN,
      mainTenantId,
      stores: MAIN_STORES.map((store) => ({ name: store.name, key: store.key, counters: store.counters, active: store.active })),
      counts: counts.rows[0]?.summary,
      authUsersCreated: { owner: ownerAuth.created, isolationA: isolationAAuth.created, isolationB: isolationBAuth.created },
    }, null, 2))
  } catch (error) {
    try {
      await db.query('ROLLBACK')
    } catch {
      // The original error is more useful than a rollback error.
    }
    throw error
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
