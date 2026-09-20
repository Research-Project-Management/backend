/**
 * Canonical Academic Polite Pool Email and User-Agent configuration.
 * Used for CrossRef, OpenAlex, PubMed, Unpaywall, DOI content negotiation,
 * Retraction Watch, and academic crawler polite pools.
 */
export function getAcademicContactEmail(): string {
  return (
    process.env.ACADEMIC_POLITE_EMAIL ||
    process.env.ACADEMIC_EMAIL ||
    process.env.CROSSREF_EMAIL ||
    'support@flux.study'
  );
}

export function getAcademicUserAgent(subsystem = 'Platform'): string {
  const email = getAcademicContactEmail();
  return `FluxResearch${subsystem}/1.0 (mailto:${email}; https://flux.study)`;
}
