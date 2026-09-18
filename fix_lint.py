# 1. Promotions.tsx
with open('apps/admin/src/Promotions.tsx', 'r') as f:
    c = f.read()
c = c.replace("body: any)", "body: Record<string, unknown>)")
c = c.replace("promo: any & { id: string; version: number }) => {", "promo: Record<string, unknown> & { id: string; version: number }) => {")
c = c.replace("const [editingId, setEditingId] = useState<string | null>(null);\n", "")
c = c.replace("setTargetType(e.target.value as any)", "setTargetType(e.target.value as 'GLOBAL' | 'CATEGORY' | 'PRODUCT')")
with open('apps/admin/src/Promotions.tsx', 'w') as f:
    f.write(c)

# 2. evaluator.ts
with open('services/api/src/modules/promotions/evaluator.ts', 'r') as f:
    c = f.read()
c = c.replace("  const dateString = input.now.toISOString();\n", "")
with open('services/api/src/modules/promotions/evaluator.ts', 'w') as f:
    f.write(c)

# 3. test
with open('services/api/src/modules/promotions/promotions.integration.test.ts', 'r') as f:
    c = f.read()
c = c.replace("let ownerId: string;\n", "")
c = c.replace("ownerId = owner.id;\n", "")
c = c.replace("table as any", "table as string") # Kysely might complain if we cast to string, but it's any now. Wait, let's cast to `table as never`.
c = c.replace("table as string", "table as never")
c = c.replace("let version = ", "const version = ")
with open('services/api/src/modules/promotions/promotions.integration.test.ts', 'w') as f:
    f.write(c)

# 4. route.ts
with open('services/api/src/modules/promotions/route.ts', 'r') as f:
    c = f.read()
c = c.replace("const body = request.body as any;", "const body = request.body as Record<string, unknown>;")
with open('services/api/src/modules/promotions/route.ts', 'w') as f:
    f.write(c)
