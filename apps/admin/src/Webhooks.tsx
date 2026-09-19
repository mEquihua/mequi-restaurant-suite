import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiFetch } from './api.js';

type WebhookSubscription = {
  id: string;
  organization_id: string;
  url: string;
  event_types: string[];
  is_active: boolean;
  version: number;
};

export function Webhooks({
  permissions,
  organizationId,
}: {
  permissions: string[];
  organizationId: string;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>();
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const webhooks = useQuery({
    queryKey: ['webhooks', organizationId],
    queryFn: () =>
      apiFetch<{ data: WebhookSubscription[] }>(`/api/v1/organizations/${organizationId}/webhooks`),
    enabled: !!organizationId,
  });

  const create = useMutation({
    mutationFn: (body: { url: string; event_types: string[]; is_active: boolean }) =>
      apiFetch<{ subscription: WebhookSubscription; secret: string }>(
        `/api/v1/organizations/${organizationId}/webhooks`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (data) => {
      setNewSecret(data.secret);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: setError,
  });

  const update = useMutation({
    mutationFn: (args: {
      id: string;
      version: number;
      body: { url: string; event_types: string[]; is_active: boolean };
    }) =>
      apiFetch<WebhookSubscription>(`/api/v1/organizations/${organizationId}/webhooks/${args.id}`, {
        method: 'PUT',
        headers: { 'If-Match': `"${args.version}"` },
        body: JSON.stringify(args.body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: setError,
  });

  const rotate = useMutation({
    mutationFn: (args: { id: string; version: number }) =>
      apiFetch<{ subscription: WebhookSubscription; secret: string }>(
        `/api/v1/organizations/${organizationId}/webhooks/${args.id}/rotate-secret`,
        {
          method: 'POST',
          headers: { 'If-Match': `"${args.version}"` },
        },
      ),
    onSuccess: (data) => {
      setNewSecret(data.secret);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: setError,
  });

  if (!permissions.includes('integrations.webhooks.read'))
    return (
      <section>
        <h2>No Webhooks access</h2>
      </section>
    );

  return (
    <section>
      <h2>Integrations & Webhooks</h2>
      {!!error && <pre className="error">{JSON.stringify(error, null, 2)}</pre>}
      {newSecret && (
        <div
          style={{
            padding: '1rem',
            background: '#ffe',
            border: '1px solid #cc0',
            marginBottom: '1rem',
          }}
        >
          <strong>Webhook Secret Generated!</strong>
          <p>Please copy this secret now. It will not be shown again.</p>
          <pre>{newSecret}</pre>
          <button onClick={() => setNewSecret(null)}>Dismiss</button>
        </div>
      )}

      {permissions.includes('integrations.webhooks.write') && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            create.mutate({
              url: fd.get('url') as string,
              event_types: (fd.get('event_types') as string)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              is_active: fd.get('is_active') === 'on',
            });
            e.currentTarget.reset();
          }}
          style={{ display: 'grid', gap: '0.5rem', maxWidth: '400px', marginBottom: '2rem' }}
        >
          <h3>Add Webhook</h3>
          <label>
            URL: <input name="url" required type="url" />
          </label>
          <label>
            Event Types (comma-separated):{' '}
            <input name="event_types" required placeholder="account.paid, payment.received" />
          </label>
          <label>
            <input name="is_active" type="checkbox" defaultChecked /> Active
          </label>
          <button type="submit">Create Subscription</button>
        </form>
      )}

      {webhooks.data?.data.map((sub) => (
        <form
          key={sub.id}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            update.mutate({
              id: sub.id,
              version: sub.version,
              body: {
                url: fd.get('url') as string,
                event_types: (fd.get('event_types') as string)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                is_active: fd.get('is_active') === 'on',
              },
            });
          }}
          style={{
            border: '1px solid #ccc',
            padding: '1rem',
            marginBottom: '1rem',
            maxWidth: '400px',
          }}
        >
          <label style={{ display: 'block' }}>
            URL:{' '}
            <input
              name="url"
              defaultValue={sub.url}
              disabled={!permissions.includes('integrations.webhooks.write')}
            />
          </label>
          <label style={{ display: 'block' }}>
            Events:{' '}
            <input
              name="event_types"
              defaultValue={sub.event_types.join(', ')}
              disabled={!permissions.includes('integrations.webhooks.write')}
            />
          </label>
          <label style={{ display: 'block' }}>
            <input
              name="is_active"
              type="checkbox"
              defaultChecked={sub.is_active}
              disabled={!permissions.includes('integrations.webhooks.write')}
            />{' '}
            Active
          </label>
          {permissions.includes('integrations.webhooks.write') && (
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
              <button type="submit">Save</button>
              <button
                type="button"
                onClick={() => {
                  if (confirm('Rotate secret? Old secret will immediately invalidate.')) {
                    rotate.mutate({ id: sub.id, version: sub.version });
                  }
                }}
              >
                Rotate Secret
              </button>
            </div>
          )}
        </form>
      ))}
    </section>
  );
}
