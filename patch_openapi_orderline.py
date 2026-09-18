with open('packages/contracts/openapi.yaml', 'r') as f:
    content = f.read()

import re

# find OrderLine properties
match = re.search(r'    OrderLine:\n.*?properties:\n', content, re.DOTALL)
if match:
    insert_pos = match.end()
    
    order_line_addon = """        promotion_name:
          type: string
          nullable: true
        promotion_computed_amount:
          type: integer
          nullable: true
"""
    content = content[:insert_pos] + order_line_addon + content[insert_pos:]

with open('packages/contracts/openapi.yaml', 'w') as f:
    f.write(content)
