# Outlook add-in: "Check request"

A button in Outlook's message toolbar. An employee who's unsure about an email opens the task
pane and gets the same read the gate would give: ALLOW, WARN or PAUSE, the tactics in plain
English, and the phrases highlighted in the message. It needs no IT integration beyond
installing the add-in.

- **Checking stores nothing.** `POST /v1/check-message` analyzes the message and returns.
- **Reporting is the employee's choice.** "Report to security" sends the email to the tenant
  (`POST /v1/artifacts`). It then shows up in the console and is linked to any later approval
  that mentions the same invoice or vendor id.
- **Sender only.** The pane reads the sender, Reply-To (Mailbox 1.8+), subject and body text.
  Recipients are never read or sent.

## Install for a pilot

1. Serve the API over **https** at a stable origin, and set `SHIELD_PUBLIC_URL` to it, for example
   `SHIELD_PUBLIC_URL=https://shield.acme.internal`. Outlook loads the pane from there.
2. Download the manifest: `https://shield.acme.internal/addin/manifest.xml`.
3. Install it, either way:
   - **One person (sideload):** in Outlook on the web, go to _Get Add-ins → My add-ins → Custom
     add-ins → Add from file_ and choose `manifest.xml`.
   - **The whole finance team:** a Microsoft 365 admin uses _Integrated apps → Upload custom apps_
     and deploys the manifest to a group.
4. On first use, each person pastes the organization key from the security team. It's kept in
   their Outlook roaming settings.

## Pilot limits

- **Authentication.** A tenant API key in roaming settings is pilot-grade. Single sign-on (Entra ID
  nested app authentication) replaces it in M6.
- **How it was tested.** It was tested with a stand-in for Office.js, in light and dark themes, at
  task-pane width. The API route and the manifest have automated tests. It has **not** yet been
  run inside a real Outlook client: that needs a Microsoft 365 account to sideload into.
