import yaml
import sys
import collections

# Using a simple yaml parser that doesn't mess up too much, though ruamel.yaml is better if available.
# Actually, the python yaml module does not preserve formatting by default. Let's just append to the file
# and do string replacements to insert into paths and components.

with open('packages/contracts/openapi.yaml', 'r') as f:
    content = f.read()

paths_str = """
  /api/v1/promotions:
    get:
      operationId: listPromotions
      x-required-permission: promotions.promotions.read
      security:
      - staffSession: []
      responses:
        '200':
          description: Promotions list
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PromotionsListResponse'
        '401':
          $ref: '#/components/responses/Error'
        '403':
          $ref: '#/components/responses/Error'
    post:
      operationId: createPromotion
      x-required-permission: promotions.promotions.write
      security:
      - staffSession: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PromotionInput'
      responses:
        '201':
          description: Promotion created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Promotion'
        '400':
          $ref: '#/components/responses/Error'
        '401':
          $ref: '#/components/responses/Error'
        '403':
          $ref: '#/components/responses/Error'
  /api/v1/promotions/{id}:
    get:
      operationId: getPromotion
      x-required-permission: promotions.promotions.read
      security:
      - staffSession: []
      parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
          format: uuid
      responses:
        '200':
          description: Promotion retrieved
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Promotion'
        '401':
          $ref: '#/components/responses/Error'
        '403':
          $ref: '#/components/responses/Error'
        '404':
          $ref: '#/components/responses/Error'
    put:
      operationId: updatePromotion
      x-required-permission: promotions.promotions.write
      security:
      - staffSession: []
      parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
          format: uuid
      - $ref: '#/components/parameters/IfMatch'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PromotionInput'
      responses:
        '200':
          description: Promotion updated
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Promotion'
        '400':
          $ref: '#/components/responses/Error'
        '401':
          $ref: '#/components/responses/Error'
        '403':
          $ref: '#/components/responses/Error'
        '404':
          $ref: '#/components/responses/Error'
        '409':
          $ref: '#/components/responses/Error'
        '428':
          $ref: '#/components/responses/Error'
"""

components_str = """
    PromotionsListResponse:
      type: array
      items:
        $ref: '#/components/schemas/Promotion'
    Promotion:
      type: object
      required:
      - id
      - name
      - discount_type
      - discount_value
      - is_active
      - version
      properties:
        id:
          type: string
          format: uuid
        name:
          type: string
        description:
          type: string
          nullable: true
        discount_type:
          type: string
          enum: [PERCENTAGE, AMOUNT]
        discount_value:
          type: integer
        category_id:
          type: string
          format: uuid
          nullable: true
        product_id:
          type: string
          format: uuid
          nullable: true
        is_active:
          type: boolean
        starts_at:
          type: string
          format: date-time
          nullable: true
        ends_at:
          type: string
          format: date-time
          nullable: true
        days_of_week:
          type: array
          items:
            type: integer
          nullable: true
        start_time:
          type: string
          nullable: true
        end_time:
          type: string
          nullable: true
        version:
          type: integer
    PromotionInput:
      type: object
      required:
      - name
      - discount_type
      - discount_value
      - is_active
      properties:
        name:
          type: string
        description:
          type: string
          nullable: true
        discount_type:
          type: string
          enum: [PERCENTAGE, AMOUNT]
        discount_value:
          type: integer
        category_id:
          type: string
          format: uuid
          nullable: true
        product_id:
          type: string
          format: uuid
          nullable: true
        is_active:
          type: boolean
        starts_at:
          type: string
          format: date-time
          nullable: true
        ends_at:
          type: string
          format: date-time
          nullable: true
        days_of_week:
          type: array
          items:
            type: integer
          nullable: true
        start_time:
          type: string
          nullable: true
        end_time:
          type: string
          nullable: true
"""

# Insert paths_str right after "paths:"
content = content.replace('paths:\n', 'paths:\n' + paths_str)

# Insert components_str right after "  schemas:"
content = content.replace('  schemas:\n', '  schemas:\n' + components_str)

with open('packages/contracts/openapi.yaml', 'w') as f:
    f.write(content)
