import re

with open('services/api/src/modules/identity/security.ts', 'r') as f:
    content = f.read()

new_perms = "\n  'online_ordering.settings.read', 'online_ordering.settings.write',"
if "'online_ordering.settings.read'" not in content:
    content = content.replace("  'reports.sales.read', 'reports.audit.read',", "  'reports.sales.read', 'reports.audit.read'," + new_perms)

with open('services/api/src/modules/identity/security.ts', 'w') as f:
    f.write(content)
print("done")
