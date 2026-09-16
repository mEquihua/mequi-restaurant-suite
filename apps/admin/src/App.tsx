import { AdminButton } from '@restaurant-suite/ui-admin';
import { tokens } from '@restaurant-suite/ui-tokens';

export function App() {
  return (
    <main style={{ fontFamily: tokens.font.sans, padding: tokens.space[8] }}>
      <h1>Restaurant Suite — Admin</h1>
      <p>Admin PWA shell is ready for future modules.</p>
      <AdminButton onClick={() => undefined}>Placeholder action</AdminButton>
    </main>
  );
}
