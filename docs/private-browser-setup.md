# Private browser setup

This repository can start a temporary interactive Chrome desktop and publish it at:

`https://privatebrowser.laptopvalue.co.uk`

The browser runs on a fresh standard GitHub-hosted Ubuntu runner. noVNC provides the browser interface locally on port `6080`, and a remotely managed Cloudflare Tunnel publishes that local HTTP service. Cloudflare Access must protect the hostname before the tunnel token is added to GitHub.

## Security model

- The GitHub runner is temporary and is destroyed when the workflow ends.
- Chrome uses a new profile for each run.
- VNC listens only on `localhost`; it is not directly exposed to the Internet.
- The tunnel token is stored only as a GitHub Actions secret.
- Cloudflare Access authenticates every user before traffic reaches noVNC.
- Only the repository owner can start sessions through issues.
- Manual workflow runs require write access to the repository.
- Starting a new session cancels the previous session.

## 1. Create the Access application first

In the Cloudflare dashboard:

1. Open **Zero Trust**.
2. Go to **Access controls → Applications**.
3. Create a new **Self-hosted and private** application.
4. Add the public hostname `privatebrowser.laptopvalue.co.uk`.
5. Add an **Allow** policy containing only your email address or your chosen identity group.
6. Set an appropriate session duration.
7. Enable **Protect with Access** for the tunnel route when that option is shown.

Do not publish the tunnel hostname before an Access policy exists. A published tunnel route without Access would expose the noVNC login page publicly.

## 2. Create the remotely managed tunnel

In Cloudflare:

1. Go to **Networking → Tunnels**.
2. Create a Cloudflared tunnel named `laptopvalue-private-browser`.
3. Add a published application route:
   - **Hostname:** `privatebrowser.laptopvalue.co.uk`
   - **Service type:** HTTP
   - **Service:** `http://localhost:6080`
4. Save the route. For a domain using Cloudflare DNS, Cloudflare should create the required DNS record.
5. Open the tunnel overview and choose **Add a replica**.
6. Copy only the long tunnel token from the installation command. It normally begins with `eyJ`.

Anyone holding this token can run that tunnel, so treat it as a credential.

## 3. Add the GitHub secret

In `feldaron/browser-fetch`:

1. Open **Settings → Secrets and variables → Actions**.
2. Create a repository secret named `CLOUDFLARE_TUNNEL_TOKEN`.
3. Paste the tunnel token as the value.

Do not add the token to a file, issue, commit, workflow input, log, or repository variable.

## 4. Start a session manually

1. Open **Actions → Private browser session**.
2. Choose **Run workflow**.
3. Enter the first page to open.
4. Enter a duration between 15 and 300 minutes.
5. Open `https://privatebrowser.laptopvalue.co.uk` after the workflow reaches the tunnel step.
6. Authenticate through Cloudflare Access.

When the workflow ends, the hostname will become unavailable until the next session starts.

## 5. Start a session through an owner issue

Create an issue with a title beginning with `[browser]`. The entire issue body must be JSON:

```json
{
  "startUrl": "https://www.currys.co.uk/",
  "durationMinutes": 60
}
```

Only an issue authored by the repository owner can start the browser. The workflow comments when the session starts, closes the issue when the session ends, and rejects durations outside 15–300 minutes.

## Expected behaviour

- The hostname may show a Cloudflare error while no session is running. This is normal because there is no active tunnel replica or local noVNC service.
- The first run takes several minutes because the runner installs Chromium and desktop packages.
- Browser state, cookies, downloads and history disappear when the workflow ends.
- Diagnostic logs are retained as a private-to-repository Actions artifact for seven days. Do not enter sensitive personal credentials into the browser unless this temporary-runner model is acceptable for that account.

## Required Cloudflare configuration summary

| Setting | Value |
|---|---|
| Access application | Self-hosted public hostname |
| Hostname | `privatebrowser.laptopvalue.co.uk` |
| Tunnel | Remotely managed Cloudflared tunnel |
| Origin service | `http://localhost:6080` |
| GitHub secret | `CLOUDFLARE_TUNNEL_TOKEN` |
| Access policy | Allow only the intended user identity |
