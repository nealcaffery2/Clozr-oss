// How agent prompts describe your company. Set these to your own markets.

export const COMPANY_STATES = ['Texas', 'Oklahoma'] as const;

/** One line for an agent's identity. */
export const COMPANY_KIND = 'a real estate investment company that buys houses';

/** The footprint, for a prompt to state as fact. */
export const COMPANY_FOOTPRINT = `The company buys houses in ${COMPANY_STATES.join(' and ')}.`;
