import re

with open('services/api/src/modules/orders/scheduled-orders.integration.test.ts', 'r') as f:
    content = f.read()

# Replace terminal insertion
new_insert = """    const termCred = randomBytes(32).toString('base64url');
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Main', credential_hash: hash(termCred) }).execute();"""

content = re.sub(
    r"    await db\.insertInto\('terminals'\)\.values\(\{ id: terminalId, location_id: locationId, name: 'Main' \}\)\.execute\(\);",
    new_insert,
    content
)

with open('services/api/src/modules/orders/scheduled-orders.integration.test.ts', 'w') as f:
    f.write(content)
print("done")
