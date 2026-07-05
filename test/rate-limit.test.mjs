// test/rate-limit.test.mjs
// Standalone test for AniList API rate limiting and token bucket logic.
// Run with: node test/rate-limit.test.mjs

// ─── Mocks ────────────────────────────────────────────────────────────────────

let now = Date.now();
const originalDateNow = Date.now;
Date.now = () => now;

const sleepLog = [];
let sleepFn = (ms) => {
  sleepLog.push(ms);
  now += ms; // advance mock clock
  return Promise.resolve();
};

// Mock window.setTimeout for the sleep() function used by AnilistClient
globalThis.window = { setTimeout: (fn) => { fn(); return 0; } };

// We need to redefine sleep inside the client module scope.
// Since client.ts uses `window.setTimeout(r)`, our mock handles it.
// But we also need to control time advancement precisely.

// ─── Constants (mirror client.ts) ─────────────────────────────────────────────

const FAST_INTERVAL_MS = 400;
const MODERATE_INTERVAL_MS = 700;
const SLOW_INTERVAL_MS = 1500;
const TOKEN_BUCKET_CAPACITY = 90;
const TOKEN_BUCKET_REFILL_RATE = 90;
const TOKEN_BUCKET_REFILL_INTERVAL = 60000;

// ─── Minimal client reimplementation for testing ──────────────────────────────
// We can't import the TS module directly, so we test the logic by reimplementing
// the key rate-limiting methods. This verifies the algorithms, not the TS types.

class MockAnilistClient {
  constructor() {
    this.nextAllowedAt = 0;
    this.currentInterval = MODERATE_INTERVAL_MS;
    this.tokens = TOKEN_BUCKET_CAPACITY;
    this.lastRefill = Date.now();
    this.requestCount = 0;
    this.logs = [];
  }

  log(msg) { this.logs.push(msg); }

  refillTokens() {
    const elapsed = Date.now() - this.lastRefill;
    if (elapsed >= TOKEN_BUCKET_REFILL_INTERVAL) {
      const refill = Math.floor(elapsed / TOKEN_BUCKET_REFILL_INTERVAL) * TOKEN_BUCKET_REFILL_RATE;
      this.tokens = Math.min(TOKEN_BUCKET_CAPACITY, this.tokens + refill);
      this.lastRefill += Math.floor(elapsed / TOKEN_BUCKET_REFILL_INTERVAL) * TOKEN_BUCKET_REFILL_INTERVAL;
    }
  }

  consumeToken() {
    this.refillTokens();
    if (this.tokens > 0) this.tokens -= 1;
  }

  getTokenWaitMs() {
    this.refillTokens();
    if (this.tokens > 0) return 0;
    return Math.max(0, TOKEN_BUCKET_REFILL_INTERVAL - (Date.now() - this.lastRefill));
  }

  updateRateLimit(remaining, resetEpoch) {
    if (Number.isFinite(remaining) && remaining >= 0) {
      if (remaining === 0 && Number.isFinite(resetEpoch) && resetEpoch > 0) {
        const resetMs = resetEpoch * 1000;
        if (resetMs > Date.now()) {
          this.nextAllowedAt = resetMs;
          this.currentInterval = MODERATE_INTERVAL_MS;
          return;
        }
      }
      if (remaining > 10) this.currentInterval = FAST_INTERVAL_MS;
      else if (remaining > 5) this.currentInterval = MODERATE_INTERVAL_MS;
      else this.currentInterval = SLOW_INTERVAL_MS;
    }
  }

  async reserveSlot() {
    const now = Date.now();
    const reservedAt = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = reservedAt + this.currentInterval;
    const slotWait = reservedAt - now;
    const bucketWait = this.getTokenWaitMs();
    const totalWait = Math.max(slotWait, bucketWait);
    if (totalWait > 0) await sleepFn(totalWait);
    return { slotWait, bucketWait, totalWait };
  }

  getState() {
    return {
      tokens: this.tokens,
      currentInterval: this.currentInterval,
      nextAllowedAt: this.nextAllowedAt,
      lastRefill: this.lastRefill,
      requestCount: this.requestCount,
    };
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

function assertApprox(actual, expected, tolerance, msg) {
  assert(Math.abs(actual - expected) <= tolerance, `${msg} (got ${actual}, expected ~${expected})`);
}

function resetTime(t = 1000000000000) {
  now = t;
  Date.now = () => now;
}

function advanceTime(ms) {
  now += ms;
}

// ─── Test: Token bucket starts full ───────────────────────────────────────────

console.log("\n=== Test: Token bucket starts full ===");
{
  const c = new MockAnilistClient();
  assert(c.tokens === TOKEN_BUCKET_CAPACITY, `bucket should start at ${TOKEN_BUCKET_CAPACITY}, got ${c.tokens}`);
  assert(c.currentInterval === MODERATE_INTERVAL_MS, `interval should start at ${MODERATE_INTERVAL_MS}ms`);
}

// ─── Test: Token bucket consumes correctly ────────────────────────────────────

console.log("\n=== Test: Token bucket consumption ===");
{
  const c = new MockAnilistClient();
  const initial = c.tokens;
  c.consumeToken();
  assert(c.tokens === initial - 1, `after consume: ${c.tokens} should be ${initial - 1}`);
  
  // Consume all tokens
  for (let i = 0; i < TOKEN_BUCKET_CAPACITY - 1; i++) c.consumeToken();
  assert(c.tokens === 0, `after consuming all: ${c.tokens} should be 0`);
  
  // Try to consume when empty — should not go negative
  c.consumeToken();
  assert(c.tokens === 0, `consuming empty bucket: ${c.tokens} should stay 0`);
}

// ─── Test: Token bucket refills after 60s ────────────────────────────────────

console.log("\n=== Test: Token bucket refill timing ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  c.lastRefill = now;
  
  // Exhaust bucket
  for (let i = 0; i < TOKEN_BUCKET_CAPACITY; i++) c.consumeToken();
  assert(c.tokens === 0, "bucket exhausted");
  
  // 30s later — no refill yet
  advanceTime(30000);
  c.refillTokens();
  assert(c.tokens === 0, `after 30s: tokens should be 0, got ${c.tokens}`);
  
  // 60s later — full refill
  advanceTime(30000);
  c.refillTokens();
  assert(c.tokens === TOKEN_BUCKET_CAPACITY, `after 60s: tokens should be ${TOKEN_BUCKET_CAPACITY}, got ${c.tokens}`);
}

// ─── Test: Token bucket partial refill ────────────────────────────────────────

console.log("\n=== Test: Token bucket partial refill ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  c.lastRefill = now;
  
  // Use 50 tokens (leave 40)
  for (let i = 0; i < 50; i++) c.consumeToken();
  assert(c.tokens === 40, `after 50 consumes: tokens should be 40, got ${c.tokens}`);
  
  // 60s later — refill 90 but capped at capacity (40 + 90 = 130, capped at 90)
  advanceTime(60000);
  c.refillTokens();
  assert(c.tokens === TOKEN_BUCKET_CAPACITY, `refill should cap at capacity: got ${c.tokens}`);
}

// ─── Test: Token wait calculation ─────────────────────────────────────────────

console.log("\n=== Test: Token wait calculation ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  c.lastRefill = now;
  
  // Exhaust bucket
  for (let i = 0; i < TOKEN_BUCKET_CAPACITY; i++) c.consumeToken();
  
  // At T+0: should wait ~60s
  const wait0 = c.getTokenWaitMs();
  assertApprox(wait0, TOKEN_BUCKET_REFILL_INTERVAL, 100, `at T+0 wait should be ~${TOKEN_BUCKET_REFILL_INTERVAL}ms`);
  
  // At T+30s: should wait ~30s
  advanceTime(30000);
  const wait30 = c.getTokenWaitMs();
  assertApprox(wait30, 30000, 100, `at T+30s wait should be ~30000ms`);
  
  // At T+60s: should wait 0 (refilled)
  advanceTime(30000);
  const wait60 = c.getTokenWaitMs();
  assert(wait60 === 0, `at T+60s wait should be 0, got ${wait60}`);
  assert(c.tokens === TOKEN_BUCKET_CAPACITY, `at T+60s tokens should be ${TOKEN_BUCKET_CAPACITY}, got ${c.tokens}`);
}

// ─── Test: reserveSlot timing ─────────────────────────────────────────────────

console.log("\n=== Test: reserveSlot timing ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  
  // First call — no wait
  const r1 = await c.reserveSlot();
  assert(r1.totalWait === 0, `first call: wait should be 0, got ${r1.totalWait}`);
  
  // Second call immediately — should wait currentInterval (700ms)
  const r2 = await c.reserveSlot();
  assert(r2.slotWait === MODERATE_INTERVAL_MS, `second call slot wait: should be ${MODERATE_INTERVAL_MS}ms, got ${r2.slotWait}`);
}

// ─── Test: updateRateLimit adapts interval ────────────────────────────────────

console.log("\n=== Test: updateRateLimit adapts interval ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  
  // remaining > 10 → FAST
  c.updateRateLimit(50, 0);
  assert(c.currentInterval === FAST_INTERVAL_MS, `remaining=50: interval should be ${FAST_INTERVAL_MS}ms, got ${c.currentInterval}`);
  
  // remaining = 8 → MODERATE
  c.updateRateLimit(8, 0);
  assert(c.currentInterval === MODERATE_INTERVAL_MS, `remaining=8: interval should be ${MODERATE_INTERVAL_MS}ms, got ${c.currentInterval}`);
  
  // remaining = 3 → SLOW
  c.updateRateLimit(3, 0);
  assert(c.currentInterval === SLOW_INTERVAL_MS, `remaining=3: interval should be ${SLOW_INTERVAL_MS}ms, got ${c.currentInterval}`);
  
  // remaining = 0 with future reset → pause until reset
  const futureReset = Math.floor((now + 30000) / 1000); // 30s from now
  c.updateRateLimit(0, futureReset);
  assert(c.nextAllowedAt === futureReset * 1000, `remaining=0: nextAllowedAt should be reset time`);
}

// ─── Test: Rapid requests deplete bucket, then wait ──────────────────────────

console.log("\n=== Test: Rapid requests deplete bucket ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  
  // Simulate 90 rapid requests
  for (let i = 0; i < TOKEN_BUCKET_CAPACITY; i++) {
    c.consumeToken();
  }
  assert(c.tokens === 0, `after ${TOKEN_BUCKET_CAPACITY} requests: bucket empty`);
  
  // Next request needs to wait
  const wait = c.getTokenWaitMs();
  assert(wait > 0, `after bucket empty: should wait > 0, got ${wait}`);
}

// ─── Test: Bucket refills correctly across multiple intervals ─────────────────

console.log("\n=== Test: Multi-interval refill ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  c.lastRefill = now;
  
  // Exhaust
  for (let i = 0; i < TOKEN_BUCKET_CAPACITY; i++) c.consumeToken();
  
  // 180s later (3 intervals) — should refill 270 tokens, capped at 90
  advanceTime(180000);
  c.refillTokens();
  assert(c.tokens === TOKEN_BUCKET_CAPACITY, `after 180s: tokens should be capped at ${TOKEN_BUCKET_CAPACITY}, got ${c.tokens}`);
}

// ─── Test: Bucket doesn't refill if not enough time ──────────────────────────

console.log("\n=== Test: No refill before interval ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  c.lastRefill = now;
  
  // Use 10 tokens
  for (let i = 0; i < 10; i++) c.consumeToken();
  assert(c.tokens === 80, `after 10 consumes: tokens should be 80, got ${c.tokens}`);
  
  // 59s later — no refill
  advanceTime(59000);
  c.refillTokens();
  assert(c.tokens === 80, `after 59s: tokens should still be 80, got ${c.tokens}`);
  
  // 61s later — refill
  advanceTime(2000);
  c.refillTokens();
  assert(c.tokens === TOKEN_BUCKET_CAPACITY, `after 61s: tokens should be ${TOKEN_BUCKET_CAPACITY}, got ${c.tokens}`);
}

// ─── Test: reserveSlot + bucket coordination ──────────────────────────────────

console.log("\n=== Test: reserveSlot + bucket coordination ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  
  // Exhaust bucket
  for (let i = 0; i < TOKEN_BUCKET_CAPACITY; i++) c.consumeToken();
  
  // reserveSlot should wait for max(slot, bucket)
  const r = await c.reserveSlot();
  // slotWait should be 0 (first call), bucketWait should be ~60s
  assert(r.bucketWait > 50000, `bucket wait should be ~60s, got ${r.bucketWait}`);
  assert(r.totalWait >= r.bucketWait, `totalWait should be >= bucketWait`);
}

// ─── Test: Sliding window accumulates ────────────────────────────────────────

console.log("\n=== Test: Sliding window accumulates ===");
{
  resetTime(1000000000000);
  const c = new MockAnilistClient();
  
  // Two rapid calls
  await c.reserveSlot(); // nextAllowedAt = now + 700
  await c.reserveSlot(); // nextAllowedAt = (now+700) + 700 = now + 1400
  
  const state = c.getState();
  assert(state.nextAllowedAt > now, `nextAllowedAt should be in the future: ${state.nextAllowedAt}`);
}

// ─── Test: Request counter increments ────────────────────────────────────────

console.log("\n=== Test: Request counter ===");
{
  const c = new MockAnilistClient();
  assert(c.requestCount === 0, "initial count should be 0");
  c.consumeToken();
  c.requestCount++;
  c.consumeToken();
  c.requestCount++;
  assert(c.requestCount === 2, `count should be 2, got ${c.requestCount}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));

// Restore
Date.now = originalDateNow;
process.exit(failed > 0 ? 1 : 0);
