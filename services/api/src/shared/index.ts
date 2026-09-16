/** Public shared infrastructure entry point for API modules. */
export { createDatabase, installDatabase } from './database.js';
export type {
  Database,
  DatabaseOptions,
  DatabaseTransaction,
  CategoryTable,
  ProductTable,
  ProductVariantTable,
  ModifierGroupTable,
  ModifierTable,
  ProductComboGroupTable,
  ProductComboItemTable,
  LocationPriceOverrideTable,
  AvailabilityRuleTable,
  RoleTable,
  StaffTable,
  TerminalPinAttemptTable,
  TerminalTable,
} from './database.js';
