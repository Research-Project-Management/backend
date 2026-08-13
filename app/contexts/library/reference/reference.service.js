import { CrossrefClient } from "../../../lib/crossref.js";

export class ReferenceService {
  constructor({ crossrefClient }) {
    this.crossrefClient = crossrefClient || new CrossrefClient();
  }

  async crossrefSearch(query, rows = 5) {
    if (this.crossrefClient) return this.crossrefClient.search(query, rows);
    return [];
  }

  async crossrefDoi(rawDoi) {
    if (this.crossrefClient) return this.crossrefClient.getByDoi(rawDoi);
    return null;
  }
}
