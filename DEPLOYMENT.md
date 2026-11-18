# Deploy Slipstream staging on Railway

One public HTTPS address serves the UI and the `/sessions` API. A second service in the same Railway environment runs MySQL on the private network. MySQL holds temporary pairing and signaling records. The intended transfer path is the browsers’ ordered WebRTC data channel. No PHP endpoint accepts a file upload.

**Current release blocker.** On the audited staging revision `0fbbb39`, two local Chrome tabs exchanged SDP and ICE and opened the data channel. Both then stopped before the file picker or incoming-file screen. `js/app.js` initializes the transfer engines with an options object and calls `sender.start()`. The committed engines require the channel as their first argument, and the sender exposes `send()`. The receiver emits `file-verified`; the documented contract expects receiver progress and `file-complete-ack`. Restore a compatible Phase 2 integration before signing off on transfers. The signaling smoke test can pass while this blocker is present.

## 1. Prepare the branch and account

1. Review the pull request from `feature/deploy-railway` into `staging`. Merge it after review. In GitHub, open `staging` and record its commit SHA. The repository root should contain `Dockerfile` and `railway.json`.
2. Check the Railway workspace's plan, remaining trial credits, spending controls and payment settings before provisioning. Hobby currently has a $5 monthly minimum usage commitment. The PHP service and MySQL consume CPU and memory, the database volume uses storage, and outbound traffic can incur charges. Peer-to-peer file bytes travel outside Railway. Continuous staging uptime can exceed the plan minimum. [Railway billing](https://docs.railway.com/pricing/understanding-your-bill)
3. In Railway, create an **Empty Project** named **Slipstream**. In the environment selector choose **New Environment → Empty Environment**, name it **staging**, then select it. Keep both services and their credentials in this environment. [Environments](https://docs.railway.com/environments)
4. If the old password in `config/config.example.php` was ever valid, rotate it everywhere it was used. Its previous value remains in Git history. Use Railway-generated credentials for staging.

## 2. Create the private database

On the **staging** canvas select **New → Database → MySQL**. Keep the service name **MySQL** for the reference expressions below. Apply the database change and wait for the service to become active. Check that its data volume is attached. In **MySQL → Settings → Networking**, use private networking only. If the template added a public TCP proxy, remove that proxy. The schema initializer runs inside Railway and needs no public database access. [MySQL](https://docs.railway.com/databases/mysql) · [Private networking](https://docs.railway.com/networking/private-networking)

## 3. Connect the web service and set its variables

1. On the same canvas, add an **Empty Service** named **Slipstream Web**. In **Settings → Source** connect the GitHub repository `jupiterbouncer/slipstream`. Grant the Railway GitHub App access to that repository if prompted. Select **staging** as the deployment trigger branch before applying the staged web changes. Check the branch explicitly because this repository's default branch is `master`. Keep automatic deployments enabled. [GitHub autodeploys](https://docs.railway.com/deployments/github-autodeploys)
2. Keep the root directory at the repository root. Leave build and start command overrides empty. Railway uses the root Dockerfile, and the image starts Apache in the foreground. [Dockerfile builds](https://docs.railway.com/builds/dockerfiles)
3. In **Slipstream Web → Variables**, add the entries below. Enter the reference expressions literally, or use Railway's reference picker. Change `MySQL` in the expressions if you renamed the database service. Check that `MYSQLHOST` resolves to its private hostname and `MYSQLPORT` is the internal MySQL port. [MySQL connection variables](https://docs.railway.com/databases/mysql) · [Railway variables](https://docs.railway.com/variables)

| Web variable | Staging value | Use |
| --- | --- | --- |
| `DB_HOST` | `${{MySQL.MYSQLHOST}}` | Private database host |
| `DB_PORT` | `${{MySQL.MYSQLPORT}}` | Internal database port |
| `DB_NAME` | `${{MySQL.MYSQLDATABASE}}` | Provisioned database |
| `DB_USER` | `${{MySQL.MYSQLUSER}}` | Database user |
| `DB_PASS` | `${{MySQL.MYSQLPASSWORD}}` | Secret password reference |
| `PORT` | `8080` | Set this for an explicit domain target. Apache also accepts Railway's injected port. |
| `APP_ENV` | `staging` | Already set in the image. Requires all five DB variables. |

The PHP loader applies environment variables after local overrides. Local development can use ignored `config/config.local.php` or `config/local.php`. The Docker build includes only the tracked loader.

## 4. Deploy, initialize the tables and generate the URL

1. Review the staged web changes, confirm the environment and branch both say **staging**, then **Deploy**. In the web service's **Deployments** tab open the deployment and compare its GitHub commit with the recorded SHA. Subsequent pushes or merges to the connected `staging` branch trigger builds.
2. Open **Build Logs**. The image installs `pdo_mysql`, enables Apache rewriting and headers, and checks the Apache configuration and PDO driver. A failed build cannot serve traffic. [Railway logs](https://docs.railway.com/observability/logs)
3. Check the pre-deploy output for **Signaling schema is ready (sessions and rate_limits).** The command configured in `railway.json` is:

   ```sh
   php /opt/slipstream/database/init.php
   ```

   Railway runs it with the web service variables and private network access. It applies `database/schema.sql` to the database selected by `DB_NAME`. Both table definitions use `CREATE TABLE IF NOT EXISTS`; they preserve rows and indexes on a repeat run. A nonzero exit stops the release. Retrying a failed deployment safely repeats the command. An older, incompatible table definition requires a separately reviewed migration. [Pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
4. Apache binds to `0.0.0.0:$PORT`. The deployment health check requests `/`. When it passes, go to **Slipstream Web → Settings → Networking → Public Networking → Generate Domain**. Use target port **8080** if you set the variable above. Open the generated **https://** URL. Railway provisions TLS at its edge. Generate a domain for the web service only. [Public networking](https://docs.railway.com/networking/public-networking)
5. In the browser console, check `window.isSecureContext`, `typeof crypto.subtle?.digest`, `typeof RTCPeerConnection` and `typeof navigator.mediaDevices?.getUserMedia`. Expect `true` followed by three `"function"` results in a supported browser. Use the phone's camera app to open the QR link. The existing in-app scan button displays instructions.

## 5. Verify the deployed commit

From the repository root on a computer with Node.js 18 or newer, replace the example URL with the generated web domain:

```sh
node qa/staging-smoke.mjs https://YOUR-WEB-DOMAIN
```

The script creates one temporary session and deletes it after the signaling checks. Node is used only to run this test. A passing run checks the following HTTP contract:

| Request | Expected evidence |
| --- | --- |
| Home, CSS, SVG, six browser scripts | 200 and expected content or media type |
| Create and look up a pairing code | 201 with code and future expiry, then 200 JSON |
| Poll offer and answer before submission | 204 with empty body |
| Submit and retrieve each description | 200 and matching JSON |
| Submit and retrieve ICE for host and joiner | 200 and matching candidate objects, then empty list after the cursor |
| Invalid offer, malformed code, unknown API route, wrong method | 400, 400, 404 and 405 with JSON errors |
| Delete the test session, then look it up | 204 then 404 JSON |

Additional acceptance checks:

- In the MySQL service's **Data** view, confirm `sessions` and `rate_limits` exist. The indexes on expiry and last failed attempt are `idx_expires_at` and `idx_last_attempt`.
- Open `/config/config.php`, `/api/db.php`, `/.env`, `/.git/HEAD`, `/database/schema.sql`, `/deploy/apache.conf` and an unknown path on the web domain. Expect 403 or 404. The production document root contains only the application page and its browser assets.
- To check natural expiry, create a code, leave it unused for the default ten minutes, then try it from a second device. Expect an expired/missing-session error and a 404 on the lookup. Expired rows are cleared on later API traffic.
- Keep a record of the deployment SHA, browser versions, device types, network used and results. Omit active pairing codes, SDP, ICE addresses and passwords.

### Two physical devices

1. Put a laptop and phone on the same ordinary Wi-Fi network. Open the public HTTPS address on Device A, select **Send a file**, and confirm a six-character code and QR appear.
2. Open the same address on Device B, choose **Receive a file**, enter the code and connect. Confirm both devices show the connected screen. In a second session, scan the QR with the phone camera and confirm it opens the same HTTPS origin with `?join=CODE` and joins automatically.
3. Choose a known, nonempty file larger than 16 KiB. Select **Send file**. Check the receiver's name and size preview, then **Accept**. Watch both progress trails. The receiver must finish verification before the download appears. Check that the sender reaches completion as well.
4. Download and open the file. Compare original and downloaded SHA-256 values on a computer. In PowerShell use `Get-FileHash -Algorithm SHA256 -LiteralPath 'path-to-file'` on each copy. On macOS use `shasum -a 256 'path-to-file'`, or on Linux use `sha256sum 'path-to-file'`.
5. Start fresh transfers. **Decline** one offer. **Cancel** another during a larger transfer. Disconnect one device mid-transfer. Confirm the peer displays a rejection, cancellation or failure as appropriate and never offers a partial file for download. Re-pair and retry.
6. Repeat with Android Chrome and iOS Safari where available. Keep the tabs foregrounded for the baseline. Record results separately for Wi-Fi, guest Wi-Fi and mobile data. The latter two can legitimately fail direct ICE connectivity.

### Local build and runtime check

From the repository root on a Docker-equipped machine:

```sh
docker build -t slipstream-staging .
docker run --rm slipstream-staging apache2ctl -t
docker run --rm slipstream-staging php --ri pdo_mysql
```

For a complete local run, prepare an ignored `.env.staging` containing the five DB variables pointing to a disposable **local** MySQL database reachable from Docker. On Docker Desktop use `host.docker.internal` for a host database that accepts container connections. The SQL user needs access to that database. Then run:

```sh
docker run --rm --env-file .env.staging slipstream-staging php /opt/slipstream/database/init.php
docker run --rm --env-file .env.staging -e PORT=8090 -p 127.0.0.1:8090:8090 slipstream-staging
```

In a second terminal run `node qa/staging-smoke.mjs http://127.0.0.1:8090`. Stop the foreground container with Ctrl+C. For development without Docker, use the [README quickstart](README.md#quickstart-setup).

## Troubleshooting and recovery

| Symptom | What to check |
| --- | --- |
| Build fails or unexpected commit appears | Open **Slipstream Web → Deployments → Build Logs**. Compare the commit SHA and source branch. Confirm the root Dockerfile is present on that commit. |
| Pre-deploy fails or API returns 500 | Open pre-deploy or deploy logs. Missing variables are listed by name. Confirm the five references, correct service name, active MySQL instance, private host, selected database and CREATE privileges. Apply changes and redeploy. |
| 502, health check fails, or scripts return HTML | Check Apache startup logs, domain target port and `PORT`. The source root must contain the Dockerfile. Check the paths and content types in the smoke test. |
| Invalid or expired code | Generate a new code. Both devices must use the same staging origin. Check HTTPS, browser network responses and the server clock. |
| A lookup returns 429 | The default limit is ten failed lookups within a 60-second window since the last failure. Wait for it to pass. The limiter uses the socket peer address. Clients behind a Railway proxy or shared network can share a bucket. Arbitrary forwarding headers do not set its identity. |
| Pairing succeeds but the channel never opens | First check offer, answer and both ICE roles. If they exchange successfully, try both devices on the same Wi-Fi with client isolation off. The client uses two Google STUN endpoints and has no TURN relay. NATs, VPNs, guest isolation, blocked UDP and firewalls can prevent a direct connection despite healthy signaling. |
| Camera or hashing unavailable | Check the browser uses the HTTPS domain and is a secure context. Use the system camera or manual code entry and keep both tabs active. |

For the same revision, open the deployment's **⋯ → Redeploy**. To recover an earlier working version, find its successful SHA in **Slipstream Web → Deployments**, select **⋯ → Rollback**, then confirm. Railway restores that image and its deployment variables within your plan's retention window. Check the DB references again, rerun the smoke test and transfer a file. The database volume has its own lifecycle. A web rollback cannot restore its contents. Correct or revert the faulty commit through a PR into `staging` so the next automatic deploy includes the fix. [Deployment actions](https://docs.railway.com/deployments/deployment-actions)
