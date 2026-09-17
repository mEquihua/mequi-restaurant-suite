import re

with open('apps/admin/src/App.tsx', 'r') as f:
    content = f.read()

nav_item = "    ['Scheduled Orders', '/scheduled-orders', 'online_ordering.settings.read'],\n"
if "/scheduled-orders" not in content:
    content = content.replace("    ['Reservations', '/reservations', 'reservations.settings.read'],", "    ['Reservations', '/reservations', 'reservations.settings.read'],\n" + nav_item)

route_item = "          <Route path=\"/scheduled-orders\" element={<ScheduledOrders permissions={me.permissions} locationId={me.location_id} />} />\n"
if "path=\"/scheduled-orders\"" not in content:
    content = content.replace("          <Route path=\"/reservations\" element={<Reservations permissions={me.permissions} locationId={me.location_id} />} />", "          <Route path=\"/reservations\" element={<Reservations permissions={me.permissions} locationId={me.location_id} />} />\n" + route_item)

component = """
type ScheduledOrderSettings = {
  accepts_scheduled_orders: boolean;
  minimum_lead_time_minutes: number;
  maximum_lead_time_days: number;
  operating_hours: Array<{ day_of_week: number; open_time: string; close_time: string }>;
  version: number;
};

function ScheduledOrders({ permissions, locationId }: { permissions: string[]; locationId: string }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['scheduled-order-settings', locationId],
    queryFn: () => apiFetch<ScheduledOrderSettings>(`/api/v1/locations/${locationId}/scheduled-order-settings`),
  });

  const write = permissions.includes('online_ordering.settings.write');
  const form = settings.data;

  const save = useMutation({
    mutationFn: async () => {
      await apiFetch(`/api/v1/locations/${locationId}/scheduled-order-settings`, {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      void qc.invalidateQueries({ queryKey: ['scheduled-order-settings', locationId] });
    },
  });

  if (settings.isLoading) return <div className="p-4">Loading...</div>;
  if (!form) return <div className="p-4">Error loading settings.</div>;

  return (
    <div className="p-4 max-w-2xl">
      <h2 className="text-2xl font-bold mb-6">Scheduled Orders Configuration</h2>
      <div className="space-y-6">
        <label className="flex items-center space-x-2">
          <input
            type="checkbox"
            checked={form.accepts_scheduled_orders}
            onChange={(e) => qc.setQueryData(['scheduled-order-settings', locationId], { ...form, accepts_scheduled_orders: e.target.checked })}
            disabled={!write}
          />
          <span className="font-medium">Accept Scheduled Orders</span>
        </label>
        
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Minimum Lead Time (minutes)</label>
            <input
              type="number"
              className="w-full border rounded p-2"
              value={form.minimum_lead_time_minutes}
              onChange={(e) => qc.setQueryData(['scheduled-order-settings', locationId], { ...form, minimum_lead_time_minutes: +e.target.value })}
              disabled={!write}
              min="1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Maximum Lead Time (days)</label>
            <input
              type="number"
              className="w-full border rounded p-2"
              value={form.maximum_lead_time_days}
              onChange={(e) => qc.setQueryData(['scheduled-order-settings', locationId], { ...form, maximum_lead_time_days: +e.target.value })}
              disabled={!write}
              min="1"
            />
          </div>
        </div>
        
        <div>
          <h3 className="text-lg font-medium mb-2">Operating Hours</h3>
          <div className="space-y-2">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
              const h = form.operating_hours.find((x) => x.day_of_week === day);
              const name = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day - 1];
              return (
                <div key={day} className="flex items-center space-x-4">
                  <label className="w-16 flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={!!h}
                      disabled={!write}
                      onChange={(e) => {
                        const next = form.operating_hours.filter((x) => x.day_of_week !== day);
                        if (e.target.checked) next.push({ day_of_week: day, open_time: '09:00', close_time: '17:00' });
                        qc.setQueryData(['scheduled-order-settings', locationId], { ...form, operating_hours: next });
                      }}
                    />
                    <span>{name}</span>
                  </label>
                  {h && (
                    <>
                      <input
                        type="time"
                        className="border rounded p-1"
                        value={h.open_time}
                        disabled={!write}
                        onChange={(e) => {
                          const next = form.operating_hours.map((x) => (x.day_of_week === day ? { ...x, open_time: e.target.value } : x));
                          qc.setQueryData(['scheduled-order-settings', locationId], { ...form, operating_hours: next });
                        }}
                      />
                      <span>to</span>
                      <input
                        type="time"
                        className="border rounded p-1"
                        value={h.close_time}
                        disabled={!write}
                        onChange={(e) => {
                          const next = form.operating_hours.map((x) => (x.day_of_week === day ? { ...x, close_time: e.target.value } : x));
                          qc.setQueryData(['scheduled-order-settings', locationId], { ...form, operating_hours: next });
                        }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {write && (
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="bg-blue-600 text-white px-4 py-2 rounded font-medium disabled:opacity-50"
          >
            {save.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        )}
      </div>
    </div>
  );
}
"""

if "function ScheduledOrders" not in content:
    content = content + component

with open('apps/admin/src/App.tsx', 'w') as f:
    f.write(content)
print("done")
