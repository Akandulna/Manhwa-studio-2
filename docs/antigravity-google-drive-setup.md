# AntiGravity: Google Drive setup

This guide connects Studio to the Google Drive that receives page slices. Studio creates `My Drive / Manhwa Studio /` itself. You don't create any folders.

You need about 10 minutes, a Google account that owns (or can create) a Google Cloud project, and the Drive account you want Studio to use. These can be the same account.

## Part A: Google Cloud (once per project)

Do these steps in the browser as the owner of the Google Cloud project. Studio can't do them for you. The **AntiGravity → Settings → Google Drive** panel links to each page.

1. **Project.** Create or select a project at <https://console.cloud.google.com/projectcreate>, for example "Manhwa Studio".
2. **Enable the Drive API.** Open <https://console.cloud.google.com/apis/library/drive.googleapis.com> and click **Enable**.
3. **Branding.** In Google Auth Platform → **Branding** (<https://console.cloud.google.com/auth/branding>), set the app name to "Manhwa Studio" and add your support email. Fill in the developer contact email too.
4. **Audience.** In Google Auth Platform → **Audience** (<https://console.cloud.google.com/auth/audience>):
   - Choose **External** for a personal Gmail account.
   - Leave the publishing status as **Testing** and add the Drive account you will connect under **Test users**.
5. **Data access.** In Google Auth Platform → **Data access** (<https://console.cloud.google.com/auth/scopes>), add these scopes:
   - `.../auth/drive.file`: Studio only sees files it creates. It never asks for your whole Drive.
   - `openid`
   - `.../auth/userinfo.email`: lets Studio show which account is connected.
6. **OAuth client.** In Google Auth Platform → **Clients** (<https://console.cloud.google.com/auth/clients>), choose **Create client**, then **Application type: Desktop app**, and name it "Manhwa Studio".
7. **Download the JSON.** Download the new client's JSON file (`client_secret_….json`). Keep it out of the repository.

> **Use a Desktop app client.** A "Web application" client is rejected because Studio signs in through a temporary `127.0.0.1` address on your Mac. It doesn't need a public callback domain.

## Part B: connect in Studio

1. Open **AntiGravity → Settings → Google Drive**.
2. Click **Import OAuth client JSON** and choose the file from step 7.
   - The client secret goes into the macOS **Keychain** (item "Manhwa Studio · Google Drive"). The panel only ever shows the client ID.
   - macOS may ask whether `node` may use the Keychain. Choose **Always Allow**.
3. Click **Connect Google Drive**. Your normal browser opens Google's sign-in page.
   - Choose the account you want Studio to use.
   - Tick **every** permission, including the Google Drive one.
   - Google shows "Google hasn't verified this app" while the app is in Testing. Click **Continue**. This is expected for your own project.
4. The browser tab says **Google Drive connected**. Back in Studio you should see:
   - The verified account email.
   - Storage used, plus the total when Google reports one.
   - A link to **Manhwa Studio**, the root folder Studio just created in My Drive.
5. Click **Test connection**. Studio checks the connection like this:
   - It uploads a small new test image into **Manhwa Studio** and downloads it again.
   - It compares the SHA-256 of what it sent, what it got back, and what Drive reports.
   - It then deletes only that test file.
   - A pass shows "Upload → download verified" with the three hashes.

Studio creates the deeper folders (`<Series>/Chapters/<Exact Chapter Folder>/<page>__<hash>/`) only when you prepare pages.

## Part C: the rest of AntiGravity setup

Once Drive shows **Connected**, finish the setup in **AntiGravity → Settings**:

1. **Local Antigravity.**
   - Install the official `agy` CLI and sign in with its own login. **Sign in** opens Terminal for that; Studio never asks for a password.
   - Studio finds `~/.local/bin/agy` and lists the models your account offers.
2. **Model.** Pick a model that can see images:
   - Gemini 4 Argon and Claude Sonnet 5.5 both worked on real pages.
   - GPT-OSS 120B is text-only, and the list labels it that way.
3. **Run compatibility test.** It makes two real turns, so it uses a little quota. Start stays disabled until the test passes for the selected model, CLI version and sandbox setting. Run it again whenever you change any of them.
4. **Prompt pack.** Crop Rules, Crop Pointer and Review start as the Sleeper-Cell v2 defaults. Edits are saved as new versions, and every run keeps the versions it started with.
5. **Parallel pages:** 1–4. Each page has its own conversation, and the limit counts every run on this Mac together.
6. **Cloudflare R2** (**Settings → Cloudflare**) must be set up before **Start process**, because finished pages are shared with the phones there. **Prepare selected** works without it.

## Day to day

| You see | Meaning | What to do |
| --- | --- | --- |
| **Connected** | The token refreshes automatically. | Nothing. |
| **Reconnect required** | Google stopped accepting Studio's saved authorization. Apps left in **Testing** expire it after **7 days**. It also happens if you revoked access or changed your password. | Click **Reconnect** and choose the same account. Uploaded files and jobs are kept. |
| **Manhwa Studio folder was deleted or trashed** | Studio won't upload anywhere else on its own. | Restore it from Drive's Trash, or click **Repair: create a new folder**. |
| **Storage is full** | The connected account has no space left. | Free up space or upgrade storage, then retry. |

- **Switch account:** click **Switch account** and choose another Google account. Each account keeps its own `Manhwa Studio` folder and history. Switching is refused while AntiGravity work is running.
- **Disconnect:** Studio does three things:
  - It deletes its saved authorization from the Keychain.
  - It asks Google to revoke it.
  - It keeps every file in Drive.

  If Studio is offline, it says that revocation wasn't confirmed. To be sure, remove "Manhwa Studio" at <https://myaccount.google.com/permissions>.
- **Avoiding the 7-day expiry:** set the app's publishing status to **In production** in Google Auth Platform → Audience. Google may then ask you to verify the app.

## Costs and limits

Google currently doesn't charge for Drive API calls within its published quotas: <https://developers.google.com/workspace/drive/api/guides/limits>. Uploaded slices count against the connected account's storage. Studio slows down and retries when Google throttles it, but it never promises unlimited free use.

## What Studio stores where

| Item | Location |
| --- | --- |
| OAuth client ID, project ID | Studio database (`DriveOAuthClient`) |
| OAuth client secret | macOS Keychain |
| Refresh token (one per account) | macOS Keychain, referenced by an opaque ID in `DriveConnection.secretRef` |
| Access token | Server memory only; it is renewed automatically |
| Account email, granted scopes, last test result | Studio database (`DriveConnection`) |
| Drive folder IDs | Studio database (`DriveFolderMapping`). Folders also carry hidden Studio labels so they are found by identity, never by name. |

No secret is ever stored in Studio's generic Settings, in browser storage, in logs, in prompts, or sent to Antigravity or R2. The Drive endpoints answer only requests from the Mac running Studio.

## Troubleshooting

- **"This is a Web application OAuth client"**: create a **Desktop app** client (step 6).
- **"The Google Drive API is not enabled"**: do step 2, wait a minute, then retry.
- **"The Google Drive permission was not granted"**: on Google's consent screen the Drive checkbox was left unticked. Connect again and tick it.
- **"Error 403: access_denied" in the browser**: the account isn't listed as a Test user (step 4).
- **"macOS Keychain refused …"**: unlock the login keychain, or click **Allow** when macOS asks. Studio never falls back to plain text.
- **The browser didn't open**: the panel shows **Open sign-in page again**. The request expires after 10 minutes.
