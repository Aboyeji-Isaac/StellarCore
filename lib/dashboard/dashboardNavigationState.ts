/**
 * Dashboard panel navigation and fetch lifecycle state coordinator.
 *
 * Ensures obsolete in-flight requests never update an inactive or unmounted view,
 * coordinates cache and refresh policies when navigating away and returning,
 * maintains consistent loading/error states, and guarantees zero subscription leaks.
 */

export type PanelFetchStatus = "idle" | "loading" | "success" | "error";

export type PanelCachePolicy = "cache-first" | "network-first" | "no-cache";

export type DashboardPanelStateOptions<T> = Readonly<{
  cacheTtlMs?: number;
  cachePolicy?: PanelCachePolicy;
  initialData?: T;
}>;

export type DashboardPanelSnapshot<T> = Readonly<{
  status: PanelFetchStatus;
  data: T | null;
  error: string | null;
  isActive: boolean;
  visitCount: number;
  lastFetchedAt: number | null;
}>;

export type PanelStateSubscriber<T> = (snapshot: DashboardPanelSnapshot<T>) => void;

export class DashboardPanelCoordinator<T> {
  private status: PanelFetchStatus = "idle";
  private data: T | null = null;
  private error: string | null = null;
  private isActive = false;
  private currentVisitId = 0;
  private lastFetchedAt: number | null = null;
  private currentAbortController: AbortController | null = null;
  private subscribers = new Set<PanelStateSubscriber<T>>();

  readonly cacheTtlMs: number;
  readonly cachePolicy: PanelCachePolicy;

  constructor(options: DashboardPanelStateOptions<T> = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.cachePolicy = options.cachePolicy ?? "network-first";
    if (options.initialData !== undefined) {
      this.data = options.initialData;
      this.status = "success";
    }
  }

  /** Current state snapshot. */
  getSnapshot(): DashboardPanelSnapshot<T> {
    return Object.freeze({
      status: this.status,
      data: this.data,
      error: this.error,
      isActive: this.isActive,
      visitCount: this.currentVisitId,
      lastFetchedAt: this.lastFetchedAt,
    });
  }

  /** Returns number of active subscribers. */
  get activeSubscriptionCount(): number {
    return this.subscribers.size;
  }

  /** Subscribes a listener for state changes. Returns an unsubscribe function. */
  subscribe(subscriber: PanelStateSubscriber<T>): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private notify() {
    const snap = this.getSnapshot();
    for (const sub of this.subscribers) {
      sub(snap);
    }
  }

  /**
   * Called when the view becomes active (mounted or navigated to).
   * Evaluates cache/refresh policy and triggers fetch if needed.
   */
  async navigateIn(
    fetcher: (signal: AbortSignal) => Promise<T>,
    now: number = Date.now(),
  ): Promise<void> {
    this.currentVisitId += 1;
    const visitId = this.currentVisitId;
    this.isActive = true;

    // Check if cache is valid and policy allows cache-first reuse
    const isCacheValid =
      this.data !== null &&
      this.lastFetchedAt !== null &&
      now - this.lastFetchedAt < this.cacheTtlMs;

    if (this.cachePolicy === "cache-first" && isCacheValid) {
      this.status = "success";
      this.error = null;
      this.notify();
      return;
    }

    // Cancel any previous pending controller
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
    const controller = new AbortController();
    this.currentAbortController = controller;

    this.status = "loading";
    this.error = null;
    this.notify();

    try {
      const result = await fetcher(controller.signal);

      // Verify request is not obsolete (view must still be active and on same visit)
      if (!this.isActive || visitId !== this.currentVisitId) {
        // Obsolete request discarded safely
        return;
      }

      this.data = result;
      this.status = "success";
      this.error = null;
      this.lastFetchedAt = now;
      this.notify();
    } catch (err) {
      // If obsolete or aborted, ignore without updating view
      if (!this.isActive || visitId !== this.currentVisitId) {
        return;
      }

      if (err instanceof Error && err.name === "AbortError") {
        return;
      }

      this.status = "error";
      this.error = err instanceof Error ? err.message : "Unable to load data.";
      this.notify();
    } finally {
      if (this.currentAbortController === controller) {
        this.currentAbortController = null;
      }
    }
  }

  /**
   * Called when user navigates away from the view (unmounts).
   * Aborts in-flight operations and marks the view inactive.
   */
  navigateAway(): void {
    this.isActive = false;
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  /** Resets state entirely. */
  reset(): void {
    this.navigateAway();
    this.status = "idle";
    this.data = null;
    this.error = null;
    this.lastFetchedAt = null;
    this.currentVisitId = 0;
    this.notify();
  }
}
