export type WatchlistItem = Readonly<{
  id: string;
  type: "anchor" | "corridor";
  slug: string;
  name: string;
}>;

export type WatchlistStore = Readonly<{
  items: readonly WatchlistItem[];
  add: (item: WatchlistItem) => WatchlistStore;
  remove: (slug: string) => WatchlistStore;
}>;

export function createWatchlistStore(
  storageKey: string = "stellarcore-watchlist",
): WatchlistStore {
  let _items: WatchlistItem[] = [];

  // Initialize from storage
  try {
    const stored = typeof window !== "undefined"
      ? localStorage.getItem(storageKey)
      : null;
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null) {
        _items = (parsed as readonly WatchlistItem[]).filter(
          (item): item is WatchlistItem => {
            return (
              item &&
              typeof item.id === "string" &&
              typeof item.type === "string" &&
              (item.type === "anchor" || item.type === "corridor") &&
              typeof item.slug === "string" &&
              typeof item.name === "string"
            );
          },
        );
      }
    }
  } catch {
    // Corrupt storage - safely ignore, _items stays as empty array
  }

  const add = (item: WatchlistItem): WatchlistStore => {
    // Validate slug pattern
    const validSlug = item.slug.length > 0
      && item.slug.length <= 100
      && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug);

    if (!validSlug) {
      return { ...store, items: store.items };
    }

    // Check for duplicate
    const exists = store.items.some((i) => i.slug === item.slug);
    if (exists) {
      return { ...store, items: store.items };
    }

    const newItems = [...store.items, item];
    try {
      typeof window !== "undefined" && localStorage.setItem(storageKey, JSON.stringify(newItems));
    } catch {
      // Storage unavailable - silently ignore
    }
    return { ...store, items: newItems };
  };

  const remove = (slug: string): WatchlistStore => {
    const newItems = store.items.filter((item) => item.slug !== slug);
    try {
      typeof window !== "undefined" && localStorage.setItem(storageKey, JSON.stringify(newItems));
    } catch {
      // Storage unavailable - silently ignore
    }
    return { ...store, items: newItems };
  };

  const store: WatchlistStore = {
    items: _items,
    add,
    remove,
  };

  return store;
}