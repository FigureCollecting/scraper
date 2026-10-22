# MFC-GALLERY-2: downloading the official gallery photos (design)

Part 1 (fc-aggregation `gallery:backfill`) recorded, for every stored MFC item page, the ordered gallery as one
`galleryImages` claim: `{entries:[{position, src, w, h}]}`. Nothing was downloaded. This is the part that downloads,
through the process every other image already takes. Ross's rules (10-20): files take the NORMAL process, no shortcut;
cookie-less plain GETs of the static host; its own per-host pacing; holdings first; auto-pause on 403/429/challenge;
the deployed rate is config (desk IMGRATE, Ross: 3 files/s, `intervalMs` 333).

## Why the image lane skipped them (so the lift is deliberate)

| limit | where | effect on MFC |
| --- | --- | --- |
| role: `/upload/pictures/` is role `user` | scraper-rulesets `src/mfc/index.ts:537`, `image-tiers.ts:32`; declined at `imageRefs.ts:105` | every official picture skipped; only the `/upload/items/` plate was fetched |
| cap 12 per item | `imageCaptureHook.ts:48`, `imageRefs.ts:135` | longest holdings gallery is 100 |
| runs only after an extraction | `scrapeQueue.ts:926`, `assembleImageCapture.ts:255` | stored pages are never revisited |

## The seam: the scraper, through the SAME hook

The scraper owns the whole normal process: `createImageCaptureHook` (`imageCaptureHook.ts:310`) -> `normalizeImageRefs`
-> `chooseImageLane` (`imageHostPolicy.ts:285`) -> `paceImageBytesByHost` (`imageBytesPacing.ts:80`) -> the bytes
guards (32 MiB cap `imageBytes.ts:141`, magic-byte sniff `:285`, SVG refused `:277`; counted notImage / tooLarge /
unsupported at `imageCaptureHook.ts:501-520`) -> `CaptureSink` (content-addressed raw original, `captureSink.ts:165`,
prefix `raw-img/`) -> `ReportCapture` (`captureReporter.ts:236`) -> fc-aggregation `capture-writer.ts` (raw.blob,
raw.capture lane asset, `product_image` role/position/state `captured`) -> the media.v1 lease (`derivative-writer.ts:112`)
-> media-manager clean copy and mask -> only derivatives are served. The driver adds nothing to that chain and writes
no row itself; it only decides WHICH urls the hook is asked for, in what order, and when to stop.

```
fc-aggregation  gallery:worklist  --(JSONL on the job's volume)-->  scraper  gallery:capture
  galleryImages claims, ranked                                        driver -> hook.capture() -> sink -> ReportCapture
  holdings 0/1/2, figures 5, rest 9                                   ledger (settled urls, pause marker) on the same volume
```

The scraper must not read the spine database, so the work list is a file the operator mounts (a PVC, like
`backfill-captures-state`). It is generated read-only by `npm run gallery:worklist` (fc-aggregation).

## What changes in the scraper

1. **Per-host rate seam** (`imageHostRates.ts`). `IMAGE_HOST_RATE_JSON='{"static.myfigurecollection.net":{"intervalMs":333}}'` (Ross, IMGRATE b: 3 files/s)
   feeds the image limiter (`assembleImageCapture.ts:171`, today `new HostRateLimiter(() => undefined)`: a 2,067 ms base
   that speeds up toward 274 ms). A row pins base = min = interval, so success never speeds it up; 429/503 still back it off.
   IMGRATE is this one number. The row is REQUIRED: `gallery:capture` exits 2 (zero requests) unless every host in
   `GALLERY_ALLOWED_HOSTS` has an explicit, readable row (rows are keyed by host NAME, so a `host:port` entry uses its host's row),
   because a host with no decided rate would run at the limiter default.
2. **Host policy row** (config, `IMAGE_HOST_POLICY_JSON`): `{"static.myfigurecollection.net":{"lane":"http","egress":"direct"}}`.
   Without it an on-store host inherits MFC's declared transport (`imageHostPolicy.ts:300-303`). The http lane sends
   no cookies of its own (`httpBytesFetch.ts` header). The driver composes an http-only router, so any other lane is
   `unsupported`, and it also refuses to start unless the policy resolves every allowed host to http + direct.
3. **Gallery driver** (`galleryDriver.ts`): reads the work list in file order; skips (item, url) pairs the ledger has settled; builds one
   `ImageCaptureRequest` per item whose synthetic `describeImages` returns `{url, role:'gallery', position, sourceClass}`;
   awaits `hook.capture()` (sequential, one item at a time); observes every fetch; then waits for the raw store sink to
   FLUSH the item's puts and settles only what it confirmed (stored / gone / over the cap). The sink admits bytes to a queue
   and puts them later, so "fetched" is not "stored": a put that fails leaves the whole item unsettled (it is fetched again,
   counted in `itemsWithFailures`, exit 6). The hook's url memo is written when the sink ADMITS bytes, before the put, so a lost
   put would leave it claiming the file is at rest: the driver takes the lost item's urls out of the memo (`hook.forget`), so a later
   item that shares a picture fetches it itself instead of being told it is stored, and no depiction of a missing object is
   reported. A picture another item already got is settled for a sharing item only if THIS run saw the store confirm it; a memo hit
   nothing confirmed is a failure (unsettled, counted, fetched again next run).
   The report's `stored` is the (item, picture) pairs settled stored, i.e. confirmed; `fetched` is what was downloaded.
   **The store's own ceiling.** The sink SKIPS a body over `RAW_STORE_IMAGE_MAX_BYTES` and still calls it admitted (the Deployment
   sets 10485760; the lane's own fetch cap is 32 MiB). The Job must carry the same value (`RAW_STORE_IMAGE_MAX_BYTES`, copied from the
   Deployment; the run exits 2 without it), and a fetched body over it is settled `skipped:too_large`: counted in the report
   (`skippedTooLarge`), never reported to the spine, never asked for again.
   **A body the store will not keep.** The lane takes a declared `image/*` type verbatim; the sink does not, it sniffs the magic bytes and
   skips what is empty or not JPEG, PNG, GIF, WebP or AVIF (an HTML hotlink or soft-404 page served as `image/jpeg`, a BMP, TIFF or HEIC
   original). The observer applies the sink's own sniffer to each body, so the driver knows which file was skipped: it is settled
   `skipped:not_image` (counted in `skippedNotImage`, never reported, never asked for again, the same for a sharing item), and it counts
   toward the pause streak like a block (a host that answers this way three times in a row pauses the run; a good image resets the
   count). The sink checks empty, then size, then type, and so does the driver: an HTML body over the ceiling is `skipped:too_large`.
   A store-side skip the fetched bodies do not explain (the lane off, or more skips than there are bodies that qualify) is treated as a
   lost put.
   `IMAGE_MAX_PER_ITEM=100` for this process only. The item's `contentLevel` rides the ref (fail closed to `unknown`).
   `sourceClass` is config (`GALLERY_SOURCE_CLASS`). Ross ruled (desk GALSRC b): the MFC official gallery is `manufacturer_press`, set in the Job env below; the code default stays `unknown`, so a Job that forgets the setting claims nothing.
4. **Auto-pause**: N consecutive blocked or failed fetches (403, 429, 503, `cf-mitigated`, a 2xx that is not an image, a
   cooling host, a refused redirect, and also any 5xx, a timeout or a dropped connection) stop the run and write a pause marker
   (default 3 and 6 h); the next run refuses until it lapses or `--resume`. A success resets the streak; a 404/410 or an
   over-size body is a verdict on one file and neither counts nor resets it.
4a. **Redirects**: the runtime never follows one. The driver takes each hop by hand, over the paced fetcher (so every hop,
   a same-host one included, waits for the host's turn), and ONLY to an origin in `GALLERY_ALLOWED_HOSTS`. A hop anywhere else is
   refused before a request is sent: nothing is fetched, stored or settled from outside the list, and it counts as a blocked
   fetch. A cross-origin hop carries no Referer; more than 5 hops are refused; a hop to another scheme (`ftp:`, `ws:`) or whose
   Location carries credentials is refused, and the Location is never printed. The probe still treats any redirect as a FAIL.
   **The allow-list is per ORIGIN, scheme included.** `GALLERY_ALLOWED_HOSTS` entries are `[http://|https://]host[:port]`. A bare host is
   https on 443; `host:port` is https on that port. Cleartext has to be asked for: `http://host` (port 80) or `http://host:port`, and the run
   logs a WARNING at start naming every such entry. A bare host therefore does not follow an https -> http redirect, and another service on
   the same host name (another port) is not on the list. The rate and policy rows stay keyed by host name.
4b. **One spelling of a url**: the work list carries the canonical form (host lower-case without a trailing dot, default port
   gone, dot segments resolved, no fragment, %-escapes in one spelling) and the scraper applies it again; the ledger keys on it,
   per item: `{"i":"site/itemId","u":url,"s":stored|gone|oversize|skipped:too_large|skipped:not_image}`. (The url-only lines of the first cut are
   ignored.) The form is IDEMPOTENT: a valid `%XX` is decoded once if it spells an unreserved character, a stray `%` (not followed
   by two hex digits) is a literal percent sign and is written `%25`, and nothing is decoded twice, so `x%4%31.jpeg` (the file
   `x%41.jpeg`) never collides with `xA.jpeg`. fc-aggregation carries the same function; both suites read the same vector file
   (`src/__tests__/fixtures/galleryCanonicalVectors.json`, 62 vectors) and pin the same digest over a 4,000-url fixed-seed fuzz set.
   A gallery over 100 entries keeps the first 100 by position and reports the rest (`entriesCapped`); it is never dropped whole.
5. **Probe** (`--probe [N=20]`): the first N files of the work list through the real hook and sink, with evidence per
   request (status, type, size, header NAMES sent, set-cookie seen, cf-mitigated/cf-ray, redirect) and a verdict. PASS only if
   every request is a 200 image on the allowed origin, no cookie or authorization header was sent, no challenge signal,
   no redirect off-host, AND the store kept every file: a probe puts its files through the real sink, so a body the store skipped (not an
   image, over its ceiling) or a write it did not confirm makes the verdict FAIL. The exit code follows the printed verdict: 0 for PASS,
   5 for anything else (including a probe that tripped the pause: the marker is written and the PAUSED line printed, but the code is 5).
6. **Entry**: `npm run gallery:capture` (Job/CronJob, same image as the scraper). One meaning per exit code: 0 done (or a limit),
   1 crash, 2 bad arguments or config (no host named, no rate row for an allowed host, `RAW_STORE_IMAGE_MAX_BYTES` unset, a bad
   allow-list entry, no lock location), 3 paused (a block, a 5xx storm, or a live pause marker), 4 refused (lane off or the host policy is not plain
   http + direct), 5 probe not a PASS (a probe exits by its printed verdict: 0 or 5), 6 the raw store did not confirm some item of a real
   run (unsettled; run again), 7 stopped by SIGTERM/SIGINT
   or by losing the lock, 8 LOCKED (another run holds the lease; this one made no request).
7. **One run per host, on a lease; and SIGTERM**: the lock is `GALLERY_LOCK_PATH`, else `gallery-capture.lock` in the directory of
   `GALLERY_LEDGER_PATH`. It never follows the `--ledger` flag: with neither variable set a run (a probe included) exits 2 before any request,
   because a probe given its own `--ledger` in another directory would otherwise run beside a live run. A dry run needs no lock.
   The file holds `{token, hostname, startedAt, heartbeatAt}`; the owner refreshes `heartbeatAt` every 10 s; a lock is stale only when
   its heartbeat is older than 60 s, whoever wrote it. No pid is kept (node is PID 1 in every pod, so a pid check would call every
   dead pod's lock live). A SIGKILLed or OOM-killed run therefore leaves a lease that frees itself 60 s later: an immediate restart
   exits 8 and a Job with a `backoffLimit` simply tries again. Taking over a stale lock is serialised (a short-lived guard file; the
   holder re-reads the lock, removes it only if it is still the same stale lock, then creates its own atomically): of any number of
   runs that start together, exactly one holds. A run that finds its lock taken (it was frozen for over a minute) stops and exits 7.
   SIGTERM and SIGINT stop the run at once: the stop is checked when each request is DISPATCHED, under the pacer, so neither a later
   hop of a redirect chain nor a request already waiting for its pacing slot goes out; the run waits for the store to confirm what is
   queued, settles only that, and exits 7.

## Politeness and failure behaviour

- One request in flight, spaced by the host rate; no retries inside a run (a failed url is simply not settled and the next run
  tries it again, after the pause if one was set).
- Settled = stored AND confirmed by the sink (or the same for a picture an earlier item got, in this run), or permanently gone
  (404/410), or over the fetch cap (`oversize`), or over the store's ceiling (`skipped:too_large`), or a body the store will not keep
  (`skipped:not_image`), per (item, url). Never settled:
  403, 429, 5xx, timeouts, non-image 2xx, an off-origin redirect, a put the store did not confirm (and nothing at all when the
  process is killed first).
- A kill mid-item fetches that whole item again on the next run (up to 99 duplicate requests; by design).
- Known gap, follow-up FETCH-CAP-1 (not this PR): the 32 MiB cap limits what is stored, not what is buffered for a body with
  no Content-Length or a gzip-encoded one. Size the Job's memory limit with that in mind.
- Restart safe: the ledger is append-only JSONL; re-running the same work list fetches nothing already settled.
- Hands-off: the deployed job is the only thing that ever contacts the static host. Nothing here is run from a workstation.

## Rollout (nothing applied by this unit)

1. Merge; roll the scraper image. 2. Mount the work list and a small PVC. 3. Probe Job (`--probe 20`) -> read the verdict.
   If challenged, the fallback is the residential lane at a lower rate (a policy row, not code). 4. Holdings only
   (`--max-files` staged), then figures, then the rest. Desk IMGRATE sets `intervalMs`: Ross chose 333 = 3 files/s (holdings, 14,346 files, about 1.3 h;
   the whole catalogue, about 1.7M files, about 6.6 days).

## Derive side (not this unit, but a precondition)

media-manager's clean copy (`app/workers/mask_seed.py`, branch feat/mm-report-1) is the minimal one; the byte and pixel caps
before decode (its I8 unit) have not landed and `mask_batch.py:806` decompresses without a size cap. Land them before the
bulk run.

## Job sketch (for fc-infra; not applied by this unit)

```
# one-shot Job, scraper image, no npm in the image: node dist/...
concurrencyPolicy: Forbid            # (CronJob) never two runs; the lease in /state is the second line of defence
terminationGracePeriodSeconds: 60    # SIGTERM stops the run and drains the store's queue
args: ["node","dist/services/images/galleryCaptureCli.js","--probe","20"]      # first run
args: ["node","dist/services/images/galleryCaptureCli.js","--max-files","20000","--max-minutes","330"]   # staged real runs
env:
  PERSIST_RAW_IMAGES: "true"            # the lane must be on; the driver refuses to fetch what would be dropped
  REPORT_CAPTURES: "true"               # + INGEST_BASE_URL, RAW_STORE_S3_* exactly as the scraper Deployment has them
  IMAGE_HOST_POLICY_JSON: '{"static.myfigurecollection.net":{"lane":"http","egress":"direct"}}'
  IMAGE_HOST_RATE_JSON:   '{"static.myfigurecollection.net":{"intervalMs":333}}'      # desk IMGRATE b: 3 files/s, no speed-up; REQUIRED, the run exits 2 without it
  RAW_STORE_IMAGE_MAX_BYTES: "10485760"  # REQUIRED: the Deployment's value (the sink skips bodies over it); the run exits 2 without it
  GALLERY_LOCK_PATH: /state/gallery-capture.lock   # REQUIRED unless GALLERY_LEDGER_PATH is set: one lease for the host, whatever ledger a run is given
  GALLERY_ALLOWED_HOSTS: static.myfigurecollection.net   # REQUIRED: no host is built in (hands-off plan C1), the run exits 2 without one. [http://]host[:port]; a bare host = https on 443 only
  GALLERY_WORKLIST_PATH: /state/wl.jsonl     # from `npm run gallery:worklist` (fc-aggregation)
  GALLERY_LEDGER_PATH:   /state/ledger.jsonl
  GALLERY_SOURCE_CLASS:  manufacturer_press   # desk GALSRC b: the MFC official gallery
volumes: a small PVC at /state (the work list ~170 MB for the whole catalogue, the ledger grows ~100 bytes a file)
network: egress 443 to static.myfigurecollection.net and the raw store, plus the ingest listener, as the scraper has it
```

Operator flow: run `gallery:worklist`, copy the file to the PVC, run the probe Job and read `PROBE PASS|FAIL` (the exit code is
0 for PASS and 5 for anything else), then run staged real Jobs until the list is done. A block pauses the Job (exit 3) and writes the marker;
`--resume` clears it deliberately.
