import re

with open('packages/contracts/openapi.yaml', 'r') as f:
    content = f.read()

# 1. Add exclude_future_scheduled query parameter to order-lines
param_to_add = """      - name: exclude_future_scheduled
        in: query
        required: false
        schema:
          type: boolean
"""
if "exclude_future_scheduled" not in content:
    content = content.replace(
        "      - name: status\n        in: query",
        param_to_add + "      - name: status\n        in: query"
    )

# 2. Add ScheduledOrderSettingsRow schema
schema_to_add = """    ScheduledOrderSettingsRow:
      type: object
      additionalProperties: false
      required:
      - accepts_scheduled_orders
      - minimum_lead_time_minutes
      - maximum_lead_time_days
      - operating_hours
      - version
      properties:
        accepts_scheduled_orders:
          type: boolean
        minimum_lead_time_minutes:
          type: integer
        maximum_lead_time_days:
          type: integer
        operating_hours:
          type: array
          items:
            type: object
            additionalProperties: false
            required:
            - day_of_week
            - open_time
            - close_time
            properties:
              day_of_week:
                type: integer
              open_time:
                type: string
              close_time:
                type: string
        version:
          type: integer
"""

if "ScheduledOrderSettingsRow:" not in content:
    content = content.replace("  schemas:\n", "  schemas:\n" + schema_to_add)

# 3. Add Scheduled Order Settings endpoints
endpoints_to_add = """  /api/v1/locations/{loc_id}/scheduled-order-settings:
    get:
      summary: Get Scheduled Order Settings
      operationId: getScheduledOrderSettings
      x-required-permission: online_ordering.settings.read
      security:
      - staffSession: []
      parameters:
      - name: loc_id
        in: path
        required: true
        schema:
          type: string
          format: uuid
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ScheduledOrderSettingsRow'
    put:
      summary: Update Scheduled Order Settings
      operationId: updateScheduledOrderSettings
      x-required-permission: online_ordering.settings.write
      security:
      - staffSession: []
      parameters:
      - name: loc_id
        in: path
        required: true
        schema:
          type: string
          format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ScheduledOrderSettingsRow'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ScheduledOrderSettingsRow'
"""

if "/api/v1/locations/{loc_id}/scheduled-order-settings:" not in content:
    content = content.replace("  /api/v1/locations/{loc_id}/online-orders/checkout:", endpoints_to_add + "  /api/v1/locations/{loc_id}/online-orders/checkout:")


with open('packages/contracts/openapi.yaml', 'w') as f:
    f.write(content)
print("done")
