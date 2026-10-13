// The shape every CLOZR screen renders from. Inferred from the view-model hook
// so the screens and the logic can never drift apart.
import type { useClozr } from './useClozr';

export type ClozrView = ReturnType<typeof useClozr>;
