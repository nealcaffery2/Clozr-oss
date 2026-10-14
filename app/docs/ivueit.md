# iVueit photo orders

Casey or the TC orders property photos from the deal sheet or the TC file ("Order photos"). CLOZR creates a Vue at iVueit, and the photos and report PDF land on the deal when a Vuer finishes.

Sources: iVueit's Self-Service API Integration guide (v1.5.5) and the Swagger spec at app.swaggerhub.com/apis/iVueit/Rest_API_Production (1.5.5 and 1.5.6). Where the two differ, CLOZR follows the Swagger spec, which is what the API answers:

| Guide says | Swagger and CLOZR use |
| --- | --- |
| Base URL `api.ivueit.com` | `https://prod.data.ivueit.network` (staging: the URL iVueit gives you, set under Settings, Integrations) |
| Create a Vue: `POST v1/vues` | `POST /api/v1/batch/import` |
| Get a Vue: `GET v1/vues/{id}` | `GET /api/v1/vue/{id}` |
| Cancel: `POST v1/vue/cancel/{id}` | `PUT /api/v1/vue/cancel/{id}` |
| Photos: `GET v1/vues/{id}/photos` | `GET /api/v1/surveysubmission/{id}` (steps' photos) and `GET /api/v1/file/url/{id}` |

Auth matches the guide: `POST /login/v1/service` with `{apiKey, secret}`; the token goes in the `x_ivueit_auth_token` header on every call. `publishAt` and `expiresAt` are nanoseconds since the epoch, sent exactly.

## Webhooks

Settings, Integrations, iVueit, "Test connection" registers all three webhook types iVueit offers (one active per type per company), each pointed at the `ivueit-webhook` function with the workspace's secret token and `e=<type>`:

- **VueCompleted**: copies the photos and the report PDF onto the deal, sets the cover photo, and notifies the deal team (acquisitions rep, lead manager, dispo reps, TC, and whoever ordered).
- **VueCanceled**: closes the open order as canceled and tells the deal team to order again.
- **VueEscalated**: logs it on the deal and tells the deal team the photos were flagged (the report may be regenerated).

A sweep every 20 minutes (`clozr-ivueit-sweep`) catches anything a missed webhook left open.

Code: `supabase/functions/_shared/ivueit.ts`, `supabase/functions/ivueit`, `supabase/functions/ivueit-webhook`, `components/PhotoOrderPanel.tsx`, `components/IvueitCard.tsx`, migration 255. Tests: `npx tsx tools/ivueit.test.ts`.
