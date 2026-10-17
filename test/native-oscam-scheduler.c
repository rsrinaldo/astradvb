/* Portable metadata model. Actual protocol/worker integration is separately
 * verified with the pinned OSCam binary and an isolated fake provider. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "astra-semantic-scheduler.h"

static void expire(struct astra_semantic_core *q, uint64_t now)
{
	int i;
	while((i = astra_semantic_expired(q, now)) >= 0)
	{
		assert(q->slots[i].state != ASTRA_SENT);
		astra_semantic_release(q, (size_t)i);
		q->expired++;
	}
}

static void pacing_and_latency(void)
{
	struct astra_semantic_slot slots[128];
	struct astra_semantic_core q;
	uint64_t reply[128] = {0}, sent_at[85] = {0};
	unsigned dispatched = 0, completed = 0;
	uint16_t id = 2;
	astra_semantic_init(&q, slots, 128);
	for(unsigned i = 0; i < 85; ++i) { assert(astra_semantic_enqueue(&q, 0, 8000, i + 1, 0) == (int)i); }
	assert(astra_semantic_pick(&q, 0, 0) == -1);
	assert(astra_semantic_wait(&q, 0, 0, 3000) == 3000);
	for(uint64_t now = 0; now <= 8000; ++now)
	{
		for(unsigned i = 0; i < 128; ++i)
		{
			if(reply[i] && reply[i] <= now)
			{
				assert(slots[i].state == ASTRA_SENT);
				assert(now < slots[i].deadline_ms);
				astra_semantic_release(&q, i);
				reply[i] = 0; completed++;
			}
		}
		expire(&q, now);
		int n = astra_semantic_pick(&q, now, 1);
		if(n >= 0)
		{
			id = astra_semantic_next_id(&q, id);
			assert(id != 0);
			astra_semantic_dispatch(&q, (size_t)n, now, id);
			assert(dispatched < 85);
			sent_at[dispatched++] = now;
			reply[n] = now + 2000;
			assert(astra_semantic_pick(&q, now, 1) == -1);
		}
		assert(q.sent <= 32);
	}
	assert(dispatched == 85 && completed == 85);
	assert(q.peak_sent == 32 && q.expired == 0 && q.sent == 0);
	assert(sent_at[84] == 5000); /* 32 in flight, NOT 40 from a raw20/s queue */
	for(unsigned i = 1; i < 85; ++i) { assert(sent_at[i] - sent_at[i - 1] >= 50); }
	for(unsigned i = 0; i < 85; ++i)
	{
		unsigned count = 0;
		for(unsigned j = i; j < 85 && sent_at[j] < sent_at[i] + 1000; ++j) { count++; }
		assert(count <= 20);
	}
}

static void all_dropped_backpressure(void)
{
	struct astra_semantic_slot slots[128];
	struct astra_semantic_core q;
	uint16_t id = 2;
	astra_semantic_init(&q, slots, 128);
	for(unsigned i = 0; i < 128; ++i) { assert(astra_semantic_enqueue(&q, 0, 8000, i + 1, 0) >= 0); }
	assert(astra_semantic_enqueue(&q, 0, 8000, 129, 0) == -1);
	for(uint64_t now = 0; now < 100000; now += 50)
	{
		expire(&q, now);
		int n = astra_semantic_pick(&q, now, 1);
		if(n >= 0)
		{
			id = astra_semantic_next_id(&q, id);
			astra_semantic_dispatch(&q, (size_t)n, now, id);
		}
		assert(q.sent <= 32);
	}
	assert(q.dispatched == 32 && q.sent == 32 && q.expired == 96);
	assert(astra_semantic_expired(&q, UINT64_C(1000000000)) == -1);
	assert(astra_semantic_wait(&q, 100000, 1, 3000) == 3000);
	for(unsigned i = 0; i < 96; ++i) { assert(astra_semantic_enqueue(&q, 100000, 108000, i + 200, 0) >= 0); }
	assert(astra_semantic_enqueue(&q, 100000, 108000, 400, 0) == -1);
	assert(astra_semantic_pick(&q, 100000, 1) == -1);
	expire(&q, 108000);
	assert(q.sent == 32 && q.dispatched == 32 && q.expired == 192);
	for(unsigned i = 0; i < 32; ++i)
	{
		assert(slots[i].state == ASTRA_SENT && slots[i].id == i + 3);
		for(unsigned j = i + 1; j < 32; ++j) { assert(slots[i].id != slots[j].id); }
	}
	/* A late reply retires exactly one retained ID. New work can then send. */
	astra_semantic_release(&q, 0);
	int n = astra_semantic_enqueue(&q, 109000, 117000, 999, 0);
	assert(n == 0 && astra_semantic_pick(&q, 109000, 1) == n);
	id = astra_semantic_next_id(&q, id);
	astra_semantic_dispatch(&q, (size_t)n, 109000, id);
	assert(q.sent == 32 && q.dispatched == 33);
}

static void fairness_aliases_deadlines(void)
{
	struct astra_semantic_slot slots[8];
	struct astra_semantic_core q;
	astra_semantic_init(&q, slots, 8);
	assert(astra_semantic_enqueue(&q, 0, 8000, 10, 0) == 0);
	assert(astra_semantic_enqueue(&q, 0, 8000, 10, 0) == 1);
	assert(astra_semantic_enqueue(&q, 0, 8000, 20, 0) == 2);
	assert(astra_semantic_enqueue(&q, 0, 8000, 30, 0) == 3);
	assert(astra_semantic_enqueue(&q, 0, 8000, 10, 1) == 4);
	assert(q.coalesced == 1 && astra_semantic_pick(&q, 0, 1) == 0);
	astra_semantic_dispatch(&q, 0, 0, 3);
	assert(astra_semantic_pick(&q, 50, 1) == 2);
	astra_semantic_dispatch(&q, 2, 50, 4);
	assert(astra_semantic_pick(&q, 100, 1) == 1);
	astra_semantic_dispatch(&q, 1, 100, 5);
	assert(astra_semantic_pick(&q, 150, 1) == 3);
	/* ALIAS never dispatches, occupies one bounded caller slot, not in-flight. */
	astra_semantic_dispatch(&q, 3, 150, 6);
	assert(q.sent == 4 && astra_semantic_pick(&q, 200, 1) == -1);
	expire(&q, 8000);
	assert(slots[4].state == ASTRA_EMPTY && q.sent == 4 && q.expired == 1);
	for(unsigned i = 0; i < 4; ++i) { astra_semantic_release(&q, i); }
	assert(q.sent == 0);
	/* Urgent head may override fairness, but cannot overtake its service head. */
	astra_semantic_init(&q, slots, 8);
	astra_semantic_enqueue(&q, 0, 8000, 10, 0);
	astra_semantic_enqueue(&q, 0, 7000, 20, 0);
	astra_semantic_enqueue(&q, 0, 500, 20, 0);
	assert(astra_semantic_pick(&q, 0, 1) == 0);
	astra_semantic_dispatch(&q, 0, 0, 3);
	assert(astra_semantic_pick(&q, 50, 1) == 1);
	expire(&q, 500);
	assert(slots[2].state == ASTRA_EMPTY && q.sent == 1);
}

static void no_catchup_wrap_and_transport_close(void)
{
	struct astra_semantic_slot slots[8];
	struct astra_semantic_core q;
	astra_semantic_init(&q, slots, 8);
	for(unsigned i = 0; i < 4; ++i) { astra_semantic_enqueue(&q, 0, 2000000, i + 1, 0); }
	astra_semantic_dispatch(&q, 0, 0, 65535);
	astra_semantic_dispatch(&q, 1, 50, 1);
	astra_semantic_dispatch(&q, 2, 100, 2);
	assert(astra_semantic_next_id(&q, 65534) == 3);
	assert(astra_semantic_next_id(&q, 65535) == 3);
	/* Sender allocation is independent of unrelated protocol-counter inputs. */
	astra_semantic_release(&q, 0);
	assert(astra_semantic_next_id(&q, 65534) == 3);
	assert(astra_semantic_next_id(&q, 60000) == 3);
	assert(astra_semantic_pick(&q, 149, 1) == -1);
	assert(astra_semantic_wait(&q, 149, 1, 3000) == 1);
	assert(astra_semantic_pick(&q, 1000000, 1) == 3);
	astra_semantic_dispatch(&q, 3, 1000000, 3);
	assert(q.next_send_ms == 1000050 && q.sent == 3);
	/* Closing transport retires every outstanding ID without replay. */
	for(unsigned i = 0; i < 8; ++i) { astra_semantic_release(&q, i); }
	assert(q.sent == 0 && q.dispatched == 4);
	astra_semantic_enqueue(&q, 1000001, 1008001, 10, 0);
	assert(astra_semantic_pick(&q, 1000001, 1) == -1);
	assert(astra_semantic_pick(&q, 1000050, 0) == -1);
	assert(astra_semantic_pick(&q, 1000050, 1) == 0);
	assert(astra_semantic_enqueue(&q, 1000001, 1000001, 20, 0) == -1);
}

static void bounded_silence_reset_and_fresh_recovery(void)
{
	struct astra_semantic_slot slots[128];
	struct astra_semantic_core q;
	uint16_t id = 2;
	astra_semantic_init(&q, slots, 128);
	assert(q.generation == 1);
	for(unsigned i = 0; i < 85; ++i) { assert(astra_semantic_enqueue(&q, 0, 8000, i + 1, 0) >= 0); }
	for(uint64_t now = 0; now < 8000; now += 50)
	{
		int n = astra_semantic_pick(&q, now, 1);
		if(n >= 0)
		{
			id = astra_semantic_next_id(&q, id);
			astra_semantic_dispatch(&q, (size_t)n, now, id);
		}
		assert(q.sent <= 32 && q.resets == 0);
		assert(astra_semantic_recovery_due(&q, 8000) == 8000);
	}
	assert(q.dispatched == 32 && q.matched == 0);
	assert(astra_semantic_recovery_wait(&q, 7999, 8000, 3000) == 1);
	assert(astra_semantic_recovery_wait(&q, 8000, 8000, 3000) == 0);
	expire(&q, 8000);
	assert(q.expired == 53 && q.sent == 32);
	/* The worker increments this ONLY on the no-progress close decision,
	 * unlocks, then the existing transport-close path retires the slots. */
	q.resets++;
	astra_semantic_transport_closed(&q);
	assert(q.generation == 2 && q.closes == 1 && q.resets == 1);
	assert(q.sent == 0 && q.abandoned == 32 && q.reply_progress == 0);
	assert(astra_semantic_recovery_due(&q, 8000) == UINT64_MAX);
	assert(astra_semantic_recovery_wait(&q, 8001, 8000, 3000) == 3000);
	for(unsigned i = 0; i < 128; ++i) { assert(slots[i].state == ASTRA_EMPTY && slots[i].id == 0); }
	assert(!astra_semantic_note_reply(&q, 0, 3, 8001)); /* old generation */
	int n = astra_semantic_enqueue(&q, 8001, 16001, 999, 0);
	assert(n == 0 && astra_semantic_pick(&q, 8001, 0) == -1);
	assert(astra_semantic_pick(&q, 8001, 1) == 0);
	id = astra_semantic_next_id(&q, 0);
	assert(id == 35); /* no immediate old-ID reuse after close */
	astra_semantic_dispatch(&q, 0, 8001, id);
	assert(!astra_semantic_note_reply(&q, 0, 3, 8002));
	assert(astra_semantic_note_reply(&q, 0, id, 8101));
	astra_semantic_release(&q, 0);
	assert(q.matched == 1 && q.sent == 0 && q.dispatched == 33 && q.resets == 1);
}

static void continuing_replies_preserve_healthy_transport(void)
{
	struct astra_semantic_slot slots[8];
	struct astra_semantic_core q;
	astra_semantic_init(&q, slots, 8);
	int missing = astra_semantic_enqueue(&q, 0, 8000, 1, 0);
	astra_semantic_dispatch(&q, (size_t)missing, 0, 3);
	uint16_t id = 3;
	for(uint64_t now = 1000; now <= 12000; now += 1000)
	{
		int n = astra_semantic_enqueue(&q, now, now + 8000, now + 1, 0);
		assert(n >= 0);
		id = astra_semantic_next_id(&q, id);
		astra_semantic_dispatch(&q, (size_t)n, now, id);
		assert(astra_semantic_note_reply(&q, (size_t)n, id, now + 100));
		/* Positive and complete negative replies take this identical progress
		 * path; the reply result is deliberately not an argument to this API. */
		astra_semantic_release(&q, (size_t)n);
		assert(astra_semantic_recovery_due(&q, 8000) == now + 8100);
		assert(astra_semantic_recovery_wait(&q, now + 101, 8000, 3000) == 3000);
		assert(q.sent == 1 && q.resets == 0 && q.generation == 1);
	}
	assert(slots[missing].deadline_ms == 8000); /* never extend original deadline */
	assert(q.matched == 12 && q.last_reply_ms == 12100);
	assert(!astra_semantic_note_reply(&q, 7, 3, 15000));
	assert(!astra_semantic_note_reply(&q, 1000, 3, 15000));
	assert(!astra_semantic_note_reply(&q, (size_t)missing, 0, 15000));
	assert(!astra_semantic_note_reply(&q, (size_t)missing, 99, 15000));
	assert(q.last_reply_ms == 12100);
	/* A genuinely late/out-of-order reply is progress, never an old answer
	 * applied to a fresh slot. The worker independently withholds its CW. */
	assert(astra_semantic_note_reply(&q, (size_t)missing, 3, 16000));
	astra_semantic_release(&q, (size_t)missing);
	assert(q.matched == 13 && q.sent == 0 && q.resets == 0);
	assert(astra_semantic_recovery_due(&q, 8000) == UINT64_MAX);
}

static void original_deadline_and_progress_boundaries(void)
{
	struct astra_semantic_slot slots[4];
	struct astra_semantic_core q;
	astra_semantic_init(&q, slots, 4);
	/* Caller expiry is not evidence of a dead transport. Preserve its original
	 * answer deadline, but allow a full response interval after dispatch. */
	int n = astra_semantic_enqueue(&q, 0, 8000, 1, 0);
	astra_semantic_dispatch(&q, (size_t)n, 7000, 3);
	assert(slots[n].deadline_ms == 8000);
	assert(astra_semantic_recovery_due(&q, 8000) == 15000);
	assert(astra_semantic_recovery_wait(&q, 7990, 8000, 3000) == 3000);
	int alias = astra_semantic_enqueue(&q, 7000, 15000, 1, 1);
	assert(!astra_semantic_note_reply(&q, (size_t)alias, 3, 7900));
	assert(q.reply_progress == 0 && q.matched == 0);
	/* Send failure/timeout/cache paths do not invoke note_reply. */
	assert(astra_semantic_recovery_due(&q, 8000) == 15000);
	assert(astra_semantic_recovery_decision(&q, 8000, 8000, 0) == 0);
	assert(astra_semantic_recovery_decision(&q, 14999, 8000, 0) == 0);
	assert(astra_semantic_recovery_decision(&q, 15000, 8000, 0) == 1);
	assert(astra_semantic_note_reply(&q, (size_t)n, 3, 7900));
	assert(astra_semantic_recovery_due(&q, 8000) == 15900);
	assert(astra_semantic_recovery_wait(&q, 15899, 8000, 3000) == 1);
	assert(astra_semantic_recovery_wait(&q, 15900, 8000, 3000) == 0);
	q.resets++;
	astra_semantic_transport_closed(&q);
	assert(q.reply_progress == 0 && q.last_reply_ms == 0 && q.sent == 0);
	assert(!astra_semantic_note_reply(&q, (size_t)n, 3, 15901));
	assert(q.matched == 1 && q.resets == 1 && q.abandoned == 1);
}

static void partial_drop_pressure_retirement(void)
{
	struct astra_semantic_slot slots[128];
	struct astra_semantic_core q;
	astra_semantic_init(&q, slots, 128);
	for(unsigned i = 0; i < 32; ++i)
	{
		int n = astra_semantic_enqueue(&q, 0, 8000, i + 1, 0);
		astra_semantic_dispatch(&q, (size_t)n, i * 50, (uint16_t)(i + 3));
	}
	assert(astra_semantic_note_reply(&q, 31, 34, 1600));
	astra_semantic_release(&q, 31);
	uint16_t id = 34;
	for(uint64_t now = 2000; now <= 7000; now += 1000)
	{
		int n = astra_semantic_enqueue(&q, now, now + 8000, 100, 0);
		id = astra_semantic_next_id(&q, id);
		astra_semantic_dispatch(&q, (size_t)n, now, id);
		assert(astra_semantic_note_reply(&q, (size_t)n, id, now + 100));
		astra_semantic_release(&q, (size_t)n);
		assert(q.sent == 31);
	}
	/* Regression: expired majority plus queued demand must not close a
	 * transport that still completes matched requests. */
	int active = astra_semantic_enqueue(&q, 7900, 15900, 101, 0);
	id = astra_semantic_next_id(&q, id);
	astra_semantic_dispatch(&q, (size_t)active, 7900, id);
	assert(astra_semantic_enqueue(&q, 7900, 15900, 102, 0) >= 0);
	assert(astra_semantic_no_progress_due(&q, 8000) == 15100);
	assert(astra_semantic_recovery_due(&q, 8000) == 15100);
	assert(astra_semantic_recovery_decision(&q, 7999, 8000, 0) == 0);
	assert(astra_semantic_recovery_decision(&q, 8000, 8000, 0) == 0);
	assert(astra_semantic_recovery_decision(&q, 15100, 8000, 0) == 1);
	q.last_reset_reason = 1; q.resets++;
	astra_semantic_transport_closed(&q);
	assert(q.sent == 0 && q.abandoned == 32 && q.generation == 2);
	assert(q.last_reset_reason == 1);
	assert(astra_semantic_pick(&q, 8001, 1) == -1); /* nothing replayed */
	/* Even 16 expired IDs do not override recent real reply progress. */
	astra_semantic_init(&q, slots, 128);
	for(unsigned i = 0; i < 17; ++i)
	{
		int n = astra_semantic_enqueue(&q, 0, i < 15 ? 8000 : 9000, i + 1, 0);
		astra_semantic_dispatch(&q, (size_t)n, i * 50, (uint16_t)(i + 3));
	}
	assert(astra_semantic_note_reply(&q, 16, 19, 7990));
	astra_semantic_release(&q, 16);
	assert(astra_semantic_enqueue(&q, 7990, 20000, 200, 0) >= 0);
	assert(astra_semantic_recovery_due(&q, 8000) == 15990);
	assert(astra_semantic_recovery_decision(&q, 8000, 8000, 0) == 0);
	assert(astra_semantic_recovery_decision(&q, 9000, 8000, 0) == 0);
	assert(astra_semantic_recovery_decision(&q, 15990, 8000, 0) == 1);
}

static void absolute_orphan_age_and_ready_reply_boundary(void)
{
	struct astra_semantic_slot slots[8];
	struct astra_semantic_core q;
	astra_semantic_init(&q, slots, 8);
	int missing = astra_semantic_enqueue(&q, 0, 8000, 1, 0);
	astra_semantic_dispatch(&q, (size_t)missing, 0, 3);
	uint16_t id = 3;
	for(uint64_t now = 1000; now <= 31000; now += 1000)
	{
		int n = astra_semantic_enqueue(&q, now, now + 8000, 2, 0);
		id = astra_semantic_next_id(&q, id);
		astra_semantic_dispatch(&q, (size_t)n, now, id);
		assert(astra_semantic_note_reply(&q, (size_t)n, id, now + 100));
		astra_semantic_release(&q, (size_t)n);
		assert(astra_semantic_recovery_decision(&q, now + 101, 8000, 0) == 0);
	}
	assert(q.sent == 1 && q.matched == 31);
	assert(astra_semantic_recovery_due(&q, 8000) == 32000);
	assert(astra_semantic_recovery_wait(&q, 31999, 8000, 3000) == 1);
	assert(astra_semantic_recovery_decision(&q, 32000, 8000, 1) == 3);
	/* A valid ready reply at a soft boundary gets a bounded parsing turn. */
	astra_semantic_init(&q, slots, 8);
	missing = astra_semantic_enqueue(&q, 0, 8000, 1, 0);
	astra_semantic_dispatch(&q, (size_t)missing, 0, 3);
	assert(astra_semantic_recovery_decision(&q, 8000, 8000, 1) == 0);
	assert(q.soft_defer_until_ms == 8250);
	assert(astra_semantic_recovery_wait(&q, 8001, 8000, 3000) == 249);
	assert(astra_semantic_note_reply(&q, (size_t)missing, 3, 8002));
	assert(q.soft_defer_until_ms == 0);
	astra_semantic_release(&q, (size_t)missing);
	assert(astra_semantic_recovery_decision(&q, 8002, 8000, 1) == 0);
	/* Continuous readable junk/ID0 is not reply progress and cannot extend
	 * soft grace repeatedly, nor postpone the absolute orphan-age boundary. */
	astra_semantic_init(&q, slots, 8);
	missing = astra_semantic_enqueue(&q, 0, 8000, 1, 0);
	astra_semantic_dispatch(&q, (size_t)missing, 0, 3);
	assert(astra_semantic_recovery_decision(&q, 8000, 8000, 1) == 0);
	assert(!astra_semantic_note_reply(&q, (size_t)missing, 0, 8100));
	assert(astra_semantic_recovery_decision(&q, 8249, 8000, 1) == 0);
	assert(astra_semantic_recovery_decision(&q, 8250, 8000, 1) == 1);
	q.soft_defer_until_ms = 0;
	assert(astra_semantic_recovery_decision(&q, 31999, 8000, 1) == 0);
	assert(astra_semantic_recovery_wait(&q, 31999, 8000, 3000) == 1);
	assert(astra_semantic_recovery_decision(&q, 32000, 8000, 1) == 3);
}

int main(int argc, char **argv)
{
	if(argc == 2 && !strcmp(argv[1], "--dispatch-deadline"))
	{
		original_deadline_and_progress_boundaries();
		puts("PASS: caller deadlines do not truncate transport response time");
		return 0;
	}
	if(argc == 2 && !strcmp(argv[1], "--expired-majority"))
	{
		partial_drop_pressure_retirement();
		puts("PASS: expired majority cannot reset real matched progress");
		return 0;
	}
	pacing_and_latency();
	all_dropped_backpressure();
	fairness_aliases_deadlines();
	no_catchup_wrap_and_transport_close();
	bounded_silence_reset_and_fresh_recovery();
	continuing_replies_preserve_healthy_transport();
	original_deadline_and_progress_boundaries();
	partial_drop_pressure_retirement();
	absolute_orphan_age_and_ready_reply_boundary();
	puts("PASS: semantic pacing, bounded silence/orphan recovery, progress-safe backlog, dispatch response interval, ready-reply boundary and IDs");
	return 0;
}
