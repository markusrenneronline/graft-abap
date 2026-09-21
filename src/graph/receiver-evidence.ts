import type { CallSiteV1 } from './types.js';

export function receiverEvidence(receiver: NonNullable<CallSiteV1['receiverType']>): { description: string; sourceLabel: string; hierarchyLabel: string } {
  const basis = receiver.basis ?? 'returning';
  const meaning = basis === 'new' ? 'NEW object type; successful construction not proven'
    : basis === 'cast' ? 'CAST target type; cast success and runtime subtype not proven'
    : basis === 'inline_returning' ? 'inline DATA type from RETURNING declaration; runtime subtype not inferred'
    : basis === 'inline_cast' ? 'inline DATA type from CAST; cast success and runtime subtype not proven'
    : basis === 'declaration' ? 'reference declaration; runtime subtype not inferred'
    : basis === 'inline_catch' ? 'inline CATCH type; handler execution and runtime subtype not proven'
    : basis === 'inherited_attribute' ? 'inherited attribute declaration; runtime subtype not inferred'
    : 'RETURNING declaration; runtime subtype not inferred';
  return {
    description: `Receiver static type: ${receiver.name} (${meaning}).`,
    hierarchyLabel: basis === 'inherited_attribute' ? 'Attribute inheritance' : 'Receiver type hierarchy',
    sourceLabel: basis === 'returning' || basis === 'inline_returning' ? 'Returning declaration'
      : basis === 'declaration' || basis === 'inherited_attribute' ? 'Reference declaration' : basis === 'inline_catch' ? 'CATCH declaration' : basis === 'inline_cast' ? 'CAST expression' : 'Receiver expression',
  };
}
