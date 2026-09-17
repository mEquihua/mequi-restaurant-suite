import re

with open('services/api/src/shared/database.ts', 'r') as f:
    content = f.read()

table_interface = """export interface ScheduledOrderSettingsTable {
  id: Generated<string>;
  location_id: string;
  accepts_scheduled_orders: Generated<boolean>;
  minimum_lead_time_minutes: Generated<number>;
  maximum_lead_time_days: Generated<number>;
  operating_hours: string; // JSONB stored as string stringified
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
"""

if "ScheduledOrderSettingsTable" not in content:
    content = content.replace("export interface Database {", table_interface + "\nexport interface Database {\n  scheduled_order_settings: ScheduledOrderSettingsTable;")

with open('services/api/src/shared/database.ts', 'w') as f:
    f.write(content)
print("done")
