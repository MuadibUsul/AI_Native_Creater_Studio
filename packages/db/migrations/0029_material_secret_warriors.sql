ALTER TABLE "billing_events" ADD COLUMN "pack_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_billing_event_uq" ON "credit_ledger" USING btree ("reference_type","reference_id") WHERE "reference_type" = 'billing_event';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_refund_of_uq" ON "credit_ledger" USING btree ("reference_type","reference_id") WHERE "reference_type" = 'refund_of';
