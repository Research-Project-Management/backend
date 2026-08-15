export class ReferenceService {
  constructor({ crossrefClient }) {
    this.crossrefClient = crossrefClient;
  }

  async crossrefSearch(query, rows = 5) {
    return this.crossrefClient.search(query, rows);
  }

  async crossrefDoi(rawDoi) {
    return this.crossrefClient.getByDoi(rawDoi);
  }
}
