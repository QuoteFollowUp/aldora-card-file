# Aldora Card File

Business card scanning and customer contact lists for the Aldora sales team. Each rep sees only their own contacts. Branch managers see their branch. The manager sees everything.

## How access works

| Who | Signs in with | Sees | Can do |
|---|---|---|---|
| Manager | `MANAGER_CODE` | All contacts | Everything, plus import, rep codes, delete, reassign |
| Branch manager | Code created in Reps & codes | Contacts at their branch | Edit, mark left company, change log for their branch |
| Rep | Code created in Reps & codes | Their own contacts only | Scan, add, edit, mark left company |

The server enforces access. A rep's phone never receives another rep's contacts.

## Netlify setup (one time)

1. In Netlify: **Add new site > Import an existing project > GitHub**, then pick `QuoteFollowUp/aldora-card-file`. Build settings come from `netlify.toml`, so leave them as they are.
2. **Site configuration > Environment variables.** Add:
   - `MANAGER_CODE`: your manager sign-in code. Use something long.
   - `ANTHROPIC_API_KEY`: the Aldora key from console.anthropic.com. Card reading and email drafts use it.
   - `SESSION_SECRET`: any long random string. Changing it signs everyone out.
   - Optional: `CLAUDE_SCAN_MODEL` (default `claude-haiku-5-5`) and `CLAUDE_DRAFT_MODEL` (default `claude-sonnet-5-5`).
3. Deploy. Netlify Blobs needs no setup.
4. Rename the site to `aldoracardfile` so the address is aldoracardfile.netlify.app.

## First load

1. Sign in with `MANAGER_CODE`.
2. **Import** tab: upload the Email Distribution Lists workbook. The app reads the All Contacts tab, cleans it, and files each contact under its rep. All 16 reps appear under Reps & codes.
3. **Reps & codes** tab: tap **Create code** for each rep, then **Copy message** and send it to them by text or Teams.

## Keeping contacts current

- **Reps in the field:** they scan cards, edit details, and tap **Left company** when someone leaves. A rep who names the replacement gets a new contact form with the company details already filled in.
- **Monthly call log refresh:** upload the new workbook on the Import tab. New contacts are added. Rep and branch follow the call log, so a reassigned account moves to the new rep automatically. Anything a rep edited in the field is kept.
- **ERP addresses:** upload a customer list on the Import tab and match its columns. Addresses fill in for every contact at a matching customer name. Addresses reps already entered are kept.
- **Changes tab:** every field edit, departure, new contact, and reassignment, with who made it and when. Export it weekly to correct the call log and the ERP.

## Notes

- To reassign a contact by hand, edit it as manager and change the rep. The next call log import will set it back to whatever rep the call log shows, so make the change in the call log too.
- Turning off a rep or resetting their code signs them out right away.
- Deleting is manager only. Reps use Left company, which keeps the history.
- Data is stored in the Netlify Blobs store `cardfile` on this site.

## Files

- `public/`: the app (index.html, app.js, app.css, icons, manifest)
- `netlify/functions/api.mjs`: sign-in, access control, storage, card reading, imports
