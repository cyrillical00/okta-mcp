import type { Collection } from '@okta/okta-sdk-nodejs';

export interface PageResult<T> {
  items: T[];
  nextCursor?: string;
}

export async function collectPage<T>(
  collection: Collection<T>,
  limit: number,
  _cursor?: string
): Promise<PageResult<T>> {
  const items: T[] = [];
  for await (const item of collection) {
    if (item == null) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  return { items };
}

export async function collectAll<T>(collection: Collection<T>, max = 1000): Promise<T[]> {
  const items: T[] = [];
  for await (const item of collection) {
    if (item == null) continue;
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
}
