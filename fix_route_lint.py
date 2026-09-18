with open('services/api/src/modules/promotions/route.ts', 'r') as f:
    c = f.read()

type_def = """type PromoBody = {
  name: string;
  description?: string;
  discount_type: 'PERCENTAGE' | 'AMOUNT';
  discount_value: number;
  category_id?: string;
  product_id?: string;
  is_active: boolean;
  starts_at?: string;
  ends_at?: string;
  days_of_week?: number[];
  start_time?: string;
  end_time?: string;
};
"""

# Insert at top
c = c.replace("export interface", type_def + "\nexport interface")
c = c.replace("const body = request.body as Record<string, unknown>;", "const body = request.body as PromoBody;")
with open('services/api/src/modules/promotions/route.ts', 'w') as f:
    f.write(c)
