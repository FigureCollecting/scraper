/**
 * QB-U30b extends the hostClock block QB-U30a's tests pin with toEqual: sends60m names every caller,
 * and each host line carries the constrained gaps, the clock refusals per caller and the listing p99 /
 * /lookup p95 inputs. These are their idle values, spread into QB-U30a's expectations unchanged.
 */
export const U30B_SENDS = {
  catalogListing: 0,
  catalogSeed: 0,
  catalogRotating: 0,
  resolve: 0,
  scrape: 0,
  lookup: 0,
  fetchBody: 0,
  sessionPrime: 0,
  pluginRoute: 0,
};

export const U30B_FIELDS = {
  constrainedGaps60m: 0,
  meanConstrainedGapMs60m: 0,
  clockRefusals60m: { queue: 0, image: 0, ...U30B_SENDS },
  listingFetchP99Ms60m: 0,
  lookupP95Ms60m: 0,
};
