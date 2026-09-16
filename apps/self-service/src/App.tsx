import { OperationsButton } from '@restaurant-suite/ui-operations';
import { tokens } from '@restaurant-suite/ui-tokens';
export function App() {
  return (
    <main style={{ fontFamily: tokens.font.sans, padding: tokens.space[8] }}>
      <h1>Restaurant Suite — Self-Service</h1>
      <p>Self-service PWA shell is ready for future modules.</p>
      <OperationsButton onClick={() => undefined}>Placeholder action</OperationsButton>
    </main>
  );
}
