# Manual Test Plan

## Overview

This document describes manual tests for verifying the CS Helper bot changes:
- Related tickets: LLM selection from last 7 days (no state filtering)
- Documents: Notion direct search + keyword matching (no blob index required)
- Supportive responses: Always helpful, never dismissive
- New /search endpoint response structure

## Prerequisites

1. Environment variables set:
   - `ANTHROPIC_API_KEY` - Required for LLM features
   - `NOTION_TOKEN` and `NOTION_ROOT_PAGE_ID` - For Notion search
   - `LINEAR_API_KEY` and `LINEAR_TEAM_KEY` - For ticket integration
   - `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` - For Slack integration

2. Type check passes: `deno check main.ts`

---

## Web Endpoint Tests

### Test 1: /search Basic Query
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q=analysis+stuck+pending"
```

**Expected Response:**
```json
{
  "q": "analysis stuck pending",
  "summary": "...",
  "recommendation": "try_steps" | "file_ticket",
  "next_actions": ["...", "...", "..."],
  "docs": [
    {
      "title": "...",
      "section": "...",
      "url": "...",
      "score": 0.xx,
      "provenance": "semantic" | "keyword" | "both"
    }
  ],
  "related_tickets": [
    {
      "identifier": "ENG-123",
      "title": "...",
      "url": "...",
      "state": "...",
      "reason": "..."
    }
  ],
  "search_source": "notion_direct" | "blob_index" | "both",
  "latency_ms": ...
}
```

**Verify:**
- [ ] Response includes `summary` (2-5 sentences)
- [ ] Response includes `recommendation` (try_steps or file_ticket)
- [ ] Response includes `next_actions` (3-6 actionable bullets)
- [ ] `docs[]` includes `provenance` field
- [ ] `related_tickets[]` includes `reason` field
- [ ] Works WITHOUT running /rebuild first (cold start)

### Test 2: /search with No Matches
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q=random+gibberish+xyz123"
```

**Verify:**
- [ ] Returns supportive response (not dismissive)
- [ ] `summary` offers helpful suggestions
- [ ] `next_actions` provides actionable steps
- [ ] Does NOT say "out of scope" or similar

### Test 3: /search Help Query
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q=help"
```

**Verify:**
- [ ] Returns help content
- [ ] `route` is "help"
- [ ] Includes example queries

### Test 4: /health Endpoint
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/health"
```

**Verify:**
- [ ] Returns status information
- [ ] Shows embedding status
- [ ] Shows index version

### Test 5: /search Works From Cold Start
```bash
# Delete blob index first (optional - via /blob-debug)
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q=finalize+blocked"
```

**Verify:**
- [ ] Search works even without blob index
- [ ] Uses Notion direct search
- [ ] Returns results with `search_source: "notion_direct"`

---

## Slack Integration Tests

### Test 6: Slash Command - Normal Query
In Slack: `/cs-help analysis stuck in pending state`

**Verify:**
- [ ] Bot posts parent message
- [ ] Bot replies in thread with response
- [ ] Response shows "Suggested next steps" if available
- [ ] Response shows "Related tickets (last 7 days)"
- [ ] Ticket reasons are shown (e.g., "Similar error symptoms")
- [ ] "File ENG ticket" button appears only when recommended
- [ ] "Ask a follow-up" button is present

### Test 7: Slash Command - Unclear Query
In Slack: `/cs-help the thing is broken`

**Verify:**
- [ ] Response is supportive (starts with "Let me help you with this")
- [ ] Shows suggested next steps
- [ ] Shows info to collect for this issue
- [ ] Does NOT say "I can't help" or "out of scope"

### Test 8: Slash Command - Previously "Out of Scope" Query
In Slack: `/cs-help how's the weather`

**Verify:**
- [ ] Bot attempts to help (doesn't early-exit)
- [ ] Provides supportive response
- [ ] Suggests how to rephrase for better results
- [ ] Does NOT show "out of scope" message

### Test 9: @mention in Thread
1. Start a thread with `/cs-help finalize not working`
2. Reply in thread with `@cs-helper what if they already tried refreshing?`

**Verify:**
- [ ] Bot responds in same thread
- [ ] Response addresses the follow-up question
- [ ] Context from original question is preserved

### Test 10: Follow-up Button
1. Run `/cs-help tracker not updating`
2. Click "Ask a follow-up" button
3. Enter follow-up question in modal

**Verify:**
- [ ] Modal opens successfully
- [ ] Follow-up response appears in thread
- [ ] Maintains conversation context

### Test 11: File Ticket Button
1. Run `/cs-help urgent customer issue needs engineering`
2. Click "File ENG ticket" button

**Verify:**
- [ ] Linear ticket is created
- [ ] Ticket appears in correct team/label
- [ ] Ticket description includes:
  - Original question
  - Runbook pointers
  - Related tickets
  - Required info checklist

---

## Ticket Selection Tests

### Test 12: Related Tickets - No State Filtering
1. Create a test ticket in Linear marked as "Closed"
2. Run `/cs-help` with a query matching that ticket's title

**Verify:**
- [ ] Closed ticket appears in related tickets
- [ ] Ticket shows its actual state (e.g., "Done")
- [ ] LLM provides reason for relevance

### Test 13: Related Tickets - Last 7 Days
1. Note the date of oldest ticket in Linear
2. Run `/cs-help` with generic query

**Verify:**
- [ ] Only tickets from last 7 days appear
- [ ] Older tickets are excluded
- [ ] Header says "Related tickets (last 7 days)"

### Test 14: Related Tickets - LLM Selection
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q=customer+survey+not+loading"
```

**Verify:**
- [ ] `related_tickets[].reason` contains meaningful explanation
- [ ] Reasons are 5-15 words each
- [ ] Unrelated tickets are not included

---

## Edge Cases

### Test 15: Empty Query
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q="
```

**Verify:**
- [ ] Returns help response
- [ ] Does not error

### Test 16: Very Long Query
```bash
curl "https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/search?q=..." (500+ characters)
```

**Verify:**
- [ ] Query is truncated gracefully
- [ ] Response is generated
- [ ] No timeout or error

### Test 17: API Key Missing (Degraded Mode)
Temporarily remove `ANTHROPIC_API_KEY`

**Verify:**
- [ ] Keyword-only search still works
- [ ] Ticket selection falls back to keyword matching
- [ ] Response includes fallback summary

### Test 18: Linear API Failure
Temporarily set invalid `LINEAR_API_KEY`

**Verify:**
- [ ] Search completes without tickets
- [ ] Error is logged but not shown to user
- [ ] Response includes runbook results

### Test 19: Notion API Failure
Temporarily set invalid `NOTION_TOKEN`

**Verify:**
- [ ] Falls back to blob index (if available)
- [ ] Error is logged
- [ ] Supportive response still provided

---

## Known Limitations

1. **Latency**: LLM-based ticket selection adds ~2-3s to response time
2. **Cold Start**: First request after deploy may be slower
3. **Ticket Limit**: Only last 100 tickets from 7 days are considered
4. **Notion Search**: Limited to 15 pages, 50 blocks per page
5. **Val Town Timeout**: Requests must complete within execution limit

---

## Success Criteria

All tests above should pass for the changes to be considered complete:
- [ ] Web endpoint tests (1-5) pass
- [ ] Slack integration tests (6-11) pass
- [ ] Ticket selection tests (12-14) pass
- [ ] Edge cases (15-19) handled gracefully
