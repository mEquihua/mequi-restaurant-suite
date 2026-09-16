import { Button } from '@restaurant-suite/ui-primitives';
import { tokens } from '@restaurant-suite/ui-tokens';
export function App() {
  return (
    <main style={{ fontFamily: tokens.font.sans, padding: tokens.space[8] }}>
      <h1>Restaurant Suite — Customer</h1>
      <p>Customer PWA shell is ready for future modules.</p>
      <Button onClick={() => undefined}>Placeholder action</Button>
    </main>
  );
}
