import { z } from "zod";

// Permissive on purpose: PayPal adds fields freely, and the raw body is always
// available through the client's onExchange hook. We validate only what we read.

export const MoneySchema = z.object({ currency_code: z.string(), value: z.string() }).passthrough();

export const LinkSchema = z
  .object({ href: z.string(), rel: z.string(), method: z.string().optional() })
  .passthrough();

export const DISPUTE_STATUSES = [
  "OPEN",
  "WAITING_FOR_BUYER_RESPONSE",
  "WAITING_FOR_SELLER_RESPONSE",
  "UNDER_REVIEW",
  "RESOLVED",
  "OTHER",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_STAGES = ["INQUIRY", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

// PayPal defines OTHER as its own catch-all, so an unknown status maps there.
const StatusSchema = z.enum(DISPUTE_STATUSES).catch("OTHER");

export const DisputeSchema = z
  .object({
    dispute_id: z.string(),
    reason: z.string(),
    status: StatusSchema,
    dispute_life_cycle_stage: z.enum(DISPUTE_STAGES),
    dispute_amount: MoneySchema,
    dispute_outcome: z.object({ outcome_code: z.string() }).passthrough().optional(),
    disputed_transactions: z
      .array(
        z
          .object({
            seller_transaction_id: z.string().optional(),
            buyer_transaction_id: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    seller_response_due_date: z.string().optional(),
    messages: z
      .array(
        z
          .object({ posted_by: z.string(), time_posted: z.string(), content: z.string() })
          .passthrough(),
      )
      .default([]),
    evidences: z.array(z.object({}).passthrough()).default([]),
    links: z.array(LinkSchema).default([]),
  })
  .passthrough();
export type Dispute = z.infer<typeof DisputeSchema>;

export const DisputeListSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            dispute_id: z.string(),
            status: z.string().optional(),
            reason: z.string().optional(),
            disputed_transactions: DisputeSchema.shape.disputed_transactions.optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type DisputeList = z.infer<typeof DisputeListSchema>;

const CaptureSchemaInOrder = z
  .object({ id: z.string(), status: z.string(), amount: MoneySchema })
  .passthrough();

export const OrderSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    purchase_units: z
      .array(
        z
          .object({
            amount: MoneySchema.optional(),
            items: z
              .array(
                z
                  .object({ name: z.string(), quantity: z.string().optional() })
                  .passthrough(),
              )
              .optional(),
            shipping: z
              .object({
                name: z.object({ full_name: z.string().optional() }).passthrough().optional(),
                address: z.object({}).passthrough().optional(),
                trackers: z.array(z.object({ id: z.string() }).passthrough()).optional(),
              })
              .passthrough()
              .optional(),
            payments: z
              .object({
                captures: z.array(CaptureSchemaInOrder).optional(),
                refunds: z.array(z.object({ id: z.string() }).passthrough()).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    links: z.array(LinkSchema).default([]),
  })
  .passthrough();
export type Order = z.infer<typeof OrderSchema>;

export const CaptureSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    amount: MoneySchema,
    supplementary_data: z
      .object({
        related_ids: z.object({ order_id: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Capture = z.infer<typeof CaptureSchema>;

export const TrackerSchema = z
  .object({
    transaction_id: z.string().optional(),
    tracking_number: z.string(),
    status: z.string(),
    carrier: z.string().optional(),
    last_updated_time: z.string().optional(),
  })
  .passthrough();
export type Tracker = z.infer<typeof TrackerSchema>;

export const TokenSchema = z
  .object({ access_token: z.string(), expires_in: z.number() })
  .passthrough();

export const ActionBodySchema = z.object({ links: z.array(LinkSchema).default([]) }).passthrough();

export const VerifySchema = z
  .object({ verification_status: z.enum(["SUCCESS", "FAILURE"]) })
  .passthrough();

export const PayPalErrorBodySchema = z
  .object({
    name: z.string().optional(),
    message: z.string().optional(),
    debug_id: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();
