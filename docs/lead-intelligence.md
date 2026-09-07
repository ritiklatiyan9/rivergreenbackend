# Lead intelligence

The existing Lead Management page now includes agent and portfolio analytics. Choose an agent and a 7, 30, or 90 day activity window, then open **Explore agent & client analytics**. The agent, status, category, and search filters also define the lead portfolio. Open a lead's **Insights** tab for the relationship timeline and recorded client preferences.

## Metrics

- Portfolio counts and current booked status cover all dates, within the selected filters.
- Contact coverage is leads with at least one positive-duration call divided by portfolio leads, across all recorded history.
- Pickup rate is positive-duration calls divided by calls in the selected period. With no calls, the rate is unavailable rather than 0%.
- The period starts at midnight `days - 1` days ago and ends now, using the database timezone (Asia/Kolkata by default).
- Selected-agent call and follow-up activity is credited to the recorded actor on that agent's **current** portfolio. Historical calls on clients reassigned away from that agent are outside this view.
- Active days are distinct days containing a recorded call, not employee attendance.
- Notes coverage is calls containing nonblank customer notes divided by period calls.
- Follow-up completion is currently completed follow-ups divided by follow-ups scheduled within the period and due by now. It does not claim on-time completion; completion timestamps are not used.
- Untouched means no calls recorded. Stale means an open lead with no call in seven days (or no calls since creation more than seven days ago). Booked, lost, and not-interested leads are excluded from the attention list.
- Pending and snoozed follow-ups past their scheduled time count as overdue.
- Source booked share uses current lead statuses; it is not a period acquisition conversion rate.

## Access and rollout

Deploy the updated backend and frontend. No database migration is required: the implementation uses existing leads, calls, followups, users, call_outcomes, and lead_assignments tables.

New read-only endpoints:

- `GET /api/leads/analytics?days=30&agent_id=<uuid>&status=NEW&lead_category=HOT&search=<text>`
- `GET /api/leads/:id/insights`

The authenticated site always controls scope. Admins, owners, and supervisors can inspect the site's permitted portfolios. Agents and team heads retain the existing owner-or-assigned lead scope and cannot select another agent. Client insights repeat the existing lead ownership and site checks before querying history.

Analytics responses are cached for 30 seconds by the existing user/site-aware backend cache. Agent rankings return up to 50 entries; selecting a specific agent filters before that limit. The attention queue returns eight leads. Client metrics cover all recorded history; timeline payloads contain the latest 100 events and the total event count. Full legacy call and appointment history loads only when those tabs are opened.

The frontend displays an explicit unavailable state if the new backend has not yet been deployed; it does not substitute fabricated analytics. The existing lead list and Info, Call History, and Appointments tabs remain usable.

## Validation

Run `node --test src/__tests__/leadInsights.test.js` from the backend directory. Frontend checks: `npx eslint src/pages/Leads.jsx src/components/leads/*.jsx src/components/leads/useLeadInsightsResource.js` and `npm run build`.

The aggregate SQL was additionally executed against an isolated PostgreSQL engine with multiple sites, agents, shared call histories, multiple follow-ups, and over 100 client events. Checks covered join multiplication, scope isolation, empty results, snoozed follow-ups, exact totals, and timeline bounds. Live production performance and browser layout still require validation in the deployed environment.
