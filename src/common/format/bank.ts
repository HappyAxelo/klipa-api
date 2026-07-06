// Bank details are stored as one display string composed at sign-up / in
// Settings: "Bank name | Account number | Beneficiary | SWIFT: CODE" (empty
// fields dropped). This splits it back into labelled lines for the invoice,
// email and public page. Positional for the first parts (matching the compose
// order); the SWIFT part is detected by its prefix wherever it sits.
export function parseBankLine(
  raw?: string | null,
): { label: string; value: string }[] {
  if (!raw) return [];
  const parts = raw.split('|').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return [];

  // Legacy single-value entries (no separators): show as one "Bank" line.
  if (parts.length === 1 && !/^swift[:\s]/i.test(parts[0])) {
    return [{ label: 'Bank', value: parts[0] }];
  }

  const out: { label: string; value: string }[] = [];
  const positional = ['Bank name', 'Account number', 'Beneficiary'];
  let posIdx = 0;
  for (const part of parts) {
    const swift = part.match(/^swift[:\s]+(.*)$/i);
    if (swift) {
      out.push({ label: 'SWIFT / BIC', value: swift[1].trim() });
    } else {
      out.push({ label: positional[posIdx] ?? 'Detail', value: part });
      posIdx += 1;
    }
  }
  return out;
}
