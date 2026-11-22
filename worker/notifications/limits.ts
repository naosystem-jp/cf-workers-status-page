/**
 * Delivery limits shared with wrangler.jsonc. Kept free of imports so that the Node.js build
 * test can read it and check it against the queue consumer's `max_retries`.
 */

/**
 * The notification queue's `max_retries` in wrangler.jsonc. With retries 30 s, 1, 2, 4, 8, 16
 * minutes and then every 30 minutes apart, the last attempt comes about 8 hours after the
 * first, so a delivery survives an outage of the receiving service of several hours.
 */
export const MAX_RETRIES = 20;

/** Attempts of a message: the first and its retries. The last one records a failure itself. */
export const MAX_DELIVERY_ATTEMPTS = MAX_RETRIES + 1;

/** Retries wait 30 s, then twice as long each time, at most 30 minutes (or what the service asked for, at most that). */
export const RETRY_BASE_S = 30;
export const MAX_RETRY_DELAY_S = 30 * 60;
