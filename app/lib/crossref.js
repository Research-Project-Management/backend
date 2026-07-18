import { AppError } from "./AppError.js";

export class CrossrefClient {
  constructor() {
    this.apiUrl = "https://api.crossref.org";
    this.userAgent = "Flux/1.0 (mailto:support@aisq.dev)";
  }

  _firstString(...args) {
    return args.find((a) => typeof a === "string" && a.trim() !== "");
  }

  _parseWork(item) {
    if (!item.title || !item.title.length) return null;
    
    let year = null;
    const dates = [
      item["published-print"]?.["date-parts"]?.[0]?.[0],
      item["published-online"]?.["date-parts"]?.[0]?.[0],
      item["issued"]?.["date-parts"]?.[0]?.[0],
    ];
    
    for (const d of dates) {
      if (d && !isNaN(d)) { 
        year = parseInt(d, 10); 
        break; 
      }
    }

    return {
      title: item.title[0],
      authors: (item.author || []).map((a) => {
        if (a.family && a.given) return `${a.family}, ${a.given}`;
        if (a.family) return a.family;
        if (a.name) return a.name;
        return "Unknown";
      }),
      doi: item.DOI || "",
      journal: this._firstString(item["container-title"]?.[0], item.publisher),
      year,
      type: item.type || "",
      abstract: item.abstract?.replace(/<[^>]+>/g, "") || "",
      url: item.URL || item.url || "",
    };
  }

  async search(query, rows = 5) {
    const url = `${this.apiUrl}/works?query=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,editor,issued,published,published-print,published-online,container-title,publisher,publisher-location,ISSN,ISBN,volume,issue,page,type,abstract,URL,score,language,short-container-title,short-title,license,subject`;
    const response = await fetch(url, { headers: { "User-Agent": this.userAgent } });
    
    if (!response.ok) {
      throw new AppError(`Crossref API error: ${response.status}`, response.status);
    }
    
    const data = await response.json();
    const items = data?.message?.items || [];
    const totalResults = data?.message?.["total-results"] || 0;
    
    return { 
      works: items.map(item => this._parseWork(item)).filter(Boolean), 
      totalResults 
    };
  }

  async getByDoi(rawDoi) {
    let cleanDoi = rawDoi.trim();
    try {
      let decoded = decodeURIComponent(cleanDoi).trim();
      if (decoded.includes("%")) decoded = decodeURIComponent(decoded).trim();
      cleanDoi = decoded;
    } catch (e) {}
    cleanDoi = cleanDoi.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").trim();

    const url = `https://doi.org/${cleanDoi}`;
    const response = await fetch(url, { headers: { Accept: "application/vnd.citationstyles.csl+json", "User-Agent": this.userAgent } });
    
    if (response.ok) {
      const data = await response.json();
      return { work: this._parseWork(data) };
    }

    const fallbackUrl = `${this.apiUrl}/works/${encodeURIComponent(cleanDoi)}`;
    const fallbackResponse = await fetch(fallbackUrl, { headers: { "User-Agent": this.userAgent } });
    
    if (!fallbackResponse.ok) {
      throw new AppError(`Crossref API error: ${fallbackResponse.status}`, fallbackResponse.status);
    }
    
    const fallbackData = await fallbackResponse.json();
    return { work: this._parseWork(fallbackData?.message || {}) };
  }
}


