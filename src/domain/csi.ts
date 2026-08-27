/**
 * CSI MasterFormat divisions (2018 edition, the numbering GCs actually use).
 * Codes are validated, never silently rewritten: an unknown division keeps the
 * original text and gets flagged.
 */

export const CSI_DIVISIONS: Record<string, string> = {
  "00": "Procurement and Contracting Requirements",
  "01": "General Requirements",
  "02": "Existing Conditions",
  "03": "Concrete",
  "04": "Masonry",
  "05": "Metals",
  "06": "Wood, Plastics, and Composites",
  "07": "Thermal and Moisture Protection",
  "08": "Openings",
  "09": "Finishes",
  "10": "Specialties",
  "11": "Equipment",
  "12": "Furnishings",
  "13": "Special Construction",
  "14": "Conveying Equipment",
  "21": "Fire Suppression",
  "22": "Plumbing",
  "23": "Heating, Ventilating, and Air Conditioning (HVAC)",
  "25": "Integrated Automation",
  "26": "Electrical",
  "27": "Communications",
  "28": "Electronic Safety and Security",
  "31": "Earthwork",
  "32": "Exterior Improvements",
  "33": "Utilities",
  "34": "Transportation",
  "35": "Waterway and Marine Construction",
  "40": "Process Interconnections",
  "41": "Material Processing and Handling Equipment",
  "42": "Process Heating, Cooling, and Drying Equipment",
  "43": "Process Gas and Liquid Handling",
  "44": "Pollution and Waste Control Equipment",
  "45": "Industry-Specific Manufacturing Equipment",
  "46": "Water and Wastewater Equipment",
  "48": "Electrical Power Generation",
};

export interface CsiResult {
  /** Normalized "DD DD DD" when parseable, else the trimmed original. */
  code: string;
  division: string | null;
  valid: boolean;
}

/**
 * Normalize "033000", "03-30-00", "03 30 00", or a bare division "03" to the
 * spaced form and look up the division.
 */
export function normalizeCsi(raw: string): CsiResult {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length !== 2 && digits.length !== 6) {
    return { code: trimmed, division: null, valid: false };
  }
  const division = CSI_DIVISIONS[digits.slice(0, 2)] ?? null;
  const code =
    digits.length === 6
      ? `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)}`
      : digits;
  return { code, division, valid: division !== null };
}
