import re

with open('services/api/src/modules/orders/scheduled-orders.integration.test.ts', 'r') as f:
    content = f.read()

# Add terminal creation and terminal_id
terminal_setup = """    const terminalId = crypto.randomUUID();
    await db.insertInto('terminals').values({ id: terminalId, location_id: locationId, name: 'Main' }).execute();

    const rawToken = randomBytes(32).toString('base64url');
    staffSessionToken = `${locationId}.${rawToken}`;
    await db.insertInto('staff_sessions').values({
      location_id: locationId,
      terminal_id: terminalId,
      staff_id: staffId,"""

content = re.sub(
    r"    const rawToken = randomBytes\(32\)\.toString\('base64url'\);\n    staffSessionToken = `\$\{locationId\}\.\$\{rawToken\}`;\n    await db\.insertInto\('staff_sessions'\)\.values\(\{\n      location_id: locationId,\n      staff_id: staffId,",
    terminal_setup,
    content
)

with open('services/api/src/modules/orders/scheduled-orders.integration.test.ts', 'w') as f:
    f.write(content)
print("done")
