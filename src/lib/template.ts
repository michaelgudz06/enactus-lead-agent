// Placeholder substitution for outreach templates, kept out of the settings
// page so the email agent fills exactly the same {{tokens}} the preview showed.
// A preview that can drift from what actually sends is worse than no preview.
//
// Known limit: these row shapes belong in types.ts; fold them in there.

export interface Sender {
  id: string;
  name: string;
  email: string;
  title: string | null;
  signature: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string | null;
  body: string | null;
  sender_id: string | null;
  is_default: boolean;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export const PLACEHOLDERS = [
  "company",
  "contact_name",
  "why_fit",
  "industry",
  "location",
  "sender_name",
] as const;

// An unrecognised placeholder is left written as-is instead of blanked. "Hi
// {{first_name}}" is visibly unfinished and gets fixed before it sends; "Hi ,"
// reads as a finished draft and goes out. For the same reason callers omit a
// key entirely rather than passing "" for data they do not actually have.
export function fillTemplate(text: string, vars: Record<string, string>): string {
  const byLowerKey = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => byLowerKey.get(key.toLowerCase()) ?? whole);
}
