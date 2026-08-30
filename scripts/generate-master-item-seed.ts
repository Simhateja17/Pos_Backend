import fs from 'node:fs'
import path from 'node:path'

type Unit = 'piece' | 'kg' | 'gram' | 'litre' | 'ml' | 'metre' | 'box' | 'pack' | 'set' | 'pair'
type Pack = readonly [number, Unit]
type Family = {
  category: string
  subcategory: string
  name: string
  brands: Array<string | null>
  packs: Pack[]
  aliases?: string[]
  sellUnit?: Unit
}

const brandList = (value: string): Array<string | null> => value.split('|').map((brand) => brand.trim()).filter(Boolean)
const ml = (...sizes: number[]): Pack[] => sizes.map((size) => [size, 'ml'] as const)
const litres = (...sizes: number[]): Pack[] => sizes.map((size) => [size, 'litre'] as const)
const grams = (...sizes: number[]): Pack[] => sizes.map((size) => [size, 'gram'] as const)
const kilograms = (...sizes: number[]): Pack[] => sizes.map((size) => [size, 'kg'] as const)
const pieces = (...sizes: number[]): Pack[] => sizes.map((size) => [size, 'piece'] as const)
const packs = (...sizes: number[]): Pack[] => sizes.map((size) => [size, 'pack'] as const)

function family(
  category: string,
  subcategory: string,
  name: string,
  brands: string | null,
  packSizes: Pack[],
  aliases: string[] = [],
  sellUnit: Unit = 'piece',
): Family {
  return {
    category,
    subcategory,
    name,
    brands: brands === null ? [null] : brandList(brands),
    packs: packSizes,
    aliases,
    sellUnit,
  }
}

// This is a curated identity catalog, not a manufacturer price or barcode
// database. Pack variants are intentionally kept separate so a shopkeeper who
// types "milk" can choose the exact pack they carry and enter local prices.
const families: Family[] = [
  // Dairy
  family('Dairy', 'Milk', 'Toned Milk', 'Amul|Nandini|Mother Dairy|Heritage|Aavin|Milma|Dodla|Jersey', [...ml(200, 500), ...litres(1, 2)], ['milk', 'doodh']),
  family('Dairy', 'Milk', 'Milk', 'Sangam', ml(250, 500), ['milk', 'sangam milk']),
  family('Dairy', 'Milk', 'Full Cream Milk', 'Amul|Nandini|Mother Dairy|Heritage|Aavin|Milma', [...ml(500), ...litres(1, 2)], ['milk', 'full fat milk']),
  family('Dairy', 'Milk', 'Double Toned Milk', 'Amul|Nandini|Mother Dairy|Heritage|Aavin', [...ml(500), ...litres(1, 2)], ['milk', 'low fat milk']),
  family('Dairy', 'Milk', 'Flavoured Milk', 'Amul|Milky Mist|Hatsun|Nandini|Heritage|Cavin’s|Dodla', [...ml(180, 200, 250, 500)], ['flavoured milk', 'milk drink']),
  family('Dairy', 'Curd', 'Curd', 'Amul|Nandini|Mother Dairy|Heritage|Milky Mist|Aavin|Milma|Hatsun', [...grams(200, 400, 500), ...kilograms(1)], ['curd', 'dahi', 'yogurt']),
  family('Dairy', 'Lassi', 'Sweet Lassi', 'Amul|Mother Dairy|Nandini|Heritage|Milky Mist|Hatsun|Madhusudan', [...ml(180, 200, 250)], ['lassi', 'sweet lassi']),
  family('Dairy', 'Paneer', 'Paneer', 'Amul|Mother Dairy|Nandini|Milky Mist|Gowardhan|Hatsun|Heritage', [...grams(100, 200, 500)], ['paneer', 'cottage cheese']),
  family('Dairy', 'Butter', 'Table Butter', 'Amul|Nandini|Mother Dairy|Britannia|Milky Mist|Gowardhan', [...grams(50, 100, 200, 500)], ['butter']),
  family('Dairy', 'Cheese', 'Cheese Slices', 'Amul|Britannia|Mother Dairy|Milky Mist|Gowardhan|Go', [...grams(100, 200, 400)], ['cheese', 'cheese slice']),
  family('Dairy', 'Ghee', 'Cow Ghee', 'Amul|Nandini|Mother Dairy|Patanjali|Gowardhan|Aashirvaad|Milky Mist|Anik', [...ml(200, 500), ...litres(1, 2)], ['ghee', 'cow ghee']),
  family('Dairy', 'Dairy Whitener', 'Dairy Whitener', 'Nestle|Amul|Everyday|Mother Dairy|Patanjali', [...grams(200, 500), ...kilograms(1)], ['milk powder', 'dairy whitener']),

  // Staples and pulses
  family('Staples', 'Flour', 'Whole Wheat Atta', 'Aashirvaad|Pillsbury|Fortune|Patanjali|Annapurna|Shakti Bhog|24 Mantra|Organic Tattva|Natureland', [...kilograms(1, 5, 10), ...grams(500)], ['atta', 'wheat flour']),
  family('Staples', 'Flour', 'Maida', 'Aashirvaad|Pillsbury|Fortune|Patanjali|Shakti Bhog|Natureland', [...grams(500), ...kilograms(1, 5)], ['maida', 'refined flour']),
  family('Staples', 'Flour', 'Besan', 'Tata Sampann|Aashirvaad|Pillsbury|Fortune|Patanjali|Shakti Bhog|24 Mantra', [...grams(500), ...kilograms(1, 2)], ['besan', 'gram flour']),
  family('Staples', 'Flour', 'Sooji Rava', 'Tata Sampann|Aashirvaad|Pillsbury|Fortune|MTR|Patanjali', [...grams(500), ...kilograms(1, 2)], ['sooji', 'rava', 'semolina']),
  family('Staples', 'Rice', 'Basmati Rice', 'India Gate|Daawat|Kohinoor|Lal Qilla|Fortune|Tata Sampann|Sharbati|Aeroplane', [...kilograms(1, 5, 10), ...grams(500)], ['rice', 'basmati']),
  family('Staples', 'Rice', 'Sona Masuri Rice', 'India Gate|Daawat|Fortune|Tata Sampann|24 Mantra|Organic Tattva', [...kilograms(1, 5, 10), ...grams(500)], ['rice', 'sona masuri']),
  family('Staples', 'Rice', 'Ponni Rice', 'India Gate|Daawat|Fortune|Double Horse|Manna', [...kilograms(1, 5, 10)], ['rice', 'ponni rice']),
  family('Staples', 'Poha', 'Thick Poha', 'Tata Sampann|Fortune|Patanjali|24 Mantra|Organic Tattva|Manna', [...grams(500), ...kilograms(1, 2)], ['poha', 'avalakki', 'flattened rice']),
  family('Staples', 'Breakfast Grains', 'Dalia', 'Tata Sampann|Aashirvaad|Patanjali|24 Mantra|Organic Tattva', [...grams(500), ...kilograms(1, 2)], ['dalia', 'broken wheat']),
  family('Staples', 'Pulses', 'Toor Dal', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva|Daawat|MTR', [...grams(500), ...kilograms(1, 2)], ['toor dal', 'tur dal', 'arhar dal']),
  family('Staples', 'Pulses', 'Moong Dal', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva|Daawat|MTR', [...grams(500), ...kilograms(1, 2)], ['moong dal', 'green gram']),
  family('Staples', 'Pulses', 'Masoor Dal', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva|Daawat', [...grams(500), ...kilograms(1, 2)], ['masoor dal', 'red lentils']),
  family('Staples', 'Pulses', 'Chana Dal', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva|Daawat', [...grams(500), ...kilograms(1, 2)], ['chana dal', 'split chickpeas']),
  family('Staples', 'Pulses', 'Urad Dal', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva|Daawat', [...grams(500), ...kilograms(1, 2)], ['urad dal', 'black gram']),
  family('Staples', 'Pulses', 'Rajma', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva', [...grams(500), ...kilograms(1, 2)], ['rajma', 'kidney beans']),
  family('Staples', 'Pulses', 'Kabuli Chana', 'Tata Sampann|Fortune|Aashirvaad|Patanjali|24 Mantra|Organic Tattva', [...grams(500), ...kilograms(1, 2)], ['kabuli chana', 'chickpeas']),
  family('Staples', 'Salt', 'Iodised Salt', 'Tata|Aashirvaad|Annapurna|Nirma|Patanjali|Catch|Saffola', [...grams(500), ...kilograms(1, 2)], ['salt', 'namak']),
  family('Staples', 'Sugar', 'Crystal Sugar', 'Madhur|Uttam|Fortune|Dhampur|Natureland|24 Mantra', [...kilograms(1, 5), ...grams(500)], ['sugar', 'chini']),
  family('Staples', 'Jaggery', 'Jaggery Powder', 'Patanjali|24 Mantra|Organic Tattva|Madhur|Natureland', [...grams(500), ...kilograms(1, 2)], ['jaggery', 'gur', 'shakkar']),

  // Cooking oils, spices, mixes and condiments
  family('Cooking', 'Cooking Oil', 'Sunflower Oil', 'Fortune|Saffola|Sundrop|Gemini|Freedom|Dhara|Gold Winner|Emami Healthy & Tasty', [...ml(500), ...litres(1, 2, 5)], ['oil', 'cooking oil', 'sunflower oil']),
  family('Cooking', 'Cooking Oil', 'Groundnut Oil', 'Fortune|Saffola|Dhara|Gulab|Idhayam|Gold Winner', [...ml(500), ...litres(1, 2, 5)], ['oil', 'groundnut oil', 'peanut oil']),
  family('Cooking', 'Cooking Oil', 'Mustard Oil', 'Fortune|Dhara|Emami Healthy & Tasty|P Mark|Engine|Gulab', [...ml(500), ...litres(1, 2, 5)], ['oil', 'mustard oil', 'sarson oil']),
  family('Cooking', 'Cooking Oil', 'Rice Bran Oil', 'Fortune|Saffola|Freedom|Emami Healthy & Tasty|Gemini|Dhara', [...ml(500), ...litres(1, 2, 5)], ['oil', 'rice bran oil']),
  family('Cooking', 'Cooking Oil', 'Coconut Oil', 'Parachute|Idhayam|KLF Nirmal|Maxcare|Shalimar', [...ml(100, 200, 500), ...litres(1)], ['oil', 'coconut oil']),
  family('Cooking', 'Cooking Oil', 'Blended Cooking Oil', 'Fortune|Saffola|Sundrop|Gemini|Freedom|Dhara', [...ml(500), ...litres(1, 2)], ['oil', 'blended oil']),
  family('Cooking', 'Spices', 'Turmeric Powder', 'Everest|Catch|Tata Sampann|MDH|Badshah|Aashirvaad|Eastern|Sakthi', [...grams(50, 100, 200)], ['turmeric', 'haldi']),
  family('Cooking', 'Spices', 'Red Chilli Powder', 'Everest|Catch|Tata Sampann|MDH|Badshah|Aashirvaad|Eastern|Sakthi', [...grams(50, 100, 200)], ['chilli powder', 'mirchi']),
  family('Cooking', 'Spices', 'Coriander Powder', 'Everest|Catch|Tata Sampann|MDH|Badshah|Aashirvaad|Eastern', [...grams(50, 100, 200)], ['coriander powder', 'dhania']),
  family('Cooking', 'Spices', 'Garam Masala', 'Everest|Catch|Tata Sampann|MDH|Badshah|Aashirvaad|Eastern|MTR', [...grams(50, 100, 200)], ['garam masala', 'masala']),
  family('Cooking', 'Spices', 'Cumin Seeds', 'Everest|Catch|Tata Sampann|MDH|Badshah', [...grams(50, 100, 200)], ['cumin', 'jeera']),
  family('Cooking', 'Spices', 'Black Pepper', 'Everest|Catch|Tata Sampann|MDH|Badshah', [...grams(25, 50, 100)], ['pepper', 'kali mirch']),
  family('Cooking', 'Spices', 'Whole Coriander', 'Everest|Catch|Tata Sampann|MDH|Badshah', [...grams(50, 100, 200)], ['coriander seeds', 'dhania']),
  family('Cooking', 'Spices', 'Asafoetida Hing', 'Catch|Everest|LG|Ramdev|Vandevi', [...grams(10, 25)], ['hing', 'asafoetida']),
  family('Cooking', 'Ready Mix', 'Instant Idli Mix', 'MTR|Gits|Shan|Aashirvaad|Maiyas|Eastern', [...grams(200, 500, 1000)], ['idli mix', 'instant idli']),
  family('Cooking', 'Ready Mix', 'Instant Dosa Mix', 'MTR|Gits|Shan|Aashirvaad|Maiyas|Eastern', [...grams(200, 500, 1000)], ['dosa mix', 'instant dosa']),
  family('Cooking', 'Pickles', 'Mango Pickle', 'Mother’s Recipe|Priya|Bedekar|MTR|Eastern|Patanjali|Shan|Nilon’s', [...grams(200, 400, 500)], ['pickle', 'mango pickle', 'achar']),
  family('Cooking', 'Papad', 'Papad', 'Lijjat|MTR|Haldiram’s|Bikaji|Shreeji|Patanjali', [...grams(100, 200, 400)], ['papad', 'appalam']),
  family('Cooking', 'Sauces', 'Tomato Ketchup', 'Kissan|Maggi|Veeba|Del Monte|Heinz|Dr. Oetker|Patanjali', [...grams(200, 500), ...kilograms(1)], ['ketchup', 'tomato sauce']),
  family('Cooking', 'Sauces', 'Chilli Sauce', 'Maggi|Veeba|Ching’s Secret|Del Monte|Heinz|Dr. Oetker', [...grams(200, 500), ...kilograms(1)], ['chilli sauce', 'sauce']),

  // Biscuits, packaged foods and snacks
  family('Packaged Food', 'Biscuits', 'Glucose Biscuits', 'Parle|Britannia|Sunfeast|Priya Gold|Anmol|Cremica|Patanjali', [...grams(50, 100, 250)], ['biscuits', 'glucose biscuit']),
  family('Packaged Food', 'Biscuits', 'Marie Biscuits', 'Britannia|Parle|Sunfeast|McVitie’s|Priya Gold|Patanjali', [...grams(100, 200, 250)], ['biscuits', 'marie']),
  family('Packaged Food', 'Biscuits', 'Cream Biscuits', 'Britannia|Parle|Sunfeast|Oreo|Cremica|Priya Gold|Bisk Farm|Patanjali', [...grams(50, 100, 300)], ['biscuits', 'cream biscuit']),
  family('Packaged Food', 'Biscuits', 'Cookies', 'Britannia|Sunfeast|Parle|Cremica|Dukes|Bisk Farm|London Dairy', [...grams(75, 150, 300)], ['cookies', 'biscuits']),
  family('Packaged Food', 'Biscuits', 'Digestive Biscuits', 'Britannia|McVitie’s|Parle|Sunfeast|Bisk Farm|Himalayan Natives', [...grams(100, 200, 400)], ['digestive biscuit', 'biscuits']),
  family('Packaged Food', 'Biscuits', 'Salted Crackers', 'Britannia|Parle|Sunfeast|Monaco|Cremica|Bisk Farm', [...grams(50, 100, 250)], ['crackers', 'salt biscuits']),
  family('Packaged Food', 'Biscuits', 'Wafer Biscuits', 'Britannia|Parle|Sunfeast|Loacker|Dukes', [...grams(50, 100, 200)], ['wafer', 'wafer biscuit']),
  family('Packaged Food', 'Rusks', 'Elaichi Rusk', 'Britannia|Modern|Bisk Farm|Cremica|Mio Amore', [...grams(200, 400, 700)], ['rusk', 'toast']),
  family('Packaged Food', 'Instant Noodles', 'Instant Noodles', 'Maggi|Yippee|Top Ramen|Wai Wai|Knorr|Ching’s Secret', [...grams(70, 140, 280, 560)], ['noodles', 'maggi', 'instant noodles']),
  family('Packaged Food', 'Pasta', 'Macaroni Pasta', 'Bambino|Del Monte|Sunfeast|Disano|Weikfield|Patanjali', [...grams(200, 500, 1000)], ['pasta', 'macaroni']),
  family('Packaged Food', 'Breakfast Cereals', 'Oats', 'Quaker|Saffola|Kellogg’s|Bagrry’s|Patanjali|Yoga Bar', [...grams(200, 500, 1000)], ['oats', 'oatmeal']),
  family('Packaged Food', 'Breakfast Cereals', 'Corn Flakes', 'Kellogg’s|Bagrry’s|Saffola|Patanjali|MTR|Yoga Bar', [...grams(250, 500, 1000)], ['cornflakes', 'cereal']),
  family('Packaged Food', 'Breakfast Cereals', 'Muesli', 'Kellogg’s|Bagrry’s|Saffola|Yoga Bar|True Elements', [...grams(250, 500, 1000)], ['muesli', 'cereal']),
  family('Packaged Food', 'Spreads', 'Mixed Fruit Jam', 'Kissan|Mala’s|Patanjali|Dabur|Del Monte|Mapro', [...grams(200, 500, 700)], ['jam', 'fruit jam']),
  family('Packaged Food', 'Spreads', 'Peanut Butter', 'Sundrop|Pintola|MyFitness|Alpino|Dr. Oetker', [...grams(200, 350, 1_000)], ['peanut butter', 'spread']),
  family('Snacks', 'Chips', 'Salted Potato Chips', 'Lay’s|Bingo|Uncle Chipps|Balaji|Too Yumm|Pringles|Haldiram’s|Yellow Diamond', [...grams(25, 52, 100)], ['chips', 'potato chips']),
  family('Snacks', 'Extruded Snacks', 'Masala Snack', 'Kurkure|Bingo|Tedhe Medhe|Too Yumm|Balaji|Haldiram’s|Bikaji|Yellow Diamond', [...grams(40, 80, 150)], ['namkeen', 'snacks']),
  family('Snacks', 'Namkeen', 'Aloo Bhujia', 'Haldiram’s|Bikaji|Balaji|Bikanervala|Kurkure|Patanjali|Yellow Diamond|Bikano', [...grams(100, 200, 400)], ['namkeen', 'bhujia']),
  family('Snacks', 'Popcorn', 'Ready Popcorn', 'Act II|Orville Redenbacher’s|Too Yumm|PVR|4700BC', [...grams(40, 80, 120)], ['popcorn']),
  family('Snacks', 'Chocolate', 'Milk Chocolate', 'Cadbury|Nestle|Amul|Hershey’s|Lindt|Ferrero|Campco|Parle', [...grams(13, 40, 100)], ['chocolate']),
  family('Snacks', 'Candy', 'Fruit Candy', 'Parle|Alpenliebe|Pulse|Mango Bite|Hajmola|Kopiko|Lotte', [...grams(50, 100, 200)], ['candy', 'toffee']),
  family('Snacks', 'Chewing Gum', 'Chewing Gum', 'Center Fresh|Boomer|Orbit|Happydent|Doublemint', [...pieces(5, 10, 20)], ['gum', 'chewing gum']),
  family('Packaged Food', 'Soup', 'Instant Soup', 'Knorr|Maggi|Ching’s Secret|MTR|Kissan', [...grams(40, 60, 100)], ['soup', 'instant soup']),

  // Beverages
  family('Beverages', 'Tea', 'Black Tea', 'Tata Tea|Brooke Bond|Wagh Bakri|Society|Lipton|Red Label|Taj Mahal|Girnar|Tetley', [...grams(100, 250, 500), ...kilograms(1)], ['tea', 'chai', 'tea powder']),
  family('Beverages', 'Tea', 'Tea Bags', 'Tata Tea|Lipton|Tetley|Brooke Bond|Society|Girnar', pieces(10, 25, 50), ['tea', 'tea bags']),
  family('Beverages', 'Tea', 'Green Tea', 'Tata Tea|Lipton|Tetley|Girnar|Organic India|Typhoo', [...grams(25, 50, 100)], ['green tea', 'tea']),
  family('Beverages', 'Coffee', 'Instant Coffee', 'Nescafe|Bru|Continental|Tata Coffee|Sleepy Owl|Davidoff', [...grams(25, 50, 100, 200)], ['coffee', 'instant coffee']),
  family('Beverages', 'Coffee', 'Filter Coffee', 'Tata Coffee|Bru|Levista|Cothas|Bayar’s', [...grams(100, 200, 500)], ['coffee', 'filter coffee']),
  family('Beverages', 'Soft Drinks', 'Cola', 'Coca-Cola|Pepsi|Thums Up|Diet Coke|Diet Pepsi', [...ml(250, 500, 750), ...litres(1, 2)], ['cola', 'soft drink', 'coke']),
  family('Beverages', 'Soft Drinks', 'Lemon Lime Drink', 'Sprite|7UP|Limca|Mountain Dew|Paper Boat', [...ml(250, 500, 750), ...litres(1, 2)], ['soft drink', 'lemon drink']),
  family('Beverages', 'Soft Drinks', 'Orange Drink', 'Fanta|Mirinda|Maaza|Slice|Appy Fizz', [...ml(250, 500, 750), ...litres(1, 2)], ['soft drink', 'orange drink']),
  family('Beverages', 'Fruit Drink', 'Mango Drink', 'Frooti|Maaza|Slice|Real|Paper Boat|Tropicana', [...ml(200, 500), ...litres(1, 2)], ['juice', 'mango drink']),
  family('Beverages', 'Juice', 'Fruit Juice', 'Real|Tropicana|B Natural|Paper Boat|Minute Maid|Safal|Dabur', [...ml(200, 500), ...litres(1, 2)], ['juice', 'fruit juice']),
  family('Beverages', 'Energy Drink', 'Energy Drink', 'Red Bull|Monster|Sting|Hell|Gatorade', [...ml(250, 330, 500)], ['energy drink']),
  family('Beverages', 'Water', 'Packaged Drinking Water', 'Bisleri|Kinley|Aquafina|Bailley|Himalayan|Rail Neer', [...ml(250, 500), ...litres(1, 2, 5)], ['water', 'mineral water']),
  family('Beverages', 'Health Drink', 'Malted Health Drink', 'Horlicks|Complan|Bournvita|Boost|Ensure|Protinex', [...grams(200, 500), ...kilograms(1)], ['health drink', 'malt drink']),
  family('Beverages', 'Squash', 'Fruit Squash', 'Rasna|Mapro|Kissan|Dabur|Hamdard', [...ml(700), ...litres(1, 2)], ['squash', 'fruit syrup']),

  // Personal care
  family('Personal Care', 'Soap', 'Bathing Soap', 'Lux|Lifebuoy|Dove|Pears|Santoor|Cinthol|Medimix|Mysore Sandal|Dettol|Fiama', [...grams(75, 100, 125)], ['soap', 'bath soap']),
  family('Personal Care', 'Soap', 'Beauty Soap', 'Lux|Dove|Pears|Santoor|Fiama|Nivea|Godrej No.1|Vivel', [...grams(75, 100, 125)], ['soap', 'beauty soap']),
  family('Personal Care', 'Shampoo', 'Daily Care Shampoo', 'Clinic Plus|Sunsilk|Dove|Pantene|Head & Shoulders|Tresemme|Himalaya|Patanjali|Mamaearth|L’Oréal', [...ml(80, 180, 340)], ['shampoo']),
  family('Personal Care', 'Conditioner', 'Hair Conditioner', 'Dove|Pantene|Sunsilk|Tresemme|L’Oréal|Himalaya', [...ml(80, 180, 340)], ['conditioner', 'hair care']),
  family('Personal Care', 'Oral Care', 'Toothpaste', 'Colgate|Pepsodent|Closeup|Sensodyne|Dabur Red|Himalaya|Patanjali|Meswak|Oral-B', [...grams(50, 100, 200)], ['toothpaste', 'dental care']),
  family('Personal Care', 'Oral Care', 'Toothbrush', 'Colgate|Oral-B|Pepsodent|Sensodyne|Patanjali|Himalaya|Aquawhite', pieces(1, 2, 4), ['toothbrush', 'brush']),
  family('Personal Care', 'Hair Oil', 'Coconut Hair Oil', 'Parachute|Dabur Anmol|Bajaj|Navratna|Indulekha|Kesh King|Dabur Amla', [...ml(100, 200, 300)], ['hair oil', 'coconut oil']),
  family('Personal Care', 'Face Care', 'Face Wash', 'Himalaya|Pond’s|Garnier|Lakme|Mamaearth|Nivea|Biotique', [...ml(50, 100, 150)], ['face wash', 'cleanser']),
  family('Personal Care', 'Skin Care', 'Body Lotion', 'Vaseline|Nivea|Pond’s|Himalaya|Dove|Joy|Parachute', [...ml(100, 200, 400)], ['lotion', 'moisturizer']),
  family('Personal Care', 'Talcum Powder', 'Talcum Powder', 'Pond’s|Cinthol|Navratna|Nycil|Himalaya', [...grams(50, 100, 200)], ['talc', 'body powder']),
  family('Personal Care', 'Deodorant', 'Deodorant', 'Nivea|Fogg|Engage|Park Avenue|Wild Stone|Axe|Denver|Rexona', [...ml(50, 100, 150)], ['deodorant', 'body spray']),
  family('Personal Care', 'Shaving', 'Shaving Cream', 'Gillette|Old Spice|Park Avenue|Vi-John|Bombay Shaving Company', [...grams(50, 70, 100)], ['shaving cream', 'shave']),
  family('Personal Care', 'Feminine Care', 'Sanitary Pads', 'Whisper|Stayfree|Sofy|Kotex|Carmesi|Plush', pieces(7, 8, 15), ['sanitary pads', 'pads']),
  family('Personal Care', 'Hand Care', 'Liquid Handwash', 'Dettol|Lifebuoy|Savlon|Himalaya|Dove|Godrej Protekt|Palmolive', [...ml( (250)), ...ml(500), ...litres(1)], ['handwash', 'hand soap']),
  family('Personal Care', 'Hand Care', 'Hand Sanitizer', 'Dettol|Savlon|Lifebuoy|Himalaya|Godrej Protekt', [...ml(50, 100, 200)], ['sanitizer', 'hand rub']),

  // Household cleaning and utility
  family('Household', 'Laundry', 'Detergent Powder', 'Surf Excel|Ariel|Tide|Wheel|Rin|Henko|Ghadi|Nirma|Patanjali', [...grams(500), ...kilograms(1, 2, 4)], ['detergent', 'washing powder']),
  family('Household', 'Laundry', 'Detergent Bar', 'Rin|Wheel|Nirma|Surf Excel|Ghadi|Fena|Mr. White', [...grams(100, 250, 400)], ['detergent bar', 'washing soap']),
  family('Household', 'Dishwashing', 'Dishwash Liquid', 'Vim|Pril|Exo|Giffy|IFB|Nim|Ezee', [...ml(250, 500), ...litres(1)], ['dishwash', 'dish soap']),
  family('Household', 'Dishwashing', 'Dishwash Bar', 'Vim|Exo|Pril|Giffy|Brite', [...grams(100, 200, 300)], ['dishwash bar', 'dish soap']),
  family('Household', 'Floor Cleaning', 'Floor Cleaner', 'Lizol|Harpic|Domex|Dettol|Colin|Dazzl|Presto', [...ml(500), ...litres(1, 2)], ['floor cleaner', 'disinfectant']),
  family('Household', 'Toilet Cleaning', 'Toilet Cleaner', 'Harpic|Domex|Lizol|T-Shine|Mr. Muscle|Presto|Patanjali', [...ml(200, 500), ...litres(1)], ['toilet cleaner', 'bathroom cleaner']),
  family('Household', 'Surface Cleaning', 'Glass Cleaner', 'Colin|Mr. Muscle|Lizol|Presto|Dazzl', [...ml(250, 500), ...litres(1)], ['glass cleaner', 'surface cleaner']),
  family('Household', 'Disinfectant', 'Disinfectant Liquid', 'Dettol|Savlon|Lizol|Harpic|Domex', [...ml(100, 500), ...litres(1)], ['disinfectant', 'cleaner']),
  family('Household', 'Pest Control', 'Mosquito Repellent Liquid', 'Goodknight|All Out|Mortein|Maxo|HIT', [...ml(30, 45, 60)], ['mosquito repellent', 'mosquito liquid']),
  family('Household', 'Pest Control', 'Mosquito Coil', 'Goodknight|Mortein|Maxo|All Out|HIT', pieces(6, 10, 20), ['mosquito coil', 'repellent']),
  family('Household', 'Air Care', 'Room Freshener', 'Godrej aer|Odonil|Air Wick|Ambi Pur|Karmic', [...ml(150, 300), ...grams(50, 100)], ['room freshener', 'air freshener']),
  family('Household', 'Paper Products', 'Facial Tissues', 'Kleenex|Origami|Premier|Selpak|Paseo', packs(50, 100, 200), ['tissue', 'facial tissue']),
  family('Household', 'Cleaning Tools', 'Scrub Pad', 'Scotch-Brite|Gala|Spotzero|Giffy', pieces(2, 4, 6), ['scrub pad', 'scrubber']),
  family('Household', 'Waste Management', 'Garbage Bags', 'Ezee|Beco|Amazon Basics|Gala|Solimo', pieces(20, 30, 60), ['garbage bags', 'trash bags']),
  family('Household', 'Electrical', 'Alkaline Batteries', 'Duracell|Energizer|Eveready|Panasonic|Maxell', pieces(2, 4, 8), ['battery', 'cells']),

  // Baby, pet, worship and small general-store lines
  family('Baby Care', 'Diapers', 'Baby Diapers', 'Pampers|Huggies|MamyPoko|Little Angels|Supples|Himalaya', pieces(4, 10, 20), ['diaper', 'baby diapers']),
  family('Baby Care', 'Baby Toiletries', 'Baby Shampoo', 'Johnson’s|Himalaya Baby|Mamaearth|Dove Baby|Sebamed|Chicco', [...ml(100, 200, 400)], ['baby shampoo', 'baby care']),
  family('Baby Care', 'Baby Toiletries', 'Baby Lotion', 'Johnson’s|Himalaya Baby|Mamaearth|Dove Baby|Sebamed|Chicco', [...ml(100, 200, 400)], ['baby lotion', 'baby care']),
  family('Pet Care', 'Dog Food', 'Dog Dry Food', 'Pedigree|Drools|Purepet|Royal Canin|Chappi|SmartHeart', [...grams(500), ...kilograms(1, 3, 10)], ['dog food', 'pet food']),
  family('Pet Care', 'Cat Food', 'Cat Dry Food', 'Whiskas|Me-O|Purepet|Royal Canin|Drools|Sheba', [...grams(450, 900), ...kilograms(2)], ['cat food', 'pet food']),
  family('Pet Care', 'Pet Treats', 'Pet Biscuits', 'Pedigree|Drools|Purepet|Royal Canin|JerHigh', [...grams(100, 200, 500)], ['pet treats', 'dog biscuits']),
  family('Puja Needs', 'Agarbatti', 'Agarbatti', 'Cycle|Mangaldeep|Zed Black|Moksh|Hem|Patanjali', packs(10, 20, 40), ['agarbatti', 'incense']),
  family('Puja Needs', 'Camphor', 'Camphor Tablets', 'Purohit|Mangaldeep|Cycle|Patanjali', [...grams(25, 50, 100)], ['camphor', 'kapoor']),
  family('Stationery', 'Notebooks', 'Ruled Notebook', 'Classmate|Navneet|Camlin|DOMS|Luxor|Paperkraft', pieces(1, 3, 5), ['notebook', 'copy']),
  family('Stationery', 'Writing', 'Ball Pen', 'Reynolds|Cello|Flair|Classmate|Linc|Nataraj|Rorito|Luxor', pieces(1, 5, 10), ['pen', 'ball pen']),
  family('Stationery', 'Writing', 'Pencil', 'Nataraj|Apsara|DOMS|Camlin|Faber-Castell|Classmate', pieces(1, 5, 10), ['pencil']),
  family('Stationery', 'Adhesives', 'Glue Stick', 'Fevicol|Fevistick|Kores|Camlin|Pidilite', pieces(1, 2, 5), ['glue', 'adhesive']),
  family('General Utility', 'Matches', 'Safety Matches', 'Ship|Homelites|Aim|Vijay', packs(5, 10, 20), ['matches', 'matchbox']),
  family('General Utility', 'Lighting', 'LED Bulb', 'Philips|Havells|Wipro|Syska|Crompton', pieces(1, 2, 4), ['bulb', 'led bulb']),
]

const rows = families.flatMap((item) => item.brands.flatMap((brand) => item.packs.map(([packSize, unit]) => ({
  name: item.name,
  brand,
  category: item.category,
  subcategory: item.subcategory,
  packSize,
  unit,
  sellUnit: item.sellUnit ?? 'piece',
  aliases: [...new Set([
    ...(item.aliases ?? []),
    item.name,
    item.subcategory,
    ...(brand ? [brand] : []),
  ].map((alias) => alias.toLocaleLowerCase()))],
  source: 'Ambel curated India general-store seed v1',
}))))

const identities = rows.map((row) => [row.name, row.brand ?? '', row.packSize, row.unit].join('|').toLocaleLowerCase())
if (new Set(identities).size !== identities.length) {
  const seen = new Set<string>()
  const duplicates = identities.filter((identity) => seen.has(identity) || !seen.add(identity))
  throw new Error(`Generated seed contains duplicate identities: ${[...new Set(duplicates)].slice(0, 5).join(', ')}`)
}
if (rows.length < 2_000 || rows.length > 3_000) throw new Error(`Generated ${rows.length} rows; expected 2,000–3,000`)

const destination = path.resolve(process.cwd(), 'data/master-items/india-general-store.json')
fs.writeFileSync(destination, `${JSON.stringify(rows, null, 2)}\n`)
console.log(`Generated ${rows.length} India master items at ${path.relative(process.cwd(), destination)}`)
