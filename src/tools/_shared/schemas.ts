import { z } from 'zod';

export const UserIdentifier = z.string().min(1).describe(
  'Okta user ID (00u...), email address, or login'
);

export const GroupIdentifier = z.string().min(1).describe(
  'Okta group ID (00g...) or exact group name'
);

export const AppId = z.string().regex(/^0oa[a-zA-Z0-9]+$/).describe(
  'Okta application ID starting with 0oa'
);

export const FactorId = z.string().min(1).describe('Okta factor ID');

export const IsoDateTime = z.string().datetime({ offset: true }).describe(
  'ISO 8601 datetime with timezone offset'
);

export const PaginationInput = z.object({
  limit: z.number().int().min(1).max(200).default(25),
  cursor: z.string().optional(),
});

export const SearchMode = z.enum(['q', 'filter', 'search']).default('search');

export const ToolError = z.object({
  code: z.string(),
  message: z.string(),
  oktaRequestId: z.string().optional(),
  details: z.unknown().optional(),
});

export function PaginatedOutput<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
    totalCountHint: z.number().optional(),
  });
}

export function ToolResult<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: ToolError }),
  ]);
}
