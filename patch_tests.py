import glob
import re

files = glob.glob("services/api/src/modules/*/*.integration.test.ts")
for f in files:
    with open(f, "r") as file:
        content = file.read()
    
    # We want to replace 'locations', with 'scheduled_order_settings',\n      'locations', but only in the beforeAll cleanup block or deleteFrom block.
    # We can match `deleteFrom('locations')` directly.
    content = re.sub(r"(\s*)await db\.deleteFrom\('locations'\)", r"\1await db.deleteFrom('scheduled_order_settings').execute();\1await db.deleteFrom('locations')", content)
    
    # For the array format, match `      'locations',` precisely.
    # It usually looks like `\n      'locations',` or similar inside an array of table strings.
    # Let's match `(whitespace)'locations',`
    content = re.sub(r"(\n\s*)'locations',", r"\1'scheduled_order_settings',\1'locations',", content)
    
    with open(f, "w") as file:
        file.write(content)
print("done")
