import type { Address, Hex32, Preview, ResolutionDelivery } from "@lemma/core";

/**
 * Where offer-bearing previews are kept until they expire, so the paid path can
 * quote exactly what was previewed. Previews without an offer are not stored.
 */
export interface PreviewStore {
  saveOffer(preview: Preview): Promise<void>;
  getOffer(previewId: Hex32): Promise<Preview | undefined>;
}

/** Recovery backend for `lemma_recover_resolution`: settled resolutions only. */
export interface ResolutionReader {
  recover(previewId: Hex32, buyer: Address): Promise<ResolutionDelivery | "IN_FLIGHT" | "NOT_FOUND">;
}

/** The most offers the memory store holds; beyond it, saving fails and the preview says so. */
export const MAX_MEMORY_OFFERS = 50_000;

/**
 * Process-memory preview store for development and tests. It is bounded:
 * expired offers are swept when the store fills, and past the cap a save
 * fails, so the preview answers with an error instead of the process growing
 * without limit.
 */
export class MemoryPreviewStore implements PreviewStore {
  private readonly offers = new Map<Hex32, Preview>();

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly capacity = MAX_MEMORY_OFFERS,
  ) {}

  async saveOffer(preview: Preview): Promise<void> {
    if (!("offer" in preview) || preview.offer === null) throw new Error("only offer-bearing previews are stored");
    if (this.offers.size >= this.capacity) {
      const now = this.clock().getTime();
      for (const [id, p] of this.offers) {
        if ("offer" in p && p.offer !== null && Date.parse(p.offer.validUntil) <= now) this.offers.delete(id);
      }
      if (this.offers.size >= this.capacity) throw new Error("the preview store is full");
    }
    this.offers.set(preview.previewId, preview);
  }

  get size(): number {
    return this.offers.size;
  }

  async getOffer(previewId: Hex32): Promise<Preview | undefined> {
    const preview = this.offers.get(previewId);
    if (preview === undefined || !("offer" in preview) || preview.offer === null) return undefined;
    if (Date.parse(preview.offer.validUntil) <= this.clock().getTime()) {
      this.offers.delete(previewId);
      return undefined;
    }
    return preview;
  }
}

/** Until persistence lands, nothing has been sold, so nothing can be recovered. */
export const noResolutions: ResolutionReader = {
  async recover() {
    return "NOT_FOUND";
  },
};
