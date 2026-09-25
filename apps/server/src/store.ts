import type { Address, Hex32, Preview, ResolutionDelivery } from "@lemma/core";

/**
 * Where offer-bearing previews are kept, so the paid path can quote exactly
 * what was previewed. Previews without an offer are not stored. `getPreview`
 * returns a stored preview even after its offer expired; the caller decides.
 */
export interface PreviewStore {
  saveOffer(preview: Preview): Promise<void>;
  getPreview(previewId: Hex32): Promise<Preview | undefined>;
}

/** Recovery backend for `lemma_recover_resolution`: settled resolutions only. */
export interface ResolutionReader {
  recover(previewId: Hex32, buyer: Address): Promise<ResolutionDelivery | "IN_FLIGHT" | "NOT_FOUND">;
}

/** A reader with nothing to recover, for tests of the preview path alone. */
export const noResolutions: ResolutionReader = {
  async recover() {
    return "NOT_FOUND";
  },
};
