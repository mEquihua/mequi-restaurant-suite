with open('packages/contracts/openapi.yaml', 'r') as f:
    content = f.read()

content = content.replace("      - $ref: '#/components/parameters/IfMatch'", """      - name: If-Match
        in: header
        required: true
        schema:
          type: string
          pattern: '^"?[1-9][0-9]*"?$'""")

with open('packages/contracts/openapi.yaml', 'w') as f:
    f.write(content)
