with open('services/api/src/modules/promotions/route.ts', 'r') as f:
    c = f.read()

c = c.replace("starts_at: body.starts_at ?? null,", "starts_at: body.starts_at ? new Date(body.starts_at) : null,")
c = c.replace("ends_at: body.ends_at ?? null,", "ends_at: body.ends_at ? new Date(body.ends_at) : null,")

with open('services/api/src/modules/promotions/route.ts', 'w') as f:
    f.write(c)
