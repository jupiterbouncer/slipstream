# Slipstream on InfinityFree

The selected CS341 staging address is `https://slipstream.gt.tc`. The PHP API and static frontend share this origin. MySQL stores temporary pairing codes, SDP, ICE and hashed rate-limit counters. Chat, file offers, file names, hashes and file bytes travel on the ordered WebRTC data channel. The application needs PHP with PDO MySQL, Apache URL rewriting and a MySQL-compatible database with JSON functions. There is no server-side file upload.

## Confirm the hosting terms first

InfinityFree restricts file-sharing services and server-hosted chat scripts. Its administrator permits a website’s own JavaScript to call PHP on the same hostname. Slipstream’s PHP handles only short-lived signaling, but the published terms do not explicitly exempt a peer-to-peer file-sharing site. Ask InfinityFree whether this particular classroom use is permitted before uploading or inviting users. Describe the direct file and chat channel and the temporary signaling polls. A successful technical test does not establish permission. [Terms of Service](https://www.infinityfree.com/terms/) · [Permitted uses](https://forum.infinityfree.com/t/what-can-i-do-with-my-hosting-account/49316/1) · [Same-origin method restrictions](https://forum.infinityfree.com/t/making-a-post-request-internally/110058)

## Database and private configuration

1. In the free account’s **MySQL Databases**, select the existing `if0_43492248_slipstream` database. Confirm host `sql113.infinityfree.com`, port `3306` and the **MySQL username** displayed for this account. Copy the database password privately from the hosting account settings. The FTP login is a separate setting.
2. Open **phpMyAdmin** from the panel, select that database in the left column, choose **Import**, select `database/infinityfree.sql` and click **Import**. Verify the `sessions` and `rate_limits` tables, their primary keys, and the indexes `idx_expires_at` and `idx_last_attempt`. The import creates missing tables and preserves existing rows. An existing table with an older definition needs a schema comparison before use. The original `database/schema.sql` remains the local bootstrap script.
3. Make a private copy of `config/config.example.php` named `config/config.local.php`. Set `db.host` and `db.dbname` to the values above, `db.port` to the confirmed port, and `db.user` and `db.pass` to the **actual** MySQL values. Keep `utf8mb4`. Both supported private override filenames are Git-ignored. Private overrides take precedence over environment variables. Use separate files for local and hosted credentials.
4. The free host restricts uploads outside the domain’s document root. Keep the hosted override in `htdocs/config/config.local.php`, protected by the root rewrite and `config/.htaccess`. Upload and verify the protection **before** uploading the private file. Keep credential backups outside the site. If any password previously shown in a project example was used for a real account, rotate it there and update the private override. [Document-root restrictions](https://forum.infinityfree.com/t/config-php-file-disappears-when-i-upload/91536/2)

## Build and upload

Run from the repository root with PHP CLI:

```sh
php deploy/package-infinityfree.php
```

The command prints a fresh `build/infinityfree/<release>/htdocs` path. Each run copies an explicit list. The output should contain these files:

```text
htdocs/
  .htaccess
  index.html
  slipstream-favicon.svg
  css/style.css
  js/
    api.js
    webrtc.js
    transfer-protocol.js
    file-sender.js
    file-receiver.js
    application-messages.js
    session.js
    file-queue.js
    file-viewer.js
    file-requests.js
    share-text.js
    app.js
    ui-motion.js
    vendor/qrcode.min.js
  api/
    db.php
    sessions.php
  config/
    .htaccess
    config.php
```

1. In the client area’s **Domains**, locate the document root for **slipstream.gt.tc**. Use that domain’s `htdocs`. An account with multiple sites may show a domain-specific parent directory.
2. Using File Manager over HTTPS or an FTP client with the panel’s FTP settings and explicit TLS where available, upload the **contents** of the generated `htdocs` into that document root. Enable hidden-file display so both `.htaccess` files transfer. Keep SQL, QA, local router, private backups and deployment tools off the site.
3. For an update, privately back up the current site and database first. Preserve the hosted private override, replace the public files as one release during a quiet period, and compare the uploaded manifest with the list above. Remove only confirmed obsolete public assets. A provider welcome `index.php` or old `index.html` can mask the app. Identify it before replacing it. Keep the previous public release offline for rollback.
4. Use the panel’s free SSL certificate workflow for `slipstream.gt.tc`. Complete the indicated DNS validation if requested, issue and install the certificate, then open the **HTTPS** URL in a normal browser. Check the certificate hostname, expiry, and DevTools for mixed content. Set the panel’s HTTPS redirect if available after confirming HTTPS works. Distribute the HTTPS address so QR links inherit it.
5. Before setting credentials, visit `/config/config.php` and verify a denial (403 or the host’s forbidden page). Confirm `/sessions` produces an application response from PHP in the browser’s Network panel rather than PHP source. Then upload the hosted private override, and check that `/config/config.local.php` is also denied. If configuration is accessible or PHP source is served, take the site offline and rotate any exposed credentials.

## Local checks

Use the PHP/MySQL instructions in the README for local credentials and schema setup. Run:

```sh
node --test qa/transfer.test.cjs qa/signaling-poll.test.cjs
php deploy/package-infinityfree.php
php -S 127.0.0.1:8000 router.php
```

Open `http://localhost:8000` in two browser profiles. Use local Apache with `mod_rewrite`, `AllowOverride All` and a disposable database to test the generated document root and access rules. PHP’s development router does not interpret Apache configuration. Use `php -l <file.php>` and `node --check <file.js>` for syntax checks. Node is only a local test tool.

## Public acceptance on two real devices

Use the browser on each device and the system camera for QR scanning. Start on the same non-isolated Wi-Fi. Record the date, browser versions, network, file size, both SHA-256 values and result.

1. Open `https://slipstream.gt.tc` on both devices. Let the host’s normal browser challenge complete with JavaScript and cookies enabled. Check `window.isSecureContext` and `crypto.subtle` in DevTools where available.
2. Check the Network panel for the favicon, CSS, QR library and every listed JavaScript file. Verify successful status and the expected content type.
3. Click **Send a file**. Confirm `POST /sessions` returns **201** with a code and expiry. On the second device scan the QR link or enter the code. Repeat with the other joining method.
4. Confirm the offer, answer and ICE requests use the same HTTPS origin. Pending SDP returns **204**. Both browsers should reach the connected screen, exchange a test chat message, and stop signaling polls.
5. Select a known file larger than 16 KiB. Verify the receiver’s name and size preview, accept, and watch receiver-confirmed progress. Confirm the download appears after verification and both browsers report completion.
6. Download the file and compare its SHA-256 with the original. Use `Get-FileHash -Algorithm SHA256` in PowerShell or `shasum -a 256` on macOS. Repeat with an empty file and another transfer in the same session.
7. Decline one offer, then cancel a multi-chunk transfer. Check both final states and that no partial download appears.
8. Disconnect or return home. Confirm **204** for `POST /sessions/{code}/delete` with JSON body `{}`; the old code should then be unavailable. Separately leave an unpaired code for ten minutes and confirm it expires. Expired records are reclaimed by subsequent API requests.

## Resource limits, security and troubleshooting

- A normal poll waits 2.5 seconds **after the previous asynchronous poll finishes**. Set `SIGNALING_POLL_MS` in `js/webrtc.js` to adjust the deployment default. Transient failures double the delay up to 30 seconds and polling stops after five consecutive failures. A terminal response such as an expired code or rate limit stops the loop immediately. Open/closed connections cancel pending polls. A chosen interval provides no guarantee about host limits. Check the account’s PHP/CPU, hits and database usage during actual pairing.
- Session expiry is enforced on reads. Records are also deleted on explicit exit or lazily on later requests. Abrupt tab closure can leave a row until the next cleanup. Free hosting disables cron and automated background requests. [Provider cron policy](https://forum.infinityfree.com/t/cron-job-feature-is-now-disabled/80495/)
- A short pairing code is a temporary shared secret. Anyone who knows it can signal or clean up the session. Rate limits reduce guessing and creation bursts, but users behind one shared address may reach the same limit. A code alone does not authenticate a person. Share it privately.
- An HTML response or 403 from a hosted API client can be the provider’s browser challenge. Reopen the site normally. Keep the frontend and API on the same origin. External REST clients, webhooks and automated monitoring are unsuitable for this hosted acceptance test. [Provider browser-security guidance](https://forum.infinityfree.com/t/why-isnt-api-access-working-on-my-website/115198)
- If `/sessions` returns your homepage, verify the chosen document root and the root `.htaccess`. If the site returns 500/502, check the upload and supported directives. The package uses rewrite rules, denies, and `Options -Indexes`. It avoids custom Apache header directives. Keep the configuration denies in place. [Provider discussion of restricted directives](https://forum.infinityfree.com/t/does-we-have-any-new-rules-or-changes-towards-htaccess-file/120917)
- For a database error, check the named database in phpMyAdmin, the exact panel username and host, PDO MySQL, permissions and the private override. Keep diagnostics private. The free host’s database is intended for hosted PHP and the panel’s phpMyAdmin.
- A successful session lookup establishes only signaling. Guest Wi-Fi isolation, restrictive NATs, VPNs or firewalls can prevent WebRTC from connecting. Try the same trusted LAN. Slipstream has no TURN relay or server-hosted fallback. The free hosting service provides neither guaranteed capacity nor guaranteed availability.
