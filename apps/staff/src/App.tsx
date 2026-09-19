import { TimeclockWidget } from './TimeclockWidget.js';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Routes, Route, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { apiFetch, getSessionToken, getTerminalCredential, setTerminalCredential, setSessionToken, clearSessionToken } from './api.js';
import { WaiterMode } from './waiter/WaiterMode.js';
import { POSMode } from './pos/POSMode.js';
import { HostMode } from './host/HostMode.js';

const queryClient = new QueryClient();

function EnrollmentScreen() {
  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (token === 'dev') {
        // Fast path for dev testing
        setTerminalCredential({ terminal_id: 'test_terminal', secret: 'test_secret_1234567890123456789012345678901234567890123456789012345678901234567890' });
        window.location.reload();
        return;
      }
      setSessionToken(token);
      const res = await apiFetch<{ terminal: { id: string }, terminal_credential: string }>('/api/v1/terminals/enroll', {
        method: 'POST',
        body: JSON.stringify({ location_id: locationId, name }),
      });
      setTerminalCredential({ terminal_id: res.terminal.id, secret: res.terminal_credential });
      window.location.reload();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to enroll terminal');
      clearSessionToken();
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h1>Enroll Terminal</h1>
      {error && <div style={{ color: 'red' }}>{error}</div>}
      <form onSubmit={handleEnroll} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '400px' }}>
        <input placeholder="Admin Session Token (or 'dev')" value={token} onChange={(e) => setToken(e.target.value)} required />
        <input placeholder="Location ID" value={locationId} onChange={(e) => setLocationId(e.target.value)} />
        <input placeholder="Terminal Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Enroll</button>
      </form>
    </div>
  );
}

function PinUnlockScreen() {
  const [staffId, setStaffId] = useState('5ee03c24-3df0-42cb-9664-e31a1387c450'); // Dev default
  const [pin, setPin] = useState('1234');
  const [error, setError] = useState('');

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const cred = getTerminalCredential();
      if (!cred) throw new Error('No terminal credential found');
      
      const res = await apiFetch<unknown>('/api/v1/auth/pin-unlock', {
        method: 'POST',
        headers: { 'x-terminal-credential': cred.secret },
        body: JSON.stringify({ staff_id: staffId, pin }),
      });
      
      setSessionToken((res as { token: string }).token);
      window.location.reload();
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to unlock');
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h1>PIN Unlock</h1>
      {error && <div style={{ color: 'red' }}>{error}</div>}
      <form onSubmit={handleUnlock} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '400px' }}>
        <input placeholder="Staff ID (UUID)" value={staffId} onChange={(e) => setStaffId(e.target.value)} required />
        <input placeholder="PIN" type="password" value={pin} onChange={(e) => setPin(e.target.value)} required />
        <button type="submit">Unlock</button>
      </form>
    </div>
  );
}

function ModeSwitcher({ hasWaiter, hasPos, hasHost }: { hasWaiter: boolean; hasPos: boolean; hasHost: boolean }) {
  const navigate = useNavigate();
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Select Mode</h1>
      {hasWaiter && <button onClick={() => navigate('/waiter')} style={{ marginRight: '1rem', padding: '1rem' }}>Waiter Mode</button>}
      {hasPos && <button onClick={() => navigate('/pos')} style={{ marginRight: '1rem', padding: '1rem' }}>POS Mode</button>}
      {hasHost && <button onClick={() => navigate('/host')} style={{ padding: '1rem' }}>Host Mode</button>}
    </div>
  );
}

function MainApp() {
  const { data: user, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<unknown>('/api/v1/auth/me'),
  });

  if (isLoading) return <div>Loading...</div>;
  if (!user) return <div>Error loading user profile</div>;

  const typedUser = user as {
    permissions: string[];
    location_id: string;
    app_target: string | null;
    profile_config: unknown | null;
  };
  const hasWaiter = typedUser.permissions.includes('orders.visits.create');
  const hasPos = typedUser.permissions.includes('orders.orders.create');
  const hasHost = typedUser.permissions.includes('reservations.reservations.read');
  

  const clockWidget = <TimeclockWidget locationId={typedUser.location_id} permissions={typedUser.permissions} />;

  const modeCount = [hasWaiter, hasPos, hasHost].filter(Boolean).length;

  const forcedHost =
    typedUser.app_target === 'STAFF' &&
    typeof typedUser.profile_config === 'object' &&
    typedUser.profile_config !== null &&
    !Array.isArray(typedUser.profile_config) &&
    (typedUser.profile_config as { mode?: unknown }).mode === 'HOST' &&
    Object.keys(typedUser.profile_config).length === 1;
  if (forcedHost)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '1rem', borderBottom: '1px solid #ccc' }}>
          {clockWidget}
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <Routes>
            <Route path="/host/*" element={<HostMode locationId={typedUser.location_id} />} />
            <Route path="*" element={<Navigate replace to="/host" />} />
          </Routes>
        </div>
      </div>
    );

  
  if (modeCount > 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '1rem', borderBottom: '1px solid #ccc' }}>
          {clockWidget}
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<ModeSwitcher hasWaiter={hasWaiter} hasPos={hasPos} hasHost={hasHost} />} />
            <Route path="/waiter/*" element={<WaiterMode locationId={typedUser.location_id} />} />
            <Route path="/pos/*" element={<POSMode locationId={typedUser.location_id} />} />
            <Route path="/host/*" element={<HostMode locationId={typedUser.location_id} />} />
          </Routes>
        </div>
      </div>
    );
  }

  const renderSingleMode = () => {
    if (hasWaiter) return <WaiterMode locationId={typedUser.location_id} />;
    if (hasPos) return <POSMode locationId={typedUser.location_id} />;
    if (hasHost) return <HostMode locationId={typedUser.location_id} />;
    return <div>You don't have access to any operational modes.</div>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '1rem', borderBottom: '1px solid #ccc' }}>
        {clockWidget}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {renderSingleMode()}
      </div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<'enroll' | 'unlock' | 'app'>('enroll');

  useEffect(() => {
    const cred = getTerminalCredential();
    const token = getSessionToken();
    if (!cred) {
      setState('enroll');
    } else if (!token) {
      setState('unlock');
    } else {
      setState('app');
    }

    const onUnauthorized = () => {
      setState('unlock');
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {state === 'enroll' && <EnrollmentScreen />}
        {state === 'unlock' && <PinUnlockScreen />}
        {state === 'app' && <MainApp />}
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
