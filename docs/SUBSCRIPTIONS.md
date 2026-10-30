# Razorpay subscriptions

Subscriptions are isolated under `/api/subscriptions`. The browser callback never grants access; only a verified Razorpay webhook or an admin/coupon entitlement changes `users.plan`.

## Deployment order

1. Configure `RAZORPAY_MODE`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.
2. Run `npm run db:migrate`.
3. Run `npm run subscriptions:sync-plans` once for the configured Razorpay mode.
4. Configure Razorpay to send subscription and payment events to `https://api.stockharvesting.com/api/subscriptions/webhook`.
5. Restart the API. The API process runs entitlement reconciliation every 15 minutes by default.

Subscribe to subscription lifecycle and payment events, including activation, charging, pending, halted, cancellation, completion, payment capture, and payment failure. The receiver verifies the exact raw request body using `X-Razorpay-Signature`, stores an idempotent event record, and permits failed deliveries to be replayed.

Run the plan sync separately in test and live environments. A checkout is rejected when the stored Razorpay plan mode does not match `RAZORPAY_MODE`.

Existing Pro users are migrated to non-expiring `grandfathered` grants. Future complimentary access should use admin grants or coupons instead of direct `users.plan` updates.
