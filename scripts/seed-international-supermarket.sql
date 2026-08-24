-- Deterministic live QA dataset for AMBEL-INTERNATIONAL.
-- Target: the existing couture.founders@gmail.com tenant only.
-- The marker makes this script fail closed on a second run.

do $seed$
#variable_conflict use_variable
declare
  seed_tag constant text := 'ambel-intl-supermarket-qa-v1';
  tenant constant uuid := '4b08f300-c3d1-495a-97dd-9a1fa27f7c0d';
  owner uuid := 'a6d38e88-e5d7-4c4a-91e8-8adeceed1ca4';
  original_store uuid;
  store_id uuid;
  category_id uuid;
  product_id uuid;
  variant_id uuid;
  terminal_id uuid;
  staff_id uuid;
  customer_id uuid;
  shift_id uuid;
  sale_id uuid;
  line_id uuid;
  supplier_id uuid;
  po_id uuid;
  location_no int;
  product_no int;
  customer_no int;
  day_no int;
  sale_no int;
  sale_day date;
  unit_price numeric(12,2);
  tax_rate numeric(8,6);
  subtotal numeric(12,2);
  discount numeric(12,2);
  tax numeric(12,2);
  total numeric(12,2);
  quantity numeric(12,3);
  method payment_method;
  qa_city text;
  state_name text;
  postal text;
  store_name text;
  product_name text;
  category_name text;
begin
  if exists (select 1 from public.tenants where id = tenant and onboarding_data->>'qaSeed' = seed_tag) then
    raise exception 'International supermarket QA seed already exists; no rows changed.';
  end if;

  select id into strict original_store from public.stores where tenant_id = tenant order by created_at, id limit 1;

  update public.tenants
  set business_name = 'QA - Harbor & Pine Markets',
      trade_name = 'Harbor & Pine',
      address_line1 = '1200 Market Street', city = 'Philadelphia', state = 'PA', postal_code = '19107',
      country = 'US', timezone = 'America/New_York', tax_id = 'QA-12-3456789',
      tax_rate_state = 0.06, tax_rate_county = 0, tax_rate_city = 0.02, tax_rate_district = 0,
      onboarding_step = 8, onboarding_completed_at = now(),
      onboarding_data = onboarding_data || jsonb_build_object(
        'qaSeed', seed_tag, 'scenario', '10-location US supermarket chain', 'synthetic', true,
        'seededAt', now(), 'ownerEmail', 'couture.founders@gmail.com'
      )
  where id = tenant;

  for location_no in 1..10 loop
    store_id := case when location_no = 1 then original_store else md5(seed_tag || ':store:' || location_no)::uuid end;
    qa_city := (array['Philadelphia','Pittsburgh','Allentown','Erie','Reading','Scranton','Bethlehem','Lancaster','Harrisburg','State College'])[location_no];
    state_name := 'PA';
    postal := (array['19107','15222','18101','16501','19601','18503','18018','17603','17101','16801'])[location_no];
    store_name := 'QA - Harbor & Pine ' || qa_city;

    if location_no = 1 then
      update public.stores set name=store_name, address_line1=(100 + location_no)::text || ' Market Street',
        city=qa_city, state=state_name, postal_code=postal, country='US', is_active=true,
        tax_rate_state=0.06, tax_rate_county=0, tax_rate_city=case when location_no=1 then 0.02 else 0 end,
        tax_rate_district=0, invoice_prefix='H01' where id=store_id;
      update public.staff_members set store_id=store_id, name='QA Owner - Simha Teja', email='couture.founders@gmail.com'
      where id=owner;
    else
      insert into public.stores
        (id,tenant_id,name,address_line1,city,state,postal_code,country,is_active,tax_rate_state,tax_rate_county,tax_rate_city,tax_rate_district,invoice_prefix,created_at)
      values
        (store_id,tenant,store_name,(100 + location_no)::text || ' Market Street',qa_city,state_name,postal,'US',
         location_no <= 5,0.06,0,case when location_no in (2,7) then 0.01 else 0 end,0,
         'H' || lpad(location_no::text,2,'0'),now() - interval '400 days' + location_no * interval '1 day');
    end if;

    for sale_no in 1..2 loop
      terminal_id := md5(seed_tag || ':terminal:' || location_no || ':' || sale_no)::uuid;
      insert into public.terminals (id,tenant_id,store_id,name,is_active,cash_mode,created_at)
      values (terminal_id,tenant,store_id,'QA L' || lpad(location_no::text,2,'0') || ' Register ' || lpad(sale_no::text,2,'0'),location_no <= 5,
              case when sale_no=1 then 'cash' else 'none' end,now() - interval '390 days');
    end loop;

    staff_id := md5(seed_tag || ':manager:' || location_no)::uuid;
    insert into public.staff_members (id,tenant_id,store_id,name,role,email,pin_hash,is_active,pin_must_change,created_at)
    values (staff_id,tenant,store_id,'QA Manager - ' || qa_city,'manager','qa.manager.' || location_no || '@example.test',
            crypt(('24' || lpad(location_no::text,2,'0')),gen_salt('bf')),location_no<=5,false,now()-interval '380 days');
    staff_id := md5(seed_tag || ':cashier:' || location_no)::uuid;
    insert into public.staff_members (id,tenant_id,store_id,name,role,email,pin_hash,is_active,pin_must_change,created_at)
    values (staff_id,tenant,store_id,'QA Cashier - ' || qa_city,'cashier','qa.cashier.' || location_no || '@example.test',
            crypt(('41' || lpad(location_no::text,2,'0')),gen_salt('bf')),location_no<=5,false,now()-interval '380 days');
  end loop;

  for product_no in 1..20 loop
    category_name := 'QA - ' || (array['Produce','Dairy & Eggs','Bakery','Meat & Seafood','Pantry','Frozen Foods','Beverages','Household'])[1 + ((product_no-1) % 8)];
    category_id := md5(seed_tag || ':category:' || category_name)::uuid;
    insert into public.categories (id,tenant_id,name,sort_order,created_at)
    values (category_id,tenant,category_name,1 + ((product_no-1) % 8),now()-interval '370 days') on conflict (id) do nothing;

    product_name := (array['Organic Bananas','Honeycrisp Apples','Whole Milk','Free Range Eggs','Sourdough Bread','Butter Croissants','Atlantic Salmon','Chicken Breast','Basmati Rice','Extra Virgin Olive Oil','Tomato Pasta Sauce','Peanut Butter','Frozen Blueberries','Margherita Pizza','Sparkling Water','Cold Brew Coffee','Paper Towels','Dish Soap','Avocados','Greek Yogurt'])[product_no];
    product_id := md5(seed_tag || ':product:' || product_no)::uuid;
    variant_id := md5(seed_tag || ':variant:' || product_no)::uuid;
    unit_price := (array[1.29,2.99,4.49,5.99,4.79,6.49,13.99,8.99,12.49,14.99,3.79,5.49,6.99,7.99,4.99,5.99,18.99,4.29,1.99,5.79])[product_no];
    insert into public.products (id,tenant_id,name,category_id,created_at)
    values (product_id,tenant,'QA - ' || product_name,category_id,now()-interval '365 days');
    insert into public.variants
      (id,tenant_id,product_id,sku,size,color,material,price,reorder_threshold,identity_locked,is_taxable,moving_average_cost,source_metadata,unit_of_measure,barcode,tax_rate,created_at)
    values
      (variant_id,tenant,product_id,'HPM-' || lpad(product_no::text,4,'0'),
       case when product_no in (1,2,19) then '1 lb' else 'Standard' end,null,null,unit_price,
       12,false,product_no not in (1,2,3,4,5,6,7,8,19,20),unit_price*0.58,
       jsonb_build_object('qaSeed',seed_tag,'synthetic',true),
       case when product_no in (1,2,19) then 'kg' else 'piece' end,
       '041000' || lpad(product_no::text,6,'0'),
       case when product_no in (1,2,3,4,5,6,7,8,19,20) then 0 else 0.06 end,
       now()-interval '365 days');
  end loop;

  for customer_no in 1..100 loop
    customer_id := md5(seed_tag || ':customer:' || customer_no)::uuid;
    insert into public.customers (id,tenant_id,name,phone,email,address_line1,city,country,notes,created_at,updated_at)
    values (customer_id,tenant,'QA Shopper ' || lpad(customer_no::text,3,'0'),
      '+1215555' || lpad(customer_no::text,4,'0'),'qa.shopper.' || lpad(customer_no::text,3,'0') || '@example.test',
      customer_no || ' Test Avenue','Philadelphia','US','Synthetic international QA customer',now()-interval '350 days',now()-interval '1 day');
  end loop;

  for location_no in 1..10 loop
    store_id := case when location_no = 1 then original_store else md5(seed_tag || ':store:' || location_no)::uuid end;
    tax_rate := 0.06 + case when location_no in (1) then 0.02 when location_no in (2,7) then 0.01 else 0 end;
    staff_id := md5(seed_tag || ':cashier:' || location_no)::uuid;
    for product_no in 1..20 loop
      variant_id := md5(seed_tag || ':variant:' || product_no)::uuid;
      quantity := case when location_no=10 and product_no in (1,2,3) then product_no-1 else 80 + ((location_no*17+product_no*11)%90) end;
      insert into public.variant_stock_levels (variant_id,tenant_id,store_id,quantity,updated_at)
      values (variant_id,tenant,store_id,quantity,now());
      if quantity > 0 then
        insert into public.stock_movements (id,tenant_id,store_id,variant_id,movement_type,quantity_delta,reason_note,created_by,created_at)
        values (md5(seed_tag || ':opening:' || location_no || ':' || product_no)::uuid,tenant,store_id,variant_id,'receive',quantity,
                'Synthetic QA opening inventory',staff_id,now()-interval '360 days');
      end if;
    end loop;

    for day_no in 0..179 loop
      sale_day := current_date - (179-day_no);
      terminal_id := md5(seed_tag || ':terminal:' || location_no || ':' || (1 + day_no%2))::uuid;
      shift_id := md5(seed_tag || ':shift:' || location_no || ':' || sale_day)::uuid;
      insert into public.shifts (id,tenant_id,store_id,staff_id,starting_cash,opened_at,counted_cash,variance,closed_at,terminal_id)
      values (shift_id,tenant,store_id,staff_id,200,(sale_day::timestamp + interval '8 hours') at time zone 'America/New_York',
              200 + ((day_no*13+location_no*7)%600),case when day_no%53=0 then -2 else 0 end,
              (sale_day::timestamp + interval '20 hours') at time zone 'America/New_York',terminal_id);
      for sale_no in 1..3 loop
        product_no := 1 + ((day_no*7 + location_no*3 + sale_no*5) % 20);
        variant_id := md5(seed_tag || ':variant:' || product_no)::uuid;
        customer_id := md5(seed_tag || ':customer:' || (1 + ((day_no+location_no+sale_no)%100)))::uuid;
        sale_id := md5(seed_tag || ':sale:' || location_no || ':' || sale_day || ':' || sale_no)::uuid;
        line_id := md5(seed_tag || ':line:' || location_no || ':' || sale_day || ':' || sale_no)::uuid;
        select price,coalesce(tax_rate,0) into unit_price,tax_rate from public.variants where id=variant_id;
        quantity := case when product_no in (1,2,19) then 1.5 else 1 + ((day_no+sale_no)%3=0)::int end;
        subtotal := round(unit_price*quantity,2);
        discount := case when (day_no+sale_no+location_no)%29=0 then round(subtotal*0.10,2) else 0 end;
        tax := round((subtotal-discount)*tax_rate,2);
        total := subtotal-discount+tax;
        method := (array['cash'::payment_method,'card'::payment_method,'check'::payment_method]) [1+((day_no+sale_no)%3)];
        insert into public.sales
          (id,tenant_id,store_id,client_sale_id,shift_id,customer_id,subtotal,discount_amount,tax_amount,total_amount,status,created_by,created_at,source,source_metadata)
        values (sale_id,tenant,store_id,md5(seed_tag || ':client:' || sale_id)::uuid,shift_id,customer_id,subtotal,discount,tax,total,'completed',staff_id,
          (sale_day::timestamp + interval '9 hours' + sale_no*interval '2 hours') at time zone 'America/New_York','pos',jsonb_build_object('qaSeed',seed_tag,'synthetic',true));
        insert into public.sale_line_items
          (id,tenant_id,sale_id,variant_id,quantity,unit_price,discount_percent,discount_amount,is_taxable,tax_rate,line_total,created_at)
        values (line_id,tenant,sale_id,variant_id,quantity,unit_price,case when discount>0 then 10 else null end,discount,tax_rate>0,tax_rate,subtotal-discount,
          (sale_day::timestamp + interval '9 hours' + sale_no*interval '2 hours') at time zone 'America/New_York');
        insert into public.payments (id,tenant_id,sale_id,method,direction,amount,reference_code,created_by,created_at)
        values (md5(seed_tag || ':payment:' || sale_id)::uuid,tenant,sale_id,method,'payment',total,
          case when method='cash' then null else 'QA-' || upper(method::text) || '-' || left(sale_id::text,8) end,staff_id,
          (sale_day::timestamp + interval '9 hours' + sale_no*interval '2 hours') at time zone 'America/New_York');
      end loop;
    end loop;
  end loop;

  for location_no in 1..5 loop
    supplier_id := md5(seed_tag || ':supplier:' || location_no)::uuid;
    insert into public.suppliers (id,tenant_id,name,contact_name,email,phone,lead_time_days,payment_terms,is_active,created_at)
    values (supplier_id,tenant,'QA Supplier ' || location_no,'QA Contact ' || location_no,'qa.supplier.' || location_no || '@example.test',
            '+12155559' || lpad(location_no::text,3,'0'),3+location_no,'Net 30',true,now()-interval '300 days');
    if location_no <= 4 then
      store_id := case when location_no=1 then original_store else md5(seed_tag || ':store:' || location_no)::uuid end;
      po_id := md5(seed_tag || ':po:' || location_no)::uuid;
      insert into public.purchase_orders (id,tenant_id,store_id,supplier_id,po_number,status,expected_date,notes,created_by,created_at)
      values (po_id,tenant,store_id,supplier_id,'QA-HPM-PO-' || lpad(location_no::text,3,'0'),
              (array['draft','sent','partial','received'])[location_no]::purchase_order_status,current_date+location_no,
              'Synthetic supermarket QA purchase order',md5(seed_tag || ':manager:' || location_no)::uuid,now()-interval '5 days');
      insert into public.purchase_order_lines (id,tenant_id,purchase_order_id,variant_id,quantity_ordered,quantity_received,unit_cost,created_at)
      values (md5(seed_tag || ':po-line:' || location_no)::uuid,tenant,po_id,md5(seed_tag || ':variant:' || location_no)::uuid,
              50,case when location_no=3 then 20 when location_no=4 then 50 else 0 end,3.25,now()-interval '5 days');
    end if;
  end loop;

  for location_no in 1..10 loop
    store_id := case when location_no=1 then original_store else md5(seed_tag || ':store:' || location_no)::uuid end;
    insert into public.notifications (id,tenant_id,store_id,type,title,body,link,metadata,read_at,created_at)
    values (md5(seed_tag || ':notification:' || location_no)::uuid,tenant,store_id,'stock_low','QA low stock - Location ' || location_no,
            'Synthetic low-stock scenario for supermarket testing.','/us/inventory',jsonb_build_object('qaSeed',seed_tag,'synthetic',true),
            case when location_no%2=0 then now() else null end,now()-location_no*interval '1 hour');
  end loop;
end
$seed$;
