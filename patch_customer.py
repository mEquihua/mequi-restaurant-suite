import re

with open('apps/customer/src/App.tsx', 'r') as f:
    content = f.read()

# I will replace the single input with a toggle
old_schedule_field = """          <label>
            Schedule for later (optional)
            <input name="scheduled_for" type="datetime-local" />
          </label>"""

new_schedule_field = """          <fieldset className="schedule-fieldset">
            <legend>When would you like this order?</legend>
            <div className="toggle">
              <button
                type="button"
                className={!isScheduled ? 'active' : ''}
                onClick={() => setIsScheduled(false)}
              >
                ASAP
              </button>
              <button
                type="button"
                className={isScheduled ? 'active' : ''}
                onClick={() => setIsScheduled(true)}
              >
                Scheduled
              </button>
            </div>
            {isScheduled && (
              <label>
                Select time:
                <input name="scheduled_for" type="datetime-local" required={isScheduled} />
              </label>
            )}
          </fieldset>"""

if "setIsScheduled" not in content:
    content = content.replace("const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');", "const [fulfillment, setFulfillment] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');\n  const [isScheduled, setIsScheduled] = useState(false);")
    content = content.replace("scheduled_for: data.get('scheduled_for')", "scheduled_for: isScheduled && data.get('scheduled_for')")
    content = content.replace(old_schedule_field, new_schedule_field)


with open('apps/customer/src/App.tsx', 'w') as f:
    f.write(content)
print("done")
