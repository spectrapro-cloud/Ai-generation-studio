export const CREDIT_PACKAGES = {
  starter: { credits: 100, amountCents: 499, currency: "usd", name: "Starter · 100 credits" },
  creator: { credits: 550, amountCents: 1999, currency: "usd", name: "Creator · 550 credits" },
  studio: { credits: 1600, amountCents: 4999, currency: "usd", name: "Studio · 1,600 credits" }
} as const;

export type CreditPackageId = keyof typeof CREDIT_PACKAGES;
export function isCreditPackageId(value: string): value is CreditPackageId {
  return Object.prototype.hasOwnProperty.call(CREDIT_PACKAGES, value);
}
