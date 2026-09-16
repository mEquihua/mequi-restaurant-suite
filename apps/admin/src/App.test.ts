import { describe, expect, it } from 'vitest';
import { navForPermissions, reportRange } from './App.js';

describe('Admin access and report filters', () => {
  it('only exposes navigation sections the current role can read', () => {
    expect(navForPermissions(['menu.catalog.read', 'reports.sales.read']).map(([name]) => name)).toEqual(['Menu', 'Reports']);
  });

  it('serializes an inclusive UTC date range and rejects reversed ranges', () => {
    expect(reportRange('2026-09-01', '2026-09-02')).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z' });
    expect(() => reportRange('2026-09-02', '2026-09-01')).toThrow('valid date range');
  });
});
