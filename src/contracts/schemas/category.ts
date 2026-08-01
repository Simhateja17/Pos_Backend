import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const CategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    sortOrder: z.number().int(),
    /** How many products currently sit in this category — deletion needs it. */
    productCount: z.number().int(),
    createdAt: z.string(),
  })
  .openapi('Category')

export const CreateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('CreateCategoryRequest')

export const UpdateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('UpdateCategoryRequest')

/**
 * The kinds of shop we can seed a starter category list for.
 *
 * This exists ONLY to pick that starter list. It gates no feature, changes no
 * tax behaviour, and is skippable — which is the difference between it and the
 * vertical picker that was removed for promising GST/HSN/catalog configuration
 * it never delivered.
 */
export const BusinessTypeSchema = z
  .enum(['supermarket', 'grocery', 'bakery', 'general', 'apparel', 'electronics', 'other'])
  .openapi('BusinessType')

export type BusinessType = z.infer<typeof BusinessTypeSchema>

/**
 * Starter categories per shop type. Deliberately short — a list the owner will
 * actually read and edit, not an exhaustive taxonomy they have to prune.
 * Every one of these is editable and deletable the moment they land.
 */
export const STARTER_CATEGORIES: Record<BusinessType, readonly string[]> = {
  supermarket: [
    'Rice, Atta & Grains', 'Pulses & Dals', 'Spices & Masalas', 'Cooking Oil & Ghee',
    'Dairy', 'Snacks & Namkeen', 'Beverages', 'Personal Care', 'Household Cleaning',
    'Kitchen & Utensils', 'Frozen & Ready-to-Eat', 'Baby Care',
  ],
  grocery: [
    'Rice, Atta & Grains', 'Pulses & Dals', 'Spices & Masalas', 'Cooking Oil & Ghee',
    'Dairy', 'Snacks & Namkeen', 'Beverages', 'Personal Care', 'Household Cleaning',
    'Kitchen & Utensils',
  ],
  bakery: ['Breads & Buns', 'Cakes & Pastries', 'Cookies & Biscuits', 'Savouries & Puffs', 'Sweets', 'Beverages'],
  general: [
    'Rice, Atta & Grains', 'Dairy', 'Spices & Masalas', 'Cooking Oil & Ghee', 'Snacks & Namkeen',
    'Beverages', 'Personal Care', 'Household Cleaning', 'Kitchen & Utensils', 'Stationery',
  ],
  apparel: [
    'Shirts', 'T-Shirts', 'Trousers', 'Jeans', 'Kurtas', 'Kurta Sets', 'Sarees',
    'Ethnic Wear', 'Footwear', 'Accessories',
  ],
  electronics: ['Mobiles', 'Accessories', 'Audio', 'Computing', 'Home Appliances'],
  other: [],
}

export const SeedCategoriesSchema = z
  .object({ businessType: BusinessTypeSchema })
  .strict()
  .openapi('SeedCategoriesRequest')

export type Category = z.infer<typeof CategorySchema>
export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>
export type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>
