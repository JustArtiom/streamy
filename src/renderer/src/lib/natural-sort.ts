const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** "Episode 2" before "Episode 10" (plain sorting puts 10 first). */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/** A sorted copy; the input stays as it was. */
export function naturalSortBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)));
}
