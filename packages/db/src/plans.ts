export type PlanTier = 'free' | 'pro' | 'business';

export interface PlanDefinition {
  tier: PlanTier;
  displayName: string;
  priceMonthlyUsd: number;
  maxContacts: number;
  maxCampaigns: number;
  monthlyOutboundMessages: number;
  dailyAiReplies: number;
  maxKnowledgeDocs: number;
  maxTeamMembers: number;
  maxWhatsappAccounts: number;
  description: string;
}

export const PLAN_CATALOG: Record<PlanTier, PlanDefinition> = {
  free: {
    tier: 'free',
    displayName: 'Free',
    priceMonthlyUsd: 0,
    maxContacts: 500,
    maxCampaigns: 5,
    monthlyOutboundMessages: 1000,
    dailyAiReplies: 50,
    maxKnowledgeDocs: 20,
    maxTeamMembers: 2,
    maxWhatsappAccounts: 1,
    description: 'Free-tier starter plan suited for Cloudflare $0 infrastructure & Meta test sandbox.'
  },
  pro: {
    tier: 'pro',
    displayName: 'Pro',
    priceMonthlyUsd: 29,
    maxContacts: 10_000,
    maxCampaigns: 50,
    monthlyOutboundMessages: 25_000,
    dailyAiReplies: 500,
    maxKnowledgeDocs: 200,
    maxTeamMembers: 10,
    maxWhatsappAccounts: 5,
    description: 'Growing business CRM, scheduled campaigns, and expanded AI customer support.'
  },
  business: {
    tier: 'business',
    displayName: 'Business',
    priceMonthlyUsd: 99,
    maxContacts: 100_000,
    maxCampaigns: 500,
    monthlyOutboundMessages: 250_000,
    dailyAiReplies: 2000,
    maxKnowledgeDocs: 1000,
    maxTeamMembers: 50,
    maxWhatsappAccounts: 25,
    description: 'Multi-team WhatsApp CRM & high-volume Meta Cloud API operations.'
  }
};

export function getPlanDefinition(tier: PlanTier | string | null | undefined): PlanDefinition {
  if (tier === 'pro' || tier === 'business' || tier === 'free') {
    return PLAN_CATALOG[tier];
  }
  return PLAN_CATALOG.free;
}
