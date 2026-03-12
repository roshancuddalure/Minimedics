const fs = require('fs');
const path = require('path');

const TAXONOMY_FILE_PATH = path.join(__dirname, '..', 'data', 'medical-taxonomy.json');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeSubspecialtyEntry(entry) {
  if (typeof entry === 'string') {
    const name = normalizeName(entry);
    return name ? { name, slug: slugify(name) } : null;
  }
  const name = normalizeName(entry && entry.name);
  if (!name) return null;
  return {
    name,
    slug: normalizeName(entry.slug) || slugify(name)
  };
}

function normalizeSpecialtyEntry(entry) {
  const name = normalizeName(entry && entry.name);
  if (!name) return null;
  const subspecialties = Array.isArray(entry.subspecialties)
    ? entry.subspecialties.map(normalizeSubspecialtyEntry).filter(Boolean)
    : [];
  return {
    name,
    slug: normalizeName(entry.slug) || slugify(name),
    subspecialties
  };
}

function loadMedicalTaxonomy() {
  const raw = JSON.parse(fs.readFileSync(TAXONOMY_FILE_PATH, 'utf8'));
  const domains = Array.isArray(raw.domains) ? raw.domains : [];
  const normalizedDomains = domains
    .map((domain, domainIndex) => {
      const name = normalizeName(domain && domain.name);
      if (!name) return null;
      const specialties = Array.isArray(domain.specialties)
        ? domain.specialties.map(normalizeSpecialtyEntry).filter(Boolean)
        : [];
      return {
        name,
        slug: normalizeName(domain.slug) || slugify(name),
        sortOrder: domainIndex + 1,
        specialties
      };
    })
    .filter(Boolean);
  return {
    version: normalizeName(raw.version) || '',
    sourceDocument: normalizeName(raw.sourceDocument) || '',
    filePath: TAXONOMY_FILE_PATH,
    domains: normalizedDomains
  };
}

function saveMedicalTaxonomy(catalog) {
  const domains = Array.isArray(catalog && catalog.domains) ? catalog.domains : [];
  const payload = {
    version: normalizeName(catalog && catalog.version) || new Date().toISOString().slice(0, 10),
    sourceDocument: normalizeName(catalog && catalog.sourceDocument) || 'Mednecta Medical Taxonomy Implementation Document',
    domains: domains.map((domain) => ({
      name: normalizeName(domain && domain.name),
      slug: normalizeName(domain && domain.slug) || slugify(domain && domain.name),
      specialties: (Array.isArray(domain && domain.specialties) ? domain.specialties : []).map((specialty) => ({
        name: normalizeName(specialty && specialty.name),
        slug: normalizeName(specialty && specialty.slug) || slugify(specialty && specialty.name),
        subspecialties: (Array.isArray(specialty && specialty.subspecialties) ? specialty.subspecialties : []).map((subspecialty) => ({
          name: normalizeName(subspecialty && subspecialty.name),
          slug: normalizeName(subspecialty && subspecialty.slug) || slugify(subspecialty && subspecialty.name)
        }))
      }))
    }))
  };
  fs.writeFileSync(TAXONOMY_FILE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function flattenMedicalTaxonomy(catalog) {
  const domains = [];
  const specialties = [];
  const subspecialties = [];
  (catalog.domains || []).forEach((domain, domainIndex) => {
    domains.push({
      ...domain,
      sortOrder: domainIndex + 1
    });
    (domain.specialties || []).forEach((specialty, specialtyIndex) => {
      specialties.push({
        ...specialty,
        domainSlug: domain.slug,
        domainName: domain.name,
        sortOrder: specialtyIndex + 1
      });
      (specialty.subspecialties || []).forEach((subspecialty, subspecialtyIndex) => {
        subspecialties.push({
          ...subspecialty,
          domainSlug: domain.slug,
          domainName: domain.name,
          specialtySlug: specialty.slug,
          specialtyName: specialty.name,
          sortOrder: subspecialtyIndex + 1
        });
      });
    });
  });
  return { domains, specialties, subspecialties };
}

function getTaxonomyDisplayLabel(selection) {
  if (!selection) return '';
  const specialtyName = normalizeName(selection.specialty_name || selection.specialtyName);
  const subspecialtyName = normalizeName(selection.subspecialty_name || selection.subspecialtyName);
  const domainName = normalizeName(selection.domain_name || selection.domainName);
  if (specialtyName && subspecialtyName) return `${specialtyName} - ${subspecialtyName}`;
  if (specialtyName) return specialtyName;
  if (domainName) return domainName;
  return '';
}

function getTaxonomySearchLabel(selection) {
  if (!selection) return '';
  return normalizeName(selection.specialty_name || selection.specialtyName || selection.domain_name || selection.domainName);
}

module.exports = {
  TAXONOMY_FILE_PATH,
  flattenMedicalTaxonomy,
  getTaxonomyDisplayLabel,
  getTaxonomySearchLabel,
  loadMedicalTaxonomy,
  saveMedicalTaxonomy,
  slugify
};
